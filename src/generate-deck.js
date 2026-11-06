// 阶段2：按模板 styleModel + 定稿大纲，逐页生成整页 SVG。
// 已实现的版式家族由 template-renderer 确定性绘制；未实现的家族才走本模块的模型生成，
// 且模型必须服从同一份 styleModel 与编译器能力契约——两条路径共享设计依据。
const path = require('path');
const llm = require('./llm');
const { deriveTitle } = require('./normalize-outline');
const llmprovider = require('./llmprovider');
const { contractText } = require('./compiler-contract');
const { tokensText } = require('./spec');
const assets = require('./assets');
const htmlShot = require('./html-shot');
const fs = require('fs');

// Center-crop an image data URI to the deck aspect (default 16:9) so a square
// AI illustration fills a wide slide without distortion. pptxgenjs stretches
// data-URI images to the frame (its sizing:cover can't read their intrinsic
// size), so the crop must happen on the bytes — here, deterministically via the
// same headless browser used for baking. Falls back to the original on failure.
async function coverCropDataUri(dataUri, w = 1280, h = 720) {
  try {
    const html = `<img src="${dataUri}" style="display:block;width:${w}px;height:${h}px;object-fit:cover;object-position:center">`;
    const png = await htmlShot.renderToPng(html, { width: w, height: h, scale: 1 });
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch { return dataUri; }
}

// 模块级 in-flight 锁：整册生成与单页重画共用一把，禁止并发（双击 / 生成中再点）。
let inflight = false;
function acquire() {
  if (inflight) { const e = new Error('上一次生成尚未结束，请稍候'); e.code = 'BUSY'; throw e; }
  inflight = true;
}
function release() { inflight = false; }

function imageEnabledFor(policy, role, index) {
  if (!policy || policy.enabled === false) return false;
  // Cover and divider imagery is part of the template language. Do not use
  // the page-index cap for those roles; it skipped later chapter art.
  if (role === 'content' && Number(policy.maxPerDeck) >= 0 && index >= Number(policy.maxPerDeck)) return false;
  const roles = Array.isArray(policy.roles) && policy.roles.length ? policy.roles : ['cover', 'section'];
  if (!roles.includes(role)) return false;
  if (role === 'content' && Number(policy.contentEvery) > 1 && index % Number(policy.contentEvery) !== 0) return false;
  return Boolean(llmprovider.listActive().image);
}

async function addGeneratedImage(svg, { role, index, docTitle, section, policy }) {
  if (!svg || !imageEnabledFor(policy, role, index)) return svg;
  const hint = policy.prompt || 'editorial paper collage, warm natural light, hand-cut shapes, no words or lettering';
  const prompt = [
    `Create a single presentation illustration for the topic: ${docTitle || 'the presentation'}.`,
    `This slide is about: ${section.heading}.`,
    `Visual direction: ${hint}.`,
    role === 'section'
      ? 'Make this a wide chapter-divider illustration with the focal subject on the upper right and calm negative space in the lower left for the chapter number and title.'
      : role === 'cover'
        ? 'Make this a wide cover illustration with the subject grouped on the right and generous calm negative space on the left for the title.'
        : '',
    'Use a clean subject with generous negative space, no logos, no UI screenshots, no readable text.',
  ].join(' ');
  try {
    const result = await llm.generateImage(prompt, { size: policy.size || '1024x1024' });
    let saved;
    if (result.b64) saved = assets.saveImageBase64(result.b64, 'png');
    else if (result.url) saved = await assets.saveImageFromUrl(result.url);
    if (!saved || !fs.existsSync(saved.path)) return svg;
    const ext = saved.file.split('.').pop().toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    const data = `data:${mime};base64,${fs.readFileSync(saved.path).toString('base64')}`;
    const p = policy.placement || {};
    const x = Number(p.x ?? 900), y = Number(p.y ?? 130), w = Number(p.w ?? 290), h = Number(p.h ?? 450);
    const frame = String(policy.frame || '#E2703A');
    const image = `<rect x="${x - 10}" y="${y - 10}" width="${w + 20}" height="${h + 20}" rx="24" fill="${frame}" fill-opacity="0.18"/><image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice" href="${data}"/>`;
    // 放在第一个文本节点前，始终保持插画在文字下层。
    const firstText = svg.search(/<text\b/i);
    return firstText >= 0 ? `${svg.slice(0, firstText)}${image}${svg.slice(firstText)}` : svg.replace(/<\/svg>\s*$/i, `${image}</svg>`);
  } catch {
    // 生图是增强能力；未配置或上游失败时不影响整册 SVG 出片。
    return svg;
  }
}

// Same image policy, but returns an inline data URI for the deterministic
// template renderer. Keeping image generation separate prevents it from
// changing layout or inserting an image into the wrong frame.
// `brief` 是该页专属的视觉概念（来自 deckImageBriefs）；有它时以它为主、
// 模板整体艺术方向（policy.prompt）退为风格锚点，插画才能「每章各表」。
async function generateSlideImage({ role, index, docTitle, section, policy, brief }) {
  if (!imageEnabledFor(policy, role, index)) return null;
  const hint = policy.prompt || 'editorial paper collage, warm natural light, hand-cut shapes, no words or lettering';
  const concept = brief || (section ? `This slide is about: ${section.heading}.` : '');
  const prompt = [
    `Create a single presentation illustration for the topic: ${docTitle || 'the presentation'}.`,
    concept,
    `Shared art direction (keep consistent across the deck): ${hint}.`,
    role === 'section'
      ? 'Make this a wide chapter-divider illustration with the focal subject on the upper right and calm negative space in the lower left for the chapter number and title.'
      : role === 'cover'
        ? 'Make this a wide cover illustration with the subject grouped on the right and generous calm negative space on the left for the title.'
        : role === 'closing'
          ? 'Make this a calm wide closing illustration with generous soft space in the upper half for a short farewell line.'
          : '',
    'Vary the subject, camera angle and dominant prop from any other chapter so each divider is unmistakably its own scene.',
    'Use a clean subject with generous negative space, no logos, no UI, no readable text.',
  ].filter(Boolean).join(' ');
  try {
    const result = await llm.generateImage(prompt, { size: policy.size || '1024x1024' });
    let saved;
    if (result.b64) saved = assets.saveImageBase64(result.b64, 'png');
    else if (result.url) saved = await assets.saveImageFromUrl(result.url);
    if (!saved || !fs.existsSync(saved.path)) return null;
    const ext = saved.file.split('.').pop().toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
    const raw = `data:${mime};base64,${fs.readFileSync(saved.path).toString('base64')}`;
    // Cover/section art is placed full-bleed into the 16:9 canvas; crop to that
    // aspect so it is not stretched on export (preview == export).
    return await coverCropDataUri(raw, 1280, 720);
  } catch { return null; }
}

// Reasoning models inline a <think>…</think> monologue and sometimes draft the
// whole answer inside it, spending the token budget before emitting anything
// after </think>. Extract robustly: (1) prefer text after the last </think>;
// (2) if that's empty (answer trapped in reasoning / truncated), salvage the
// best drafted line — preferring one that ends with the mandated suffix.
function pickArtLine(s, preferSuffix) {
  const lines = String(s || '').split('\n').map((x) => x.trim()).filter((x) => x
    && !/^(art\s*direction|here'?s|sure[,!]?|output|prompt|draft|motifs?|style|lighting|mood|colou?rs?|let me|i (need|should|will|'?ll)|that'?s|the user|first[,:]|note[:：])/i.test(x)
    && !/^[-*\d.]/.test(x) && !/[:：]$/.test(x));
  const suffixed = lines.filter((x) => /(16:9\s*wide|no\s+ui)\b/i.test(x));
  const pool = preferSuffix && suffixed.length ? suffixed : lines;
  const best = (pool.sort((a, b) => b.length - a.length)[0] || '')
    .replace(/^(art\s*direction|prompt)\s*[:：]\s*/i, '').replace(/^["'“”\-\s]+|["'“”\s]+$/g, '').trim();
  return best.length >= 20 ? best.slice(0, 400) : '';
}
function cleanArtDirection(raw) {
  const text = String(raw || '');
  const lastClose = text.toLowerCase().lastIndexOf('</think>');
  const after = (lastClose >= 0 ? text.slice(lastClose + 8) : text).replace(/```[a-z]*/gi, ' ');
  return pickArtLine(after, false) || pickArtLine(text.replace(/<\/?think>/gi, '\n'), true);
}

// One art-direction line per deck, written by the text model from the deck's
// own topic + outline + the template palette, then reused for every generated
// cover/divider illustration so they read as one consistent set. This replaces
// the static, topic-agnostic per-template imageStyle hint with a brief that
// actually matches what the user is presenting. Cached by deck key so a
// single-slide redraw reuses the same brief; falls back to the template's
// imageStyle (or a neutral default) if the model call fails — imagery is an
// enhancement and must never block deck generation.
const _artDirCache = new Map();
async function deckArtDirection({ docTitle, sections, profile, cacheKey } = {}) {
  const fallback = (profile && profile.imageStyle)
    || 'clean editorial illustration, soft natural light, generous negative space, no text, no logos, no UI, 16:9 wide';
  if (cacheKey && _artDirCache.has(cacheKey)) return _artDirCache.get(cacheKey);
  const headings = (sections || []).map((s) => s && s.heading).filter(Boolean).slice(0, 12);
  const t = (profile && profile.tokens) || {};
  const mood = t.isDark ? 'dark, moody, cinematic' : 'light, airy, bright';
  const palette = [t.bg && `background #${t.bg}`, t.ink && `ink #${t.ink}`, t.accent && `accent #${t.accent}`, t.muted && `secondary #${t.muted}`]
    .filter(Boolean).join(', ');
  const system = [
    'You are the art director for one presentation deck. Output ONE line (max ~55 words) of image-generation art direction that will be reused for every cover and chapter-divider illustration in this deck, so they form a single consistent set.',
    'Requirements: (1) name concrete visual subjects/motifs inferred from the deck topic and outline; (2) specify an illustration style plus lighting and mood; (3) weave the given brand colors in as descriptive color language, not hex codes; (4) demand generous empty negative space for overlaid title text; (5) end with exactly: no text, no logos, no UI, 16:9 wide.',
    'Respond with ONLY that single line — no reasoning, no <think> tags, no preamble, no quotes, no explanation.',
  ].join(' ');
  const user = `Deck topic: ${docTitle || '(untitled)'}\nOutline sections: ${headings.join(' / ') || '(none)'}\nBrand palette (${mood}): ${palette || 'muted, professional'}`;
  let out = fallback;
  try {
    const raw = await llm.chat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: 0.6, maxTokens: 1200 }, // headroom so reasoning models finish <think> before the line
    );
    out = cleanArtDirection(raw) || fallback;
  } catch { /* keep fallback */ }
  if (cacheKey) {
    _artDirCache.set(cacheKey, out);
    if (_artDirCache.size > 64) _artDirCache.delete(_artDirCache.keys().next().value);
  }
  return out;
}

// 每页专属的插画视觉概念（母题/构图/道具）：让「第一章 春种」和「第二章 一饭」
// 各自的画面真正不同，而全册仍共享 deckArtDirection 那一条风格锚点。
// 一次 chat 调用批量产出；失败时回退为「标题 + 章节导语」的确定性母题行——
// 生图是增强能力，绝不阻塞出片。按 cacheKey 缓存，单页重画也拿到同一份 brief。
function fallbackImageBrief(section) {
  const lead = String(section?.body || '').split('\n').find((l) => l.trim().startsWith('>'));
  const motif = [section?.heading, lead ? lead.replace(/^\s*>\s*/, '').trim() : ''].filter(Boolean).join(' —— ');
  return motif.slice(0, 90);
}
const _briefCache = new Map();
async function deckImageBriefs({ docTitle, sections, cacheKey } = {}) {
  const briefs = (sections || []).map((s) => (s && ['cover', 'section', 'closing'].includes(s.role) ? fallbackImageBrief(s) : null));
  if (!briefs.some(Boolean)) return briefs;
  if (cacheKey && _briefCache.has(cacheKey)) return _briefCache.get(cacheKey);
  try {
    const list = sections
      .map((s, i) => (briefs[i] ? `${i + 1}. [${s.role}] ${s.heading}` : null))
      .filter(Boolean)
      .join('\n');
    const system = [
      'You are an art director briefing one illustration per key slide of a single presentation deck.',
      'For EVERY numbered slide below, write ONE line (max ~30 words) describing its unique visual concept:',
      'a concrete subject/motif that matches that slide\'s own meaning (its 立意), the dominant prop or scene element, lighting/mood word.',
      'The concepts must be clearly DIFFERENT from each other (different subject, different camera angle, different dominant prop)',
      'while staying in the same visual world of the deck topic. No hex colors, no text in image, no logos, no UI.',
      'Respond with ONLY one line per slide in the exact format `N. concept` — same order, no extra lines, no reasoning.',
    ].join(' ');
    const user = `Deck topic: ${docTitle || '(untitled)'}\nSlides:\n${list}`;
    const raw = await llm.chat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: 0.6, maxTokens: 1200 },
    );
    const text = String(raw || '');
    const lastClose = text.toLowerCase().lastIndexOf('</think>');
    const body = lastClose >= 0 ? text.slice(lastClose + 8) : text;
    const got = {};
    for (const m of body.matchAll(/^\s*(\d+)\s*[.、:：|]\s*(.{10,}?)[，,]?\s*$/gm)) got[Number(m[1])] = m[2].trim();
    let hits = 0;
    sections.forEach((s, i) => {
      const c = got[i + 1];
      if (c && briefs[i]) { briefs[i] = c.slice(0, 220); hits++; }
    });
    if (!hits) throw new Error('no briefs parsed');
  } catch { /* keep deterministic fallbacks */ }
  if (cacheKey) {
    _briefCache.set(cacheKey, briefs);
    if (_briefCache.size > 64) _briefCache.delete(_briefCache.keys().next().value);
  }
  return briefs;
}

