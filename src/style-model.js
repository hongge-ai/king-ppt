// styleModel —— 模板的「视觉语义层」规格，由 analyze-template 提示词从参考页图反推。
//
// 与 template-profile.json 里的机器测量（烘焙素材、槽位矩形、采色）是互补关系：
//   测量层回答「像素上是什么」，styleModel 回答「这套设计为什么这样、边界在哪」。
// 两者同存于 template-profile.json，测量字段一字不改——任何冲突都保留双方，
// 由分析结果里的纠正建议说明，绝不静默覆盖原始证据。
//
// 生成端（page-plan / generate-slide）与验收端（audit-slide）共用这一份真值。
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const { renderRefPages, profileSummary, dataUri } = require('./ref-pages');
const { compilerContract } = require('./compiler-contract');

const SCHEMA_VERSION = 'king-ppt.style/1';
const PROMPT_FILE = path.join(__dirname, 'prompts', 'analyze-template.md');

const EVIDENCE = ['source', 'observed', 'inferred', 'fallback'];
const CONFIDENCE = ['high', 'medium', 'low'];
// 字体识别状态：已确认 / 视觉候选 / 未确认 / 推断。后两者是「如实记录不确定」的合法表达，
// 不能因为叫法不同就判为非法——分析器的价值正在于区分确认与推测。
const FONT_STATUS = ['confirmed', 'visual-candidate', 'unconfirmed', 'inferred'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const UNITS = ['px', 'pt', 'inch'];

// 令牌统一读取：契约规定 tokens 的四个分类都是「带证据的条目数组」
// （{ id, role, value|px|family, unit, evidenceType, confidence }）。
// 早期分析产出过「名称→值」映射，这里一并兼容，避免历史产物无法使用。
function tokenEntries(model, kind) {
  const raw = model && model.tokens && model.tokens[kind];
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((e) => e && typeof e === 'object');
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([k, v]) => (v && typeof v === 'object'
      ? { id: k, ...v }
      : { id: k, role: k, value: v }));
  }
  return [];
}

// 按语义归类：id 只作辅助，role（可读语义）优先。分析模型的 id 命名不可预测，
// 但「页面底色」「强调色」「左右安全边距」这类 role 语义是稳定可读的。
const ROLE_WORDS = {
  bg: ['底色', '背景', '页面底', 'background'],
  ink: ['主文字', '正文', '正文墨', 'main text', 'body text', 'ink'],
  muted: ['弱化', '次要', '说明', '来源', 'secondary', 'muted', 'caption'],
  panel: ['卡片', '底纹', '面板', '卡片底', 'panel', 'surface', 'card'],
  accent: ['强调色', '品牌色', '强调', 'accent', 'primary'],
  accent2: ['深强调', '强调描边', '副标题', '次强调', 'deep', 'accent-deep'],
  title: ['标题色', '页标题', 'title color', 'heading color'],
};
const GEOM_WORDS = {
  cornerRadius: ['圆角', 'radius', 'corner'],
  hairline: ['细线', '线宽', 'hairline', 'stroke', 'divider'],
  margin: ['边距', 'margin', 'gutter', '安全边'],
};

function entryMatches(entry, words) {
  const hay = `${entry.id || ''} ${entry.role || ''} ${entry.name || ''}`.toLowerCase();
  return words.some((w) => hay.includes(String(w).toLowerCase()));
}

function colorOf(entry) {
  const v = entry && (entry.value || entry.hex || entry.color);
  return typeof v === 'string' && HEX.test(v) ? v.replace('#', '').toUpperCase() : null;
}

// 从 tokens 里按语义取一条颜色；同一语义有多个候选时按 evidenceType 优先（实测优先于推导）。
function pickColor(entries, key) {
  const words = ROLE_WORDS[key] || [];
  const hits = entries.filter((e) => colorOf(e) && entryMatches(e, words));
  if (!hits.length) return null;
  const rank = { source: 0, observed: 1, inferred: 2, fallback: 3 };
  hits.sort((a, b) => (rank[a.evidenceType] ?? 4) - (rank[b.evidenceType] ?? 4));
  return colorOf(hits[0]);
}

function pickGeometry(entries, key) {
  const words = GEOM_WORDS[key] || [];
  const hit = entries.find((e) => entryMatches(e, words) && Number.isFinite(Number(e.value ?? e.px)));
  return hit ? Number(hit.value ?? hit.px) : null;
}

// 顶层字段：提示词第七节规定必须齐全（缺失写 null，不是省略）
const REQUIRED_TOP = [
  'schemaVersion', 'coverage', 'sourceCanvas', 'targetViewBox', 'aspectPolicy',
  'tokens', 'fingerprints', 'families', 'components', 'imageStyle', 'exportRisks', 'unknowns',
];

