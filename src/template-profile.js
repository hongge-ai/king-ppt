// Generic reference-template profile. A profile contains only measured facts
// from the source deck plus the baked assets; it contains no sample-specific
// palette or coordinate constants.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');
const { parseSourcePages } = require('./pptx-pages');
const { bakeTemplateAssets, bakeScrim } = require('./bake');
const pngSample = require('./png-sample');

const textOf = (page) => (page.objects || [])
  .filter((o) => o.type === 'shape' && o.texts && o.texts.length)
  .map((o) => ({
    rect: o.bbox,
    runs: o.texts.flatMap((p) => p.runs || []),
    text: o.texts.flatMap((p) => (p.runs || []).map((r) => r.text)).join(''),
  }));
const topFont = (items) => {
  const count = {};
  items.flatMap((x) => x.runs || []).map((r) => r.font).filter(Boolean).forEach((f) => { count[f] = (count[f] || 0) + 1; });
  return Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
};
const colorsOf = (pages) => {
  const count = {};
  pages.flatMap((p) => p.objects || []).forEach((o) => {
    const c = o.fill && o.fill.color;
    if (c) count[c] = (count[c] || 0) + 1;
    (o.texts || []).flatMap((t) => t.runs || []).map((r) => r.color).filter(Boolean).forEach((x) => { count[x] = (count[x] || 0) + 1; });
  });
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([hex, uses]) => ({ hex, uses }));
};
const lum = (hex) => {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9A-F]{6}$/i.test(h)) return 0.5;
  return (0.2126 * parseInt(h.slice(0, 2), 16) + 0.7152 * parseInt(h.slice(2, 4), 16) + 0.0722 * parseInt(h.slice(4, 6), 16)) / 255;
};
const saturation = (hex) => {
  const h = String(hex || '').replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return Math.max(...rgb) - Math.min(...rgb);
};
const contrast = (a, b) => Math.abs(lum(a) - lum(b));
const mix = (a, b, t) => {
  const ch = (h) => [0, 2, 4].map((i) => parseInt(String(h).replace('#', '').slice(i, i + 2), 16));
  const [pa, pb] = [ch(a), ch(b)];
  return pa.map((v, i) => Math.round(v * (1 - t) + pb[i] * t).toString(16).padStart(2, '0')).join('').toUpperCase();
};

// Derive a contrast-correct, generic token set from the measured palette.
// 认领次序是关键：①强调色（品牌身份色）→②ink→③muted/panel（中性阶）。
// 旧版反着来（先 muted 后 accent），低饱和单色系模板的品牌色会被 muted 的
// 灰阶闸门抢走。 Works for dark and light source decks — no sample constants.
const isNeutralish = (hex) => saturation(hex) < 0.045;
const hueOf = (hex) => {
  const h = String(hex).replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return -1;
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  return ((hue * 60) + 360) % 360;
};
const hueDist = (a, b) => {
  const ha = hueOf(a), hb = hueOf(b);
  if (ha < 0 || hb < 0) return 999;
  return Math.min(Math.abs(ha - hb), 360 - Math.abs(ha - hb));
};
function deriveTokens(palette, bg, roles) {
  const isDark = lum(bg) < 0.5;
  // ① 强调色：非中性的品牌色按"饱和度×出现量"排序，同色系（色相差<35°）
  // 只保留最强的一个；低饱和单色系设计在此自然胜出，而非被过滤后落到兜底蓝。
  const chromatic = palette
    .filter((p) => p.hex !== bg && !isNeutralish(p.hex))
    .sort((a, b) => saturation(b.hex) * Math.sqrt(b.uses || 1) - saturation(a.hex) * Math.sqrt(a.uses || 1));
  const used = new Set([bg]);
  const accents = [];
  for (const p of chromatic) {
    if (used.has(p.hex)) continue;
    if (accents.some((h) => hueDist(h, p.hex) < 35)) continue;
    accents.push(p.hex);
    used.add(p.hex);
    if (accents.length >= 3) break;
  }
  // ② 主文字
  const measuredTitle = roles.content?.slot?.color || roles.cover?.slots?.title?.color;
  let ink = measuredTitle && contrast(measuredTitle, bg) > 0.45 ? measuredTitle : null;
  if (!ink || used.has(ink)) {
    ink = palette.filter((p) => !used.has(p.hex) && contrast(p.hex, bg) > 0.5 && (isDark ? lum(p.hex) > 0.55 : lum(p.hex) < 0.4))
      .sort((a, b) => b.uses - a.uses)[0]?.hex || (isDark ? 'F1F5F9' : '111827');
  }
  used.add(ink);
  // ③ 次级文字 / 卡片面：中性阶优先，绝不占用品牌强调色
  const muted = palette.filter((p) => !used.has(p.hex) && isNeutralish(p.hex)
    && contrast(p.hex, bg) > 0.16 && contrast(p.hex, bg) < contrast(ink, bg))
    .sort((a, b) => b.uses - a.uses)[0]?.hex || mix(ink, bg, 0.45);
  used.add(muted);
  const panel = palette.filter((p) => !used.has(p.hex) && contrast(p.hex, bg) <= 0.16 && contrast(p.hex, ink) > 0.4)
    .sort((a, b) => b.uses - a.uses)[0]?.hex || mix(bg, ink, isDark ? 0.09 : 0.06);
  // 真正无彩色的模板：强调色从墨-底中导出（近灰阶标记），绝不发明外来色相
  const accent = accents[0] || mix(ink, bg, isDark ? 0.32 : 0.55);
  return { bg, ink, muted, panel, accent, accent2: accents[1] || accent, accent3: accents[2] || accents[1] || accent, isDark };
}