// 提示词与能力契约均按需读取并缓存：提示词是版本管理的静态资产（src/prompts/），
// 能力契约由编译器源码事实生成（src/compiler-contract.js），都不在此处手写。
const _promptCache = new Map();
function promptFile(name) {
  if (!_promptCache.has(name)) {
    _promptCache.set(name, fs.readFileSync(path.join(__dirname, 'prompts', name), 'utf8'));
  }
  return _promptCache.get(name);
}

// 本页相关的 styleModel 切片：只给该家族、该角色与全局锁定项，避免每页重复整套参考规范。
function styleSlice(styleModel, plan) {
  if (!styleModel) return null;
  const pickFamily = (fams) => (fams || []).filter(Boolean).map((f) => ({
    ...f,
    variants: (f.variants || []).filter((v) => !plan || !plan.variantId || v.id === plan.variantId || (f.variants || []).length === 1),
  }));
  return {
    schemaVersion: styleModel.schemaVersion,
    tokens: styleModel.tokens || null,
    fingerprints: styleModel.fingerprints || null,
    families: pickFamily((styleModel.families || []).filter((f) => !plan || !plan.familyId || f.id === plan.familyId)),
    components: styleModel.components || null,
    imageStyle: styleModel.imageStyle || null,
    exportRisks: styleModel.exportRisks || null,
    unknowns: styleModel.unknowns || null,
  };
}