function fail(message, code = 'BAD_STYLE_MODEL') {
  const e = new Error(message);
  e.code = code;
  return e;
}

// 确定性校验：不引 schema 库，规则来自提示词自己写明的枚举与格式约束。
// 返回 { ok, errors } —— 首轮按 warn 落盘（附 _validation），跑顺后再收紧为硬拒绝。
function validateStyleModel(model, { pageCount = Infinity } = {}) {
  const errors = [];
  const push = (m) => errors.push(m);
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return { ok: false, errors: ['顶层不是对象'] };
  }
  if (model.schemaVersion !== SCHEMA_VERSION) push(`schemaVersion 必须是 ${SCHEMA_VERSION}，实际 ${JSON.stringify(model.schemaVersion)}`);
  for (const k of REQUIRED_TOP) if (!(k in model)) push(`缺少顶层字段 ${k}（缺失项应为 null）`);

  const checkEvidence = (obj, where) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.evidenceType !== undefined && !EVIDENCE.includes(obj.evidenceType)) {
      push(`${where}.evidenceType 非法：${JSON.stringify(obj.evidenceType)}（应为 ${EVIDENCE.join('/')}）`);
    }
    if (obj.confidence !== undefined && !CONFIDENCE.includes(obj.confidence)) {
      push(`${where}.confidence 非法：${JSON.stringify(obj.confidence)}（应为 ${CONFIDENCE.join('/')}）`);
    }
    const idx = obj.sourcePageIndexes;
    if (idx !== undefined && idx !== null) {
      if (!Array.isArray(idx)) push(`${where}.sourcePageIndexes 必须是数组`);
      else idx.forEach((i) => {
        if (!Number.isInteger(i) || i < 0) push(`${where}.sourcePageIndexes 含非法索引 ${JSON.stringify(i)}`);
        else if (i >= pageCount) push(`${where}.sourcePageIndexes 越界：${i}（模板共 ${pageCount} 页，索引 0-based）`);
      });
    }
  };

  // tokens：四个分类都是条目数组，颜色条目必须带 #RRGGBB 的 value，几何/字号必须带单位。
  const t = model.tokens;
  if (t !== null && t !== undefined) {
    if (typeof t !== 'object') push('tokens 必须是对象或 null');
    else {
      for (const kind of ['color', 'font', 'scale', 'geometry']) {
        const raw = t[kind];
        if (raw === undefined || raw === null) continue;
        if (!Array.isArray(raw)) { push(`tokens.${kind} 必须是条目数组或 null`); continue; }
        raw.forEach((e, i) => {
          const where = `tokens.${kind}[${i}]`;
          if (!e || typeof e !== 'object') return push(`${where} 不是对象`);
          if (!e.id) push(`${where} 缺少稳定 id`);
          if (!e.role) push(`${where} 缺少 role 语义说明`);
          checkEvidence(e, where);
          if (kind === 'color') {
            const v = e.value ?? e.hex ?? e.color;
            if (v !== null && v !== undefined && !HEX.test(String(v))) push(`${where}.value 不是 #RRGGBB：${JSON.stringify(v)}`);
          }
          if (kind === 'geometry' || kind === 'scale') {
            const v = e.value ?? e.px;
            if (!Number.isFinite(Number(v))) push(`${where} 缺少数值 value 或 px`);
            if (e.unit !== undefined && !UNITS.includes(e.unit)) push(`${where}.unit 非法：${JSON.stringify(e.unit)}（应为 ${UNITS.join('/')}）`);
          }
          if (kind === 'font' && e.family === undefined) push(`${where} 缺少 family`);
          if (kind === 'font' && e.status !== undefined && !FONT_STATUS.includes(e.status)) {
            push(`${where}.status 非法：${JSON.stringify(e.status)}（应为 ${FONT_STATUS.join('/')}）`);
          }
        });
      }
    }
  }

  const fams = model.families;
  if (fams !== null && fams !== undefined) {
    if (!Array.isArray(fams)) push('families 必须是数组或 null');
    else {
      const ids = new Set();
      fams.forEach((f, i) => {
        const where = `families[${i}]`;
        if (!f || typeof f !== 'object') return push(`${where} 不是对象`);
        if (!f.id) push(`${where} 缺少稳定 id`);
        else if (ids.has(f.id)) push(`${where}.id 重复：${f.id}`);
        else ids.add(f.id);
        if (!['cover', 'section', 'content', 'closing'].includes(f.role)) push(`${where}.role 非法：${JSON.stringify(f.role)}`);
        checkEvidence(f, where);
        (f.variants || []).forEach((v, j) => { if (v && typeof v === 'object') checkEvidence(v, `${where}.variants[${j}]`); });
      });
    }
  }

  const comps = model.components;
  if (comps !== null && comps !== undefined) {
    if (!Array.isArray(comps)) push('components 必须是数组或 null');
    else {
      const ids = new Set();
      comps.forEach((c, i) => {
        const where = `components[${i}]`;
        if (!c || typeof c !== 'object') return push(`${where} 不是对象`);
        if (!c.id) push(`${where} 缺少稳定 id`);
        else if (ids.has(c.id)) push(`${where}.id 重复：${c.id}`);
        else ids.add(c.id);
        if (c.behavior !== undefined && !['fixed', 'replace', 'generate', 'repeat'].includes(c.behavior)) {
          push(`${where}.behavior 非法：${JSON.stringify(c.behavior)}`);
        }
        if (c.atomicRole !== undefined && !['brand', 'content', 'decoration', 'chrome'].includes(c.atomicRole)) {
          push(`${where}.atomicRole 非法：${JSON.stringify(c.atomicRole)}`);
        }
        checkEvidence(c, where);
      });
    }
  }

  (model.fingerprints && Array.isArray(model.fingerprints) ? model.fingerprints : []).forEach((f, i) => checkEvidence(f, `fingerprints[${i}]`));
  checkEvidence(model.imageStyle, 'imageStyle');
  checkEvidence(model.coverage, 'coverage');

  return { ok: errors.length === 0, errors };
}

