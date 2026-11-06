// Evidence-based visual-style scoring. It intentionally evaluates invariant
// properties that can be measured from the same SVG used for preview/export,
// rather than trusting an LLM self-assessment.
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: true, trimValues: true });
const n = (v) => Number.isFinite(Number.parseFloat(v)) ? Number.parseFloat(v) : 0;
const clamp = (v) => Math.max(0, Math.min(1, v));
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const variance = (xs) => xs.length ? mean(xs.map((x) => (x - mean(xs)) ** 2)) : 0;

function scanSvg(svg) {
  const root = parser.parse(String(svg || '')).find((x) => x.svg);
  const out = { colors: [], fonts: [], texts: [], images: [] };
  const walk = (nodes) => (nodes || []).forEach((node) => {
    for (const tag of ['rect', 'circle', 'ellipse', 'path', 'polygon', 'line', 'text', 'image', 'g']) {
      if (!node[tag]) continue;
      const attr = node[':@'] || {};
      const children = node[tag];
      const fill = attr['@_fill'];
      if (fill && /^#?[0-9A-F]{6}$/i.test(fill)) out.colors.push(String(fill).replace('#', '').toUpperCase());
      if (tag === 'text') {
        out.fonts.push(String(attr['@_font-family'] || '').split(',')[0].replace(/["']/g, '').trim());
        const content = children.filter((c) => c['#text'] !== undefined).map((c) => c['#text']).join('').trim();
        out.texts.push({ x: n(attr['@_x']), y: n(attr['@_y']), size: n(attr['@_font-size']), text: content, font: out.fonts[out.fonts.length - 1] });
      }
      if (tag === 'image') out.images.push({ x: n(attr['@_x']), y: n(attr['@_y']), w: n(attr['@_width']), h: n(attr['@_height']) });
      if (tag === 'g') walk(children);
    }
  });
  walk(root?.svg || []);
  return out;
}

function closestTitle(slide, role = slide.role) {
  // Body callouts (for example a large quotation mark) are not page titles.
  // Content titles live in the measured top bar, so constrain the candidate
  // set to that band before comparing typography and geometry.
  const candidates = role === 'content'
    ? slide.texts.filter((x) => x.y <= 190)
    : slide.texts;
  return [...(candidates.length ? candidates : slide.texts)].sort((a, b) => b.size - a.size)[0] || null;
}
function roleScore(slide, role, profile) {
  const target = profile?.roles?.[role];
  if (!target) return 0.6;
  // 模板该角色是否带烘焙素材：带了就必须有图（image 维度计分），没带则此项不计缺陷。
  const expectsBaked = Boolean(target.asset);
  const imageScore = expectsBaked ? (slide.images.length ? 1 : 0) : 1;
  const slot = role === 'content' ? target.slot : (target.slots?.title || target.slots?.quote);
  if (!slot) return imageScore;
  const title = closestTitle(slide, role);
  if (!title) return imageScore * 0.3;
  const scale = 1280 / profile.canvas.width;
  const tx = (slot.rect[0] + (slot.align === 'center' ? slot.rect[2] / 2 : slot.align === 'right' ? slot.rect[2] : 0)) * scale;
  const ty = (slot.rect[1] + Math.min(slot.rect[3], slot.size / 72)) * scale;
  const d = Math.hypot((title.x - tx) / 1280, (title.y - ty) / 720);
  return 0.55 * imageScore + 0.45 * clamp(1 - d * 4.4);
}

function scoreDeck({ profile, slides }) {
  const scanned = (slides || []).map((slide) => ({ role: slide.role || 'content', ...scanSvg(slide.svg) }));
  const expectedColors = new Set((profile?.invariants?.palette || []).map((x) => x.hex));
  const expectedFonts = (profile?.invariants?.fonts || []).map((x) => String(x).toLowerCase());
  const perSlide = scanned.map((s, index) => {
    const usableColors = s.colors.filter(Boolean);
    const palette = usableColors.length ? mean(usableColors.map((c) => expectedColors.has(c) ? 1 : 0)) : 0;
    const usableFonts = s.fonts.filter(Boolean);
    const typography = usableFonts.length ? mean(usableFonts.map((f) => expectedFonts.some((e) => f.toLowerCase().includes(e) || e.includes(f.toLowerCase())) ? 1 : 0)) : 0;
    const role = roleScore(s, s.role, profile);
    const image = profile?.roles?.[s.role]?.asset ? (s.images.length ? 1 : 0) : 0.8;
    const score = 100 * (0.30 * palette + 0.22 * typography + 0.33 * role + 0.15 * image);
    return { index, role: s.role, score: Math.round(score * 10) / 10, palette: Math.round(palette * 100), typography: Math.round(typography * 100), roleFit: Math.round(role * 100), image: Math.round(image * 100) };
  });
  const contents = scanned.filter((s) => s.role === 'content');
    const titles = contents.map((slide) => closestTitle(slide, 'content')).filter(Boolean);
  const consistency = titles.length < 2 ? 1 : clamp(1 - (variance(titles.map((x) => x.x / 1280)) * 30 + variance(titles.map((x) => x.y / 720)) * 30 + variance(titles.map((x) => x.size / 100)) * 8));
  const average = mean(perSlide.map((x) => x.score));
  const overall = Math.round((average * 0.88 + consistency * 12) * 10) / 10;
  return {
    version: 1,
    score: overall,
    threshold: 85,
    pass: overall >= 85,
    dimensions: { averageSlide: Math.round(average * 10) / 10, contentConsistency: Math.round(consistency * 1000) / 10 },
    perSlide,
  };
}

module.exports = { scoreDeck, scanSvg };