// 确定性切页：# → 文档标题；每个 ## 连同其下正文 = 一页。无状态、同输入同切分，
// 故单页重画时重切取第 index 段即可，页序稳定可复现。
function splitOutline(markdown) {
  const md = String(markdown || '');
  const title = deriveTitle(md);
  const sections = [];
  const introLines = []; // 首个 ## 之前的引言（# 标题下的 > / - 行）——是天然的封面文案
  let cur = null;
  for (const line of md.split('\n')) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      if (cur) sections.push(cur);
      cur = { heading: h2[1].trim(), bodyLines: [] };
    } else if (cur) {
      cur.bodyLines.push(line);
    } else if (line.trim() && !/^#\s/.test(line)) {
      introLines.push(line);
    }
    // 首个 ## 之前的内容（# 标题 / 引言）仅用于 deriveTitle，不单独成页
  }
  if (cur) sections.push(cur);

  const total = sections.length;
  const isSectionHeading = (heading, body) => {
    const h = String(heading || '').trim();
    const short = String(body || '').replace(/\s+/g, '').length <= 65;
    return short && /^(第[一二三四五六七八九十百\d]+[章节]|[一二三四五六七八九十]+、|0?\d+[.、\s]|chapter\s+\d+)/i.test(h);
  };
  const isClosingHeading = (heading) => /(谢谢|感谢|致谢|结语|结尾|收尾|总结|尾声|结束|行动|倡议|寄语|致敬|takeaway|closing|thank\s*you)/i.test(String(heading || '').trim());
  const itemCount = (body) => String(body || '').split('\n')
    .map((x) => x.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter((x) => x && !x.startsWith('>')).length;
  // 首个 ## 是否配当封面：只有「薄」的首节（无条目或仅一条）才当封面。
  // 带 2 条以上条目的首节是正文页——把它当封面，条目会在封面版式里被丢弃，
  // 而这正是 generate-slide 契约禁止的静默丢内容。这种情况改为补一张合成封面。
  const firstBody = sections.length ? sections[0].bodyLines.join('\n') : '';
  const firstIsThin = itemCount(firstBody) <= 1;
  const pages = sections.map((s, i) => {
    const body = s.bodyLines.join('\n').trim();
    // 章节标题优先判 section：带「第N章/一、」编号的页绝不是收尾页（防「第三章：总结与展望」被吞成 closing）
    const role = (total <= 1 || i === 0)
      ? (firstIsThin ? 'cover' : 'content')
      : isSectionHeading(s.heading, body) ? 'section'
        : isClosingHeading(s.heading) ? 'closing' : 'content';
    return { heading: s.heading, body, raw: `## ${s.heading}\n${body}`.trim(), role };
  });

  // 首节是正文页时，用文档标题合成封面，保证整册仍有封面且正文一页不少
  if (pages.length && !firstIsThin) {
    pages.unshift({
      heading: title || '演示文稿',
      body: '',
      raw: `# ${title || ''}`.trim(),
      role: 'cover',
    });
  }

  // Chapter numbers are semantic, not page indexes. A cover and content pages
  // must never turn a later divider into "04" just because it is page four.
  // 章号优先取标题自带的「第N章」（大纲没有独立封面节时，第一个 ## 会被当封面，
  // 计数器会错位——「第二章」绝不能显示成 CHAPTER 01）。
  const cnDigit = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const cnChapterNo = (heading) => {
    const m = String(heading || '').match(/^\s*第\s*([0-9一二三四五六七八九十]+)\s*[章节]/);
    if (!m) return null;
    const s = m[1];
    if (/^\d+$/.test(s)) return Number(s);
    if (s === '十') return 10;
    const t10 = s.match(/^十([一二三四五六七八九])$/); if (t10) return 10 + cnDigit[t10[1]];
    const t1 = s.match(/^([一二三四五六七八九])十$/); if (t1) return cnDigit[t1[1]] * 10;
    const t2 = s.match(/^([一二三四五六七八九])十([一二三四五六七八九])$/); if (t2) return cnDigit[t2[1]] * 10 + cnDigit[t2[2]];
    return cnDigit[s] ?? null;
  };
  let chapterNo = 0;
  pages.forEach((page) => {
    if (page.role === 'section') {
      const n = cnChapterNo(page.heading);
      chapterNo = Math.max(chapterNo + 1, n || 0);
      page.sectionNo = String(n || chapterNo).padStart(2, '0');
    }
  });

  // Carry the current chapter onto its content pages, so a content footer can
  // show the section identifier the source deck keeps in its page chrome.
  let chapter = null;
  pages.forEach((page) => {
    if (page.role === 'section') {
      chapter = { no: page.sectionNo, title: String(page.heading).replace(/^第[一二三四五六七八九十百\d]+[章节]\s*[:：]?\s*/, '') };
    } else if (page.role === 'content' && chapter) {
      page.chapter = chapter;
    }
  });

  // 封面文案优先用 # 标题下的引言行（副题 / 一句话主旨），其次才是封面节自己的正文
  if (pages.length && introLines.length) {
    pages[0].intro = introLines.map((l) => l.replace(/^\s*[-*>\s]+/, '').trim()).filter(Boolean).slice(0, 3);
  }

  // 大纲无任何 ## 时兜底为单张封面页，避免出片阶段空册
  if (pages.length === 0) {
    pages.push({ heading: title || '演示文稿', body: '', raw: md.trim(), role: 'cover' });
  }
  return { title, sections: pages };
}
// 生成一页 SVG（裸字符串，未归一）。运行期错误（网络/超时）抛给路由；模型未产出 SVG 时
// 返回 ''——由路由经 normalizeSlide 归一为坏页（BLANK + _recovered），可事后单页重画。
//
// 设计依据全部来自 styleModel + pagePlan + compilerContract，不再使用硬编码的角色版式话术：
//   - 有参考页图时走 chatVision，让模型看着真实模板页画（证据优先于合成原型）；
//   - 没有参考页时回退到合成原型，并显式标注 source:'synth'，不冒充模板证据。
async function generateSlideSvg({ docTitle, section, role, index, total, spec, theme, feedback, styleModel, plan, referenceImages, previousSvg }) {
  const sliced = styleSlice(styleModel, plan);
  const proto = (spec.layouts || []).find((l) => l.role === role);
  const protoSource = referenceImages && referenceImages.length ? 'reference'
    : (proto ? (proto.source === 'file' ? 'reference-file' : 'synth') : 'none');

  const styleBlock = sliced
    ? '## styleModel（本次锁定的风格画像，按家族切片）\n' + JSON.stringify(sliced, null, 1)
    : '## styleModel\n（本模板尚未分析出 styleModel：按令牌与内容自行判断版式，不要套用通用商务卡片）';
  const planBlock = plan ? '## pagePlan（本页计划）\n' + JSON.stringify(plan, null, 1) : '';
  const protoBlock = protoSource === 'reference'
    ? ''
    : (proto ? '<prototype source="' + protoSource + '">\n' + proto.svg + '\n</prototype>' : '');

  const system = [
    promptFile('generate-slide.md'),
    '',
    '## 本次画布与设计令牌',
    // spec.tokensText 构建时还不知道 styleModel；有 styleModel 时必须以它的实测色板重写，
    // 否则模型会被「只许用这些值」约束到 Office 主题槽位的默认色上。
    styleModel && theme ? tokensText(theme, styleModel) : spec.tokensText,
    '',
    '## 编译器能力契约',
    contractText(),
    '',
    styleBlock,
    planBlock,
    '## 参考原型来源',
    protoSource === 'reference'
      ? '附带的参考页图来自本模板的原始页面（由对象图重建渲染）。它们是真实证据，请复刻其家族级设计语言。'
      : protoSource === 'reference-file'
        ? '下面的原型 SVG 来自模板自带的 layouts/ 目录，属于模板证据。'
        : '未找到本家族的参考页；下面的原型是合成回退，只作为起点，不得当作模板的真实证据。',
    protoBlock,
  ].filter(Boolean).join('\n');

  const user = [
    '演示主标题：' + (docTitle || '（无）'),
    '本页角色：' + role + '（第 ' + (index + 1) + ' 页 / 共 ' + total + ' 页）',
    plan && plan.familyId ? '本页家族：' + plan.familyId + (plan.variantId ? ' / ' + plan.variantId : '') : '',
    '',
    '本页内容（Markdown，内容不得改动、不得截断、不得用省略号掩盖）：',
    section.raw,
    feedback ? '\n本页修改意见（只在必要范围内改动，锁定没有问题的部分）：' + feedback : '',
    previousSvg ? '\n上一版 SVG（局部修复时以它为基准，不要重做整页）：\n<previous-svg>\n' + previousSvg + '\n</previous-svg>' : '',
    '',
    '请为这一页创作 SVG。',
  ].filter(Boolean).join('\n');

  const text = await (referenceImages && referenceImages.length
    ? llm.chatVision([{
      role: 'user',
      content: [
        { type: 'text', text: system + '\n\n' + user },
        ...referenceImages.flatMap((r, k) => ([
          { type: 'text', text: '参考页 ' + (r.n || k + 1) + (r.familyId ? '（家族 ' + r.familyId + '）' : '') + '：' },
          { type: 'image_url', image_url: { url: r.dataUri } },
        ])),
      ],
    }], { temperature: 0.6, maxTokens: 6000, timeoutMs: 300000 })
    : llm.chat([{ role: 'system', content: system }, { role: 'user', content: user }], { temperature: 0.6, maxTokens: 6000 }));
  return llm.extractSvg(text);
}
module.exports = { splitOutline, generateSlideSvg, addGeneratedImage, generateSlideImage, deckArtDirection, deckImageBriefs, acquire, release };