function promptText() {
  return fs.readFileSync(PROMPT_FILE, 'utf8');
}

function parseJson(raw) {
  const fenced = String(raw || '').match(/```json\s*([\s\S]*?)```/);
  return llm.extractJson(fenced ? fenced[1] : raw);
}

// 分析主入口。产物：{ model, raw, validation, pages }
// 参考页图落 outDir（模板目录下的 .ref）；styleModel 由调用方存进 profile。
async function analyzeTemplate({ buffer, profile, outDir, maxFull = 3, mediaDir, analysisOptions } = {}) {
  const pages = await renderRefPages(buffer, {
    outDir: outDir || path.join(process.cwd(), '.ref'),
    maxFull,
    mediaDir: mediaDir || path.join(outDir || '.', '.media'),
  });

  const contract = compilerContract();
  const machineNote = [
    '【调用方补充】',
    `schemaVersion 必须输出 ${SCHEMA_VERSION}。`,
    '下面的 measuredProfile 是机器解析得到的像素事实：与你的视觉观察冲突时，以测量为准，并在输出里记下冲突，不要覆盖或篡改原始测量。',
    '参考图来源：由 PPTX 对象图重建后经无头浏览器渲染，不是目标办公软件的原件渲染——疑似解析丢失的元素，记录为证据限制，不要当成原稿设计。',
    '上游网关有硬超时，输出会被硬截断：JSON 必须紧凑。数组每类 ≤6 条，字符串条目 ≤50 字，总输出控制在 12000 token 内。禁止散文、禁止注释、禁止在 JSON 之外写任何说明。',
    '务必先写完整个 JSON 再考虑详略：宁可每条写短，也不要让最后一个顶层字段缺失。',
    '',
    'MEASURED_PROFILE:',
    profileSummary(profile),
    '',
    'RENDERER_CAPABILITIES:',
    JSON.stringify(contract, null, 1),
    '',
    'ANALYSIS_OPTIONS:',
    JSON.stringify(analysisOptions || { brand: 'learn-style-only', targetViewBox: { width: 1280, height: 720 } }, null, 1),
  ].join('\n');

  const content = [
    { type: 'text', text: `${promptText()}\n\n${machineNote}` },
    { type: 'image_url', image_url: { url: dataUri(pages.sheet) } },
  ];
  for (const p of pages.full) {
    content.push({ type: 'text', text: `第 ${p.n} 页全页图：` });
    content.push({ type: 'image_url', image_url: { url: dataUri(p.file) } });
  }

  const raw = await llm.chatVision([{ role: 'user', content }], { temperature: 0.2, maxTokens: 16000, timeoutMs: 300000 });
  // 原始输出落盘：模型 JSON 出问题时，必须能拿到证据定位是截断、缺逗号还是围栏混叠，
  // 而不是只看到一句解析错误。
  const rawFile = path.join(outDir || '.', 'style-model.raw.md');
  try { fs.writeFileSync(rawFile, raw, 'utf8'); } catch { /* 落盘失败不阻塞分析 */ }
  let model;
  try {
    model = parseJson(raw);
  } catch (e) {
    throw fail(`${e.message}（原始输出已存至 ${rawFile}）`, e.code || 'BAD_STYLE_MODEL');
  }
  if (!model || typeof model !== 'object') throw fail(`分析失败：模型未产出可解析的 styleModel JSON（原始输出见 ${rawFile}）`);

  // 未声明的目标画布按当前工作画布补齐（生成端恒为 1280×720）
  if (!model.targetViewBox || !model.targetViewBox.width) model.targetViewBox = { width: 1280, height: 720 };
  model._meta = { schemaVersion: SCHEMA_VERSION, analyzedAt: new Date().toISOString(), pageCount: pages.pageCount, fullPages: pages.full.map((p) => p.n), promptFile: 'src/prompts/analyze-template.md' };

  const validation = validateStyleModel(model, { pageCount: pages.pageCount });
  return { model, raw, validation, pages };
}

