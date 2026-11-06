// 视觉反推层：把「模板证据 → 复刻规格」提示词（prompts/template-reverse-spec.md）
// 落到管线里。机器测量（template-profile：烘焙/槽位/hex 采样）负责像素事实，本模块
// 负责视觉语义层——角色判定、版式语法、泛化边界、缺陷如实记录。产物
// template-spec.json 与 template-profile.json 同目录存放，生成端与 QA 端共用。
const fs = require('fs');
const path = require('path');
const { parseSourcePages } = require('./pptx-pages');
const { pageToHtml } = require('./bake');
const htmlShot = require('./html-shot');
const llm = require('./llm');

const SPEC_FILE = 'template-spec.json';
const PROMPT_FILE = path.join(__dirname, '..', 'prompts', 'template-reverse-spec.md');

const uri = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;

// 把源模板逐页渲染成 PNG + 一张接触表（跨页节奏证据）。
// 页数超上限时均匀抽样全页图，但接触表始终覆盖全部页。
// fullScale：全页图降采样（上游多模态接口有 ~100s 网关超时，payload 必须轻）。
async function renderRefPages(buffer, { outDir, maxFull = 3, mediaDir, fullScale = 0.72 }) {
  const { canvas, pages } = await parseSourcePages(buffer, { mediaDir });
  fs.mkdirSync(outDir, { recursive: true });
  const H = Math.round(1280 * canvas.height / canvas.width);
  const shots = [];
  for (let i = 0; i < pages.length; i++) {
    const html = pageToHtml(pages[i], canvas, mediaDir);
    const png = await htmlShot.renderToPng(html, { width: 1280, height: H, scale: 1 });
    const f = path.join(outDir, `page-${String(i + 1).padStart(2, '0')}.png`);
    fs.writeFileSync(f, png);
    shots.push(f);
  }
  // 接触表：每格 320px 宽的网格
  const cols = Math.min(6, Math.ceil(Math.sqrt(shots.length)));
  const cw = 320, ch = Math.round(320 * canvas.height / canvas.width);
  const rows = Math.ceil(shots.length / cols);
  const cells = shots.map((f, i) => `<div style="position:relative;width:${cw}px;height:${ch}px;overflow:hidden;border:1px solid #ddd;box-sizing:border-box">`
    + `<img src="file:///${f.replace(/\\/g, '/')}" style="width:100%;height:100%;display:block">`
    + `<span style="position:absolute;left:2px;top:2px;font:bold 12px sans-serif;color:#fff;background:#0009;padding:1px 5px">${i + 1}</span></div>`).join('');
  const sheet = path.join(outDir, 'contact-sheet.png');
  fs.writeFileSync(sheet, await htmlShot.renderToPng(
    `<div style="display:grid;grid-template-columns:repeat(${cols},${cw}px);gap:4px;background:#fafafa">${cells}</div>`,
    { width: cols * cw + (cols + 1) * 4, height: rows * ch + (rows + 1) * 4, scale: 1 }));
  // 全页图均匀抽样（首/尾必含），配合接触表喂给视觉模型
  const picks = new Set([0, shots.length - 1]);
  for (let k = 1; k < maxFull - 1; k++) picks.add(Math.round((k * (shots.length - 1)) / (maxFull - 1)));
  const full = [...picks].sort((a, b) => a - b).map((i) => ({ n: i + 1, file: shots[i] }));
  // 降采样副本（上游网关超时约束下控制 payload）
  const W2 = Math.round(1280 * fullScale);
  const fullSmall = [];
  for (const p of full) {
    const f = p.file.replace('.png', '.small.png');
    fs.writeFileSync(f, await htmlShot.renderToPng(
      `<img src="file:///${p.file.replace(/\\/g, '/')}" style="width:${W2}px;display:block">`,
      { width: W2, height: Math.round(W2 * canvas.height / canvas.width), scale: 1 }));
    fullSmall.push({ n: p.n, file: f });
  }
  return { canvas, pageCount: pages.length, sheet, full: fullSmall };
}

// 机器测量画像的摘要（喂给视觉模型作交叉验证底稿，视觉证据与测量冲突时以测量为准）
function profileSummary(profile) {
  if (!profile) return '(无机器测量画像)';
  const r = profile.roles || {};
  const roleLine = (x) => x && ({
    asset: x.asset, hIn: x.hIn,
    title: x.slot && { rect: x.slot.rect, size: x.slot.size, color: x.slot.color, font: x.slot.font },
    slots: x.slots && Object.fromEntries(Object.entries(x.slots).map(([k, s]) => [k, s.rect && [s.rect.map((v) => Math.round(v * 100) / 100), s.size, s.color]])),
  });
  return JSON.stringify({
    canvas: profile.canvas,
    tokens: profile.tokens,
    fonts: profile.invariants && profile.invariants.fonts,
    fontFamilies: profile.invariants && profile.invariants.fontFamilies,
    sourceSlideCount: profile.sourceSlideCount,
    roles: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, roleLine(v)])),
  }, null, 1);
}