// A generation-time art-direction hint for cover/section imagery, derived from
// the template's own palette mood so new-topic illustrations match its style
// (not a hardcoded warm-paper look). The subject/topic is added by the caller.
function imageStyleHint(tokens) {
  return tokens.isDark
    ? 'cinematic dark editorial illustration, deep navy background, volumetric lighting, subtle glowing accents, high detail, photographic depth, no text, no logos'
    : 'clean bright editorial illustration, airy background, soft natural light, refined minimal composition, generous negative space, no text, no logos';
}
function pageBackground(page, canvas) {
  if (page?.background?.color) return page.background.color;
  const full = (page?.objects || []).filter((o) => o.type === 'shape' && o.fill?.color && o.bbox
    && o.bbox[2] * o.bbox[3] >= canvas.width * canvas.height * 0.7)
    .sort((a, b) => b.bbox[2] * b.bbox[3] - a.bbox[2] * a.bbox[3])[0];
  return full?.fill?.color || null;
}

async function themeFonts(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file('ppt/theme/theme1.xml');
  if (!entry) return { title: 'Microsoft YaHei', body: 'Microsoft YaHei' };
  const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true });
  const scheme = xml.parse(await entry.async('text')).theme?.themeElements?.fontScheme || {};
  const pick = (node) => node?.ea?.['@_typeface'] || node?.latin?.['@_typeface'] || 'Microsoft YaHei';
  return { title: pick(scheme.majorFont), body: pick(scheme.minorFont) };
}

function contentMetrics(page, canvas) {
  const texts = textOf(page);
  const titles = texts.filter((x) => x.rect && x.rect[1] < canvas.height * 0.27)
    .sort((a, b) => Math.max(...b.runs.map((r) => r.size || 0)) - Math.max(...a.runs.map((r) => r.size || 0)));
  const body = texts.filter((x) => x.rect && x.rect[1] >= canvas.height * 0.18 && x.rect[1] < canvas.height * 0.86);
  const images = (page.objects || []).filter((o) => o.type === 'image' && o.bbox);
  return {
    title: titles[0] ? { rect: titles[0].rect, font: topFont([titles[0]]), size: Math.max(...titles[0].runs.map((r) => r.size || 0)) } : null,
    bodyRects: body.slice(0, 12).map((x) => x.rect),
    imageRects: images.map((x) => x.bbox),
  };
}