// 写入 template-profile.json 的 styleModel 键；测量字段原样保留。
function saveStyleModel(dir, model, validation) {
  const file = path.join(dir, 'template-profile.json');
  if (!fs.existsSync(file)) throw fail('模板尚未生成机器测量画像，无法写入 styleModel', 'PROFILE_MISSING');
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  profile.styleModel = validation && !validation.ok ? { ...model, _validation: { ok: false, errors: validation.errors } } : model;
  fs.writeFileSync(file, JSON.stringify(profile, null, 2));
  return profile;
}

function loadStyleModel(dir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'template-profile.json'), 'utf8'));
    return p && p.styleModel ? p.styleModel : null;
  } catch { return null; }
}

// 把 styleModel + 机器测量 + 主题实测主色合成渲染器用的令牌出口。
// 与旧 applySpecTokens 的差别：颜色、字号、几何单位一起映射，而不是只挑几个颜色。
function resolveTokens(profile, model, themePrimary) {
  const base = { ...(profile && profile.tokens ? profile.tokens : {}) };
  const colors = tokenEntries(model, 'color');
  const geoms = tokenEntries(model, 'geometry');
  const hex = (v) => (typeof v === 'string' && HEX.test(v) ? v.replace('#', '').toUpperCase() : null);
  // 视觉判定优先（深色封面模板常被机器误判基调），其次机器测量；都没有时用 profile 的推导值。
  const bg = pickColor(colors, 'bg') || base.bg;
  const ink = pickColor(colors, 'ink') || base.ink;
  const muted = pickColor(colors, 'muted') || base.muted;
  const panel = pickColor(colors, 'panel') || base.panel;
  // accent 优先模板实测主色（主题蓝这类），其次 styleModel 的强调色，最后测量推导值
  const accent = hex(themePrimary) || pickColor(colors, 'accent') || base.accent;
  const accent2 = pickColor(colors, 'accent2') || base.accent2 || accent;
  const out = {
    ...base,
    bg, ink, muted, panel,
    accent,
    accent2,
    accent3: base.accent3 || accent2,
    // 页标题色：学术类模板的标题常与正文墨色不同（藏青标题 + 灰正文）
    title: pickColor(colors, 'title') || base.title || ink,
    isDark: base.isDark,
  };
  if (typeof out.isDark !== 'boolean') {
    const l = (h) => {
      const s = String(h || '').replace('#', '');
      if (!/^[0-9A-F]{6}$/i.test(s)) return 0.5;
      return (0.2126 * parseInt(s.slice(0, 2), 16) + 0.7152 * parseInt(s.slice(2, 4), 16) + 0.0722 * parseInt(s.slice(4, 6), 16)) / 255;
    };
    out.isDark = l(out.bg) < 0.5;
  }
  // 几何令牌（圆角/线宽/边距）是渲染器唯一真正消费的结构化几何来源。
  // 分析结果里的源单位可能是 pt/inch，统一换算到 SVG 用户单位（1280 宽画布）。
  const toUserPx = (value, unit) => {
    const v = Number(value);
    if (!Number.isFinite(v)) return null;
    if (unit === 'pt') return v * 96 / 72;                 // pt → px
    if (unit === 'inch') return v * 96;                     // inch → px（1 inch = 96px）
    return v;
  };
  const radiusEntry = geoms.find((e) => entryMatches(e, GEOM_WORDS.cornerRadius));
  const hairEntry = geoms.find((e) => entryMatches(e, GEOM_WORDS.hairline));
  out.geometry = {
    ...(base.geometry || {}),
    ...(radiusEntry ? { cornerRadius: toUserPx(radiusEntry.value ?? radiusEntry.px, radiusEntry.unit) } : {}),
    ...(hairEntry ? { hairline: toUserPx(hairEntry.value ?? hairEntry.px, hairEntry.unit) } : {}),
  };
  out._fromStyleModel = Boolean(model);
  return out;
}

module.exports = {
  SCHEMA_VERSION, PROMPT_FILE,
  analyzeTemplate, validateStyleModel, saveStyleModel, loadStyleModel, resolveTokens, promptText,
};