function parseSpecJson(raw) {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/);
  return llm.extractJson(fenced ? fenced[1] : raw);
}

// 反推主入口：返回 { spec, raw }。渲染证据页落 outDir（.reverse），规格本体落
// specDir（模板根目录，与 template-profile.json 并排，供 loadTemplateSpec 读取）。
async function reverseSpec({ buffer, profile, outDir, maxFull = 3, mediaDir, specDir }) {
  const prompt = fs.readFileSync(PROMPT_FILE, 'utf8');
  const { canvas, pageCount, sheet, full } = await renderRefPages(buffer, { outDir, maxFull, mediaDir: mediaDir || path.join(outDir, '.media') });
  const machineNote = [
    '【调用方补充：机器测量底稿】',
    '以下是无视觉的解析管线已经测得的事实（画布/令牌/角色槽位）。它与你的视觉观察',
    '来自同一份模板：一致处直接采信测量值；冲突时以测量为准并在 FIDELITY_AUDIT 里',
    '指出冲突；测量缺失的维度（版式语法/文本语法/泛化边界/缺陷）由你的视觉分析补齐。',
    '输出采用提示词中「机器消费模式」：TEMPLATE_SPEC 为单个 JSON 对象（```json 围栏）。',
    '上游网关对响应时间有硬限制：JSON 必须紧凑——字符串字段每条 ≤40 字、数组每类 ≤6 条、',
    '总输出 ≤3500 token；证据要点优先，禁止散文和重复。',
    '',
    'MEASURED_PROFILE:',
    profileSummary(profile),
  ].join('\n');
  const content = [{ type: 'text', text: `${prompt}\n\n${machineNote}` }, { type: 'image_url', image_url: { url: uri(sheet) } }];
  for (const p of full) content.push({ type: 'text', text: `第 ${p.n} 页全页图：` }, { type: 'image_url', image_url: { url: uri(p.file) } });
  const raw = await llm.chatVision([{ role: 'user', content }], { temperature: 0.2, maxTokens: 8000, timeoutMs: 300000 });
  const spec = parseSpecJson(raw);
  if (!spec || typeof spec !== 'object') throw new Error('反推失败：模型未产出可解析的 TEMPLATE_SPEC JSON');
  spec.canvas = spec.canvas && spec.canvas.width ? spec.canvas : canvas;
  spec._meta = { reversedAt: new Date().toISOString(), pageCount, fullPages: full.map((p) => p.n), promptFile: 'prompts/template-reverse-spec.md' };
  const specOut = specDir || outDir;
  fs.mkdirSync(specOut, { recursive: true });
  fs.writeFileSync(path.join(specOut, SPEC_FILE), JSON.stringify(spec, null, 2));
  fs.writeFileSync(path.join(specOut, 'template-spec.raw.md'), raw);
  return { spec, raw };
}

function loadTemplateSpec(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, SPEC_FILE), 'utf8')); } catch { return null; }
}

// 视觉规格 + 模板实测主色 的令牌校正：
// - bg/ink/muted/panel 以规格判定为准（封面深色的模板常被机器误判基调）；
// - accent 优先模板实测 primary（4472C4 这类主题蓝），避免令牌推导的兜底蓝混入。
function applySpecTokens(profile, spec, themePrimary) {
  const t = spec && spec.tokens;
  if (!profile || !t) return profile;
  const hex = (v) => (typeof v === 'string' ? v.replace('#', '') : null);
  const clean = (v) => (v && /^[0-9a-fA-F]{6}$/.test(v) ? v : null);
  const out = JSON.parse(JSON.stringify(profile));
  out.tokens = {
    ...out.tokens,
    bg: clean(hex(t.bg)) || out.tokens.bg,
    ink: clean(hex(t.ink)) || out.tokens.ink,
    muted: clean(hex(t.muted)) || out.tokens.muted,
    panel: clean(hex(t.panel)) || out.tokens.panel,
    accent: clean(hex(themePrimary)) || out.tokens.accent,
    accent2: clean(hex(themePrimary)) || out.tokens.accent2 || out.tokens.accent,
    accent3: clean(hex(themePrimary)) || out.tokens.accent3 || out.tokens.accent,
  };
  out._specTokens = true;
  return out;
}

module.exports = { reverseSpec, loadTemplateSpec, renderRefPages, applySpecTokens, SPEC_FILE };