async function profileFromPptx(buffer, { stagingDir } = {}) {
  if (!stagingDir) throw new Error('模板画像需要 stagingDir');
  const mediaDir = path.join(stagingDir, '.media');
  const parsed = await parseSourcePages(buffer, { mediaDir });
  const baked = await bakeTemplateAssets(buffer, { stagingDir });
  const fonts = await themeFonts(buffer);
  const roles = {};
  for (const role of ['cover', 'section', 'closing']) {
    if (baked[role]) roles[role] = { ...baked[role], asset: `assets/${baked[role].file}` };
  }
  if (baked.topbar) {
    roles.content = {
      ...baked.topbar,
      asset: `assets/${baked.topbar.file}`,
      bodyRect: [0.85, baked.topbar.hIn + 0.3, parsed.canvas.width - 1.7, parsed.canvas.height - baked.topbar.hIn - 1.0],
    };
  }
  const families = parsed.pages.map((page, i) => ({
    id: `source-${i + 1}`,
    sourcePage: i,
    kind: roles.cover?.sourcePage === i ? 'cover' : roles.section?.sourcePage === i ? 'section' : roles.closing?.sourcePage === i ? 'closing' : 'content',
    metrics: contentMetrics(page, parsed.canvas),
  }));
  const palette = colorsOf(parsed.pages);
  const contentPage = parsed.pages[baked.topbar?.sourcePage || 0];
  const bg = pageBackground(contentPage, parsed.canvas)
    || palette.find((x) => lum(x.hex) > 0.82)?.hex
    || palette[palette.length - 1]?.hex || 'FFFFFF';
  const tokens = deriveTokens(palette, bg, roles);
  const profile = {
    version: 1,
    canvas: parsed.canvas,
    sourceSlideCount: parsed.pages.length,
    roles,
    families,
    invariants: {
      palette,
      fonts: [fonts.title, fonts.body, ...parsed.pages.flatMap((p) => topFont(textOf(p))).filter((f) => !String(f).startsWith('+'))].filter((f, i, a) => a.indexOf(f) === i),
      fontFamilies: fonts,
      titleRects: families.map((f) => f.metrics.title && f.metrics.title.rect).filter(Boolean),
      contentTitleRect: roles.content?.slot?.rect || null,
    },
    tokens,
    imageStyle: imageStyleHint(tokens),
    extraction: { mode: 'baked-reference', confidence: roles.cover && roles.content ? 0.92 : 0.68 },
  };
  // Smooth gradient overlay mask (transparent -> bg) for cover/section imagery.
  // 渐隐目标取"封面文字带以下区域自己的平均色"，而不是全局 bg：遮罩的语义是
  // 让画面向其所在环境的基调自然过渡。纯灰/纯彩封面若被渐隐到全局白底，
  // 会把整页洗成半透明渐变（实测三伏贴灰底封面被冲成白雾）。
  let scrimTarget = tokens.bg;
  try {
    const coverAsset = roles.cover?.asset && path.join(stagingDir, roles.cover.asset);
    if (coverAsset && fs.existsSync(coverAsset)) {
      const img = pngSample.decode(fs.readFileSync(coverAsset));
      const pts = [];
      for (let y = Math.floor(img.h * 0.62); y < img.h; y += 4) {
        for (let x = Math.floor(img.w * 0.15); x < img.w * 0.85; x += 8) {
          const p = pngSample.pxAt(img, x, y);
          pts.push(p);
        }
      }
      if (pts.length) {
        const avg = [0, 1, 2].map((i) => Math.round(pts.reduce((s, p) => s + p[i], 0) / pts.length));
        scrimTarget = '#' + avg.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
      }
    }
  } catch { /* 采样失败则退回全局 bg */ }
  try { profile.scrim = await bakeScrim(stagingDir, scrimTarget); } catch { profile.scrim = null; }
  fs.writeFileSync(path.join(stagingDir, 'template-profile.json'), JSON.stringify(profile, null, 2));
  return profile;
}

function loadTemplateProfile(dir) {
  const file = path.join(dir, 'template-profile.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

module.exports = { profileFromPptx, loadTemplateProfile, contentMetrics, themeFonts, deriveTokens };
