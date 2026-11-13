const path = require('path');
const fs = require('fs');
const express = require('express');
const { buildPptx } = require('./pptx');
const { loadDescriptor, listDescriptors, loadTheme, loadThemeLayouts, loadProfile, deleteTemplate } = require('./descriptor');
const { resolve } = require('./layout-resolver'); // 仅供旧模板画廊 sample/preview 路由；P3 主题系统落地后连同这些路由一并移除
const assets = require('./assets');
const { extractFromPptx, saveTemplate } = require('./extract');
const { parseSourcePages } = require('./pptx-pages');
const { pageToHtml } = require('./bake');
const htmlShot = require('./html-shot');
const normalize = require('./normalize');
const normalizeOutline = require('./normalize-outline');
const materials = require('./materials');
const { buildSpec } = require('./spec');
const { createRelay } = require('./relay');
const history = require('./history');
const { HOME, RUNTIME_FILE } = require('./paths');
const { createGenerationJobs } = require('./generation-jobs');
const llmprovider = require('./llmprovider');
const genOutline = require('./generate-outline');
const genDeck = require('./generate-deck');
const { renderTemplateSlide } = require('./template-renderer');
const styleModel = require('./style-model');
const { planDeck, renderHints } = require('./page-plan');
const { scoreDeck } = require('./style-score');

const app = express();
let relay;
let taskSyncSuppressed = false;
function templateNameOf(id) {
  if (!id) return '';
  const item = listDescriptors().find((t) => t.id === id);
  return item ? (item.name || item.id) : id;
}
function syncActiveTask() {
  if (!relay || taskSyncSuppressed) return;
  const deck = relay.getState();
  if (deck.taskId) {
    history.updateTask(deck.taskId, { deck, doc: relay.getDoc() });
    relay.broadcast('history', history.list());
  }
}
relay = createRelay({ onChange: syncActiveTask }); // deck/doc 持久化并同步到当前对话任务
const generationJobs = createGenerationJobs({
  file: path.join(HOME, 'deck-generation.json'),
  onChange: (job) => {
    relay.broadcast('generation', job);
    if (job && ['completed', 'failed', 'interrupted'].includes(job.status)) relay.broadcast('history', history.list());
  },
});

function ensureCurrentTask({ title, prompt } = {}) {
  const deck = relay.getState();
  if (deck.taskId) return { id: deck.taskId, created: false };
  const existing = history.findByFingerprint(deck);
  if (existing) {
    relay.setTaskId(existing.id);
    relay.setProjectTitle(existing.title);
    if (prompt && history.messagesFor(existing.id).length === 0) appendTaskMessage('user', prompt);
    return { id: existing.id, created: false };
  }
  const templateName = templateNameOf(deck.templateId);
  const task = history.createTask({ title, prompt, deck, doc: relay.getDoc(), templateName });
  relay.setTaskId(task.id);
  relay.setProjectTitle(task.title);
  return { id: task.id, created: true };
}

function appendTaskMessage(role, content) {
  const taskId = relay.getState().taskId;
  if (!taskId || !String(content || '').trim()) return null;
  const message = history.appendMessage(taskId, { role, content });
  relay.broadcast('history', history.list());
  return message;
}

// 升级旧版单工作区快照：服务已有成品但尚无 taskId 时，将它一次性迁入对话历史。
{
  const deck = relay.getState();
  const doc = relay.getDoc();
  if (!deck.taskId && (deck.slides.some(Boolean) || doc.markdown.trim())) {
    ensureCurrentTask({ title: deck.projectTitle || deck.title || doc.title, prompt: doc.title || deck.title });
  }
}

// 上传模板 / 就地编辑整页 SVG / 配图以 base64 进 JSON，放宽体积；其余路由维持 2mb
const jsonBody = express.json({ limit: '2mb' });
const jsonBodyLarge = express.json({ limit: '30mb' });
app.use((req, res, next) => {
  const large = req.path === '/api/templates/extract'
    || req.path === '/api/assets'
    || req.path === '/api/materials'
    || req.path === '/api/export' // 整册 SVG（含 base64 生成插画）回传导出，同样可达数 MB
    || req.path.startsWith('/api/deck/')
    || req.path.startsWith('/api/generate/');
  return (large ? jsonBodyLarge : jsonBody)(req, res, next);
});
app.use(express.static(path.join(__dirname, '..', 'public')));

// 画布规格归一：主题层用 {vbWidth,vbHeight}（SVG viewBox），pptx 编译器要 {width,height}
// （英寸）。历史快照存的是前者，导出时必须转换，否则 defineLayout 拿不到 width 直接抛错。
function coerceCanvas(c) {
  if (!c || typeof c !== 'object') return null;
  if (Number(c.width) > 0 && Number(c.height) > 0) return { width: Number(c.width), height: Number(c.height) };
  if (Number(c.vbWidth) > 0 && Number(c.vbHeight) > 0) {
    return { width: Number(c.vbWidth) / 80, height: Number(c.vbHeight) / 80 }; // 1280×720 → 16×9 英寸
  }
  return null;
}

function statusOf(err) {
  if (err.code === 'SESSION_NOT_FOUND' || err.code === 'ASSET_NOT_FOUND') return 404;
  if (err.code === 'BAD_SESSION_ID' || err.code === 'BAD_ASSET_NAME') return 400;
  if (err.code === 'NO_API_KEY') return 401;
  if (err.code === 'BAD_INPUT' || err.code === 'NO_MODEL_CONFIG' || err.code === 'CAPABILITY_NOT_SUPPORTED') return 400;
  if (err.code === 'TEMPLATE_NOT_FOUND') return 400; // 未指定/找不到模板：提示先上传并选择模板
  if (err.code === 'BUSY') return 409;
  if (err.code === 'LLM_HTTP' || err.code === 'LLM_EMPTY' || err.code === 'LLM_TIMEOUT') return 502; // 上游模型错误
  return 500;
}

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (res.headersSent) return res.end(); // 已开始响应（如 sendFile 中途断开），只能放弃
      res.status(statusOf(err)).json({ error: err.message });
    }
  };
}

// 参考页图加载器：分析阶段把源模板逐页渲染到 <模板目录>/.ref/page-NN.png，
// 生成时按 pagePlan.referencePageIndexes 取对应页作为「真实证据」喂给演示模型。
// 没有分析产物时返回空数组——调用方据此回退到合成原型，并如实标注来源。
function refPageLoader(dir) {
  const refDir = path.join(dir, '.ref');
  const fileFor = (i) => path.join(refDir, `page-${String(i + 1).padStart(2, '0')}.png`);
  return (pagePlan) => {
    if (!pagePlan || !Array.isArray(pagePlan.referencePageIndexes)) return [];
    return pagePlan.referencePageIndexes
      .filter((i) => fs.existsSync(fileFor(i)))
      .slice(0, 2)
      .map((i) => ({
        n: i + 1,
        familyId: pagePlan.familyId,
        dataUri: `data:image/png;base64,${fs.readFileSync(fileFor(i)).toString('base64')}`,
      }));
  };
}

// ---------- 模板 ----------
app.get('/api/templates', (req, res) => {
  res.json({ templates: listDescriptors() });
});

// 所选主题的创作规格：设计令牌 + 4 个角色原型页 + SVG 创作规则，供生成引擎照着画整页 SVG
app.get('/api/templates/:id/spec', wrap(async (req, res) => {
  const theme = loadTheme(req.params.id);
  const profile = loadProfile(req.params.id);
  const base = buildSpec(theme, loadThemeLayouts(req.params.id));
  let layouts = base.layouts;
  if (profile) {
    // Preview == generation: render the 4 role prototypes with the SAME
    // deterministic renderer that builds the deck (baked chrome + tokens),
    // instead of the generic synthesized prototypes — so the preview reflects
    // the actual template rather than an approximation.
    const samples = [
      { role: 'cover', section: { heading: theme.name || '演示文稿标题', body: '副标题示例，一句话点明主旨\n署名 · 日期' } },
      { role: 'section', section: { heading: '第一章 示例章节', body: '> 本章导语示例', sectionNo: '01' } },
      { role: 'content', section: { heading: '示例页面标题', body: '- 要点一：一句话说明要义\n- 要点二：一句话说明要义\n- 要点三：一句话说明要义\n> 一句话收束的结论' } },
      { role: 'closing', section: { heading: '谢谢观看', body: '> 谢谢观看' } },
    ];
    const rendered = samples
      .map((s, i) => ({ role: s.role, svg: renderTemplateSlide({ profile, templateDir: theme._dir, section: s.section, role: s.role, index: i, total: samples.length, imageData: null }) }))
      .filter((x) => x.svg);
    if (rendered.length) layouts = rendered;
  }
  res.json({ ...base, layouts, profile: profile ? { confidence: profile.extraction?.confidence, roles: Object.keys(profile.roles || {}), sourceSlideCount: profile.sourceSlideCount } : null });
}));

// 画廊卡片预览：3 张样例页的场景图
app.get('/api/templates/:id/sample', wrap(async (req, res) => {
  const d = loadDescriptor(req.params.id);
  const samples = [
    { index: 0, type: 'title', title: '演示文稿标题', subtitle: '副标题示例文字' },
    { index: 1, type: 'section', title: '第一章节名', subtitle: '章节导语示例' },
    { index: 2, type: 'bullets', title: '页面标题', bullets: ['第一条要点内容', '第二条要点内容', '第三条要点内容'] },
  ];
  res.json({ canvas: d.canvas, scenes: resolve(d, samples, { title: d.meta.name }).slides });
}));

app.get('/api/templates/:id/assets/:file', wrap(async (req, res) => {
  const { id, file } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || file !== path.basename(file)) {
    return res.status(400).json({ error: '非法的资源路径' });
  }
  const d = loadDescriptor(id);
  const full = path.join(d._dir, 'assets', file);
  if (!full.startsWith(path.join(d._dir, 'assets')) || !fs.existsSync(full)) {
    return res.status(404).json({ error: '资源不存在' });
  }
  res.sendFile(full);
}));

// 模板整册预览：上传模板解析 source.pptx 还原「原件每一页」；预设模板渲染 8 类版式效果页
const tplPreviewCache = new Map(); // id -> { mtime, data }
const previewImageCache = new Map(); // source page thumbnail cache
async function sourcePreviewFor(d, id) {
  const sourcePath = path.join(d._dir, 'source.pptx');
  if (!fs.existsSync(sourcePath)) return null;
  const mtime = fs.statSync(sourcePath).mtimeMs;
  let hit = tplPreviewCache.get(id);
  if (!hit || hit.mtime !== mtime) {
    hit = { mtime, data: await parseSourcePages(fs.readFileSync(sourcePath), { mediaDir: path.join(d._dir, '.media') }) };
    tplPreviewCache.set(id, hit);
    if (tplPreviewCache.size > 8) tplPreviewCache.delete(tplPreviewCache.keys().next().value);
  }
  return { mtime, sourcePath, data: hit.data, mediaDir: path.join(d._dir, '.media') };
}

function sourceRolePages(profile, pageCount) {
  const role = profile && profile.roles || {};
  const pageFor = (key, fallback) => {
    const index = Number(role[key] && role[key].sourcePage);
    return Number.isInteger(index) && index >= 0 && index < pageCount ? index : Math.max(0, Math.min(fallback, pageCount - 1));
  };
  return {
    cover: pageFor('cover', 0),
    section: pageFor('section', Math.min(1, pageCount - 1)),
    content: pageFor('content', Math.min(2, pageCount - 1)),
    closing: pageFor('closing', pageCount - 1),
  };
}

app.get('/api/templates/:id/preview', wrap(async (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ error: '非法的模板 id' });
  const d = loadDescriptor(id);
  const source = await sourcePreviewFor(d, id);
  if (source) {
    const profile = loadProfile(id);
    if (req.query.summary === '1') {
      return res.json({
        kind: 'source', name: d.meta.name, canvas: source.data.canvas,
        pageCount: source.data.pages.length, rolePages: sourceRolePages(profile, source.data.pages.length),
      });
    }
    return res.json({ kind: 'source', name: d.meta.name, canvas: source.data.canvas, pages: source.data.pages });
  }
  const samples = [
    { index: 0, type: 'title', title: '演示文稿标题', subtitle: '副标题示例文字' },
    { index: 1, type: 'section', title: '第一章节名', subtitle: '章节导语示例' },
    { index: 2, type: 'bullets', title: '要点页标题', bullets: ['第一条要点内容', '第二条要点内容', '第三条要点内容'] },
    { index: 3, type: 'twoColumn', title: '两栏对比标题', leftTitle: '传统方式', leftBullets: ['人工排版耗时长', '多人协作版式乱'], rightTitle: '智能生成', rightBullets: ['十分钟出初稿', '版式自动统一'] },
    { index: 4, type: 'table', title: '数据表格标题', headers: ['指标', '本季度', '环比'], rows: [['产出效率', '92%', '+18%'], ['版式一致性', '100%', '+7%']] },
    { index: 5, type: 'steps', title: '流程步骤标题', steps: [{ title: '输入主题', desc: '可粘贴参考材料' }, { title: '确认大纲', desc: '逐页流式生成' }, { title: '导出编辑', desc: '下载可编辑 PPTX' }] },
    { index: 6, type: 'quote', quote: '别人熬夜做的，没你十分钟做的好。', author: '卷王PPT' },
    { index: 7, type: 'stats', title: '关键数字', stats: [{ value: '87%', label: '效率提升' }, { value: '10分钟', label: '平均出稿' }] },
  ];
  if (req.query.summary === '1') {
    return res.json({ kind: 'descriptor', name: d.meta.name, canvas: d.canvas, types: samples.map((s) => s.type) });
  }
  res.json({ kind: 'descriptor', name: d.meta.name, canvas: d.canvas, types: samples.map((s) => s.type), scenes: resolve(d, samples, { title: d.meta.name }).slides });
}));

app.get('/api/templates/:id/preview-image/:index', wrap(async (req, res) => {
  const { id } = req.params;
  const index = Number(req.params.index);
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || !Number.isInteger(index) || index < 0) {
    return res.status(400).json({ error: '非法的模板 id 或页码' });
  }
  const d = loadDescriptor(id);
  const source = await sourcePreviewFor(d, id);
  if (!source) return res.status(404).json({ error: '该模板没有可预览的源文件' });
  if (index >= source.data.pages.length) return res.status(404).json({ error: '模板页码不存在' });
  const key = `${id}:${source.mtime}:${index}`;
  let png = previewImageCache.get(key);
  if (!png) {
    const html = pageToHtml(source.data.pages[index], source.data.canvas, source.mediaDir);
    png = await htmlShot.renderToPng(html, { width: 1280, height: 720, scale: 1 });
    previewImageCache.set(key, png);
    if (previewImageCache.size > 32) previewImageCache.delete(previewImageCache.keys().next().value);
  }
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.type('png').send(png);
}));
// 原件预览引用的媒体（首次 preview 时解包到模板目录 .media/ 缓存）
app.get('/api/templates/:id/media/:file', wrap(async (req, res) => {
  const { id, file } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || file !== path.basename(file)) {
    return res.status(400).json({ error: '非法的资源路径' });
  }
  const d = loadDescriptor(id);
  const full = path.join(d._dir, '.media', file);
  if (!full.startsWith(path.join(d._dir, '.media')) || !fs.existsSync(full)) {
    return res.status(404).json({ error: '资源不存在' });
  }
  res.sendFile(full, { dotfiles: 'allow' }); // .media 是点目录，send 默认忽略
}));

app.post('/api/templates/extract', wrap(async (req, res) => {
  const { name, data } = req.body || {};
  if (!data) return res.status(400).json({ error: '请上传 pptx 文件（base64）' });
  const buffer = Buffer.from(data, 'base64');
  res.json(await extractFromPptx(buffer, name || 'uploaded.pptx'));
}));

// 模板分析：逐页渲染证据图 + 机器测量画像 → styleModel（视觉语义层规格），写回
// template-profile.json，与测量字段并列保存。生成端与验收端共用这一份真值。
// 分析是一次性的重活（多模态、几十秒），只在上传保存后或显式重建时触发。
app.post('/api/templates/:id/analyze', wrap(async (req, res) => {
  const d = loadDescriptor(req.params.id);
  const sourcePath = path.join(d._dir, 'source.pptx');
  if (!fs.existsSync(sourcePath)) return res.status(400).json({ error: '该模板没有 source.pptx 原件，无法分析' });
  const profile = loadProfile(d._id);
  if (!profile) return res.status(400).json({ error: '该模板缺少机器测量画像（template-profile.json），无法分析' });
  if (!llmprovider.listActive().vision) {
    return res.status(400).json({ error: '尚未配置视觉模型：请打开右上角「模型设置」为「识图」能力绑定模型' });
  }
  const { model, validation } = await styleModel.analyzeTemplate({
    buffer: fs.readFileSync(sourcePath),
    profile,
    outDir: path.join(d._dir, '.ref'),
    mediaDir: path.join(d._dir, '.media'),
  });
  styleModel.saveStyleModel(d._dir, model, validation);
  res.json({
    ok: true,
    schemaVersion: model.schemaVersion,
    families: (model.families || []).length,
    components: (model.components || []).length,
    validation,
    styleModel: model,
  });
}));

app.post('/api/templates', wrap(async (req, res) => {
  const { stagingId, name } = req.body || {};
  if (!stagingId || !/^[a-f0-9]{16}$/.test(stagingId)) {
    return res.status(400).json({ error: '参数不完整' });
  }
  res.json({ id: saveTemplate(stagingId, name), templates: listDescriptors() });
}));

// 删除一份本地上传的模板（本地维护）→ 返回最新列表
app.delete('/api/templates/:id', wrap(async (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ error: '非法的模板 id' });
  deleteTemplate(id);
  res.json({ ok: true, templates: listDescriptors() });
}));

// ---------- 历史对话任务 ----------
// 每条记录代表一次对话；首次提示词创建任务，后续修改持续更新同一份 deck/doc 快照。
app.get('/api/history', (req, res) => {
  res.json({ items: history.list() });
});

app.get('/api/generate/deck/status', (req, res) => {
  res.json({ job: generationJobs.get() });
});

app.post('/api/new', wrap(async (req, res) => {
  if (generationJobs.isActive() || genDeck.isBusy()) {
    const error = new Error('整册生成尚未结束，完成或失败后再新建演示文稿');
    error.code = 'BUSY';
    throw error;
  }
  const deckVersion = relay.setDeck({ title: '', projectTitle: '', taskId: null, templateId: null, canvas: null, slides: [] });
  const docVersion = relay.setDoc({ markdown: '', title: '' });
  res.json({
    deck: relay.getState(),
    doc: relay.getDoc(),
    history: history.list(),
    deckVersion,
    docVersion,
  });
}));

app.get('/api/history/:id/messages', wrap(async (req, res) => {
  res.json({ messages: history.messagesFor(req.params.id) });
}));
app.post('/api/history/:id/open', wrap(async (req, res) => {
  if (generationJobs.isActive() || genDeck.isBusy()) {
    const error = new Error('整册生成尚未结束，暂时不能切换历史项目');
    error.code = 'BUSY';
    throw error;
  }
  const { meta, deck, doc } = history.load(req.params.id);
  taskSyncSuppressed = true;
  try {
    relay.setDeck({ title: deck.title, projectTitle: meta.title || deck.projectTitle || deck.title, taskId: meta.id, templateId: deck.templateId, canvas: deck.canvas, slides: deck.slides });
    relay.setDoc(doc || { markdown: '', title: '' });
  } finally {
    taskSyncSuppressed = false;
  }
  // Reopening a task is access, not a modification, so it must not move ahead of newer edits.
  // 模板可能已被删除：此时仍可编辑与导出（导出只依赖 canvas），但不能重画
  const templateAvailable = Boolean(deck.templateId && listDescriptors().some((t) => t.id === deck.templateId));
  res.json({ meta, deckTitle: deck.title, pages: deck.slides.length, templateAvailable, hasDoc: Boolean(doc), messages: history.messagesFor(meta.id) });
}));

app.patch('/api/history/:id', wrap(async (req, res) => {
  const item = history.rename(req.params.id, req.body && req.body.title);
  if (relay.getState().taskId === item.id) relay.setProjectTitle(item.title);
  const items = history.list();
  relay.broadcast('history', items);
  res.json({ item, items });
}));

app.delete('/api/history/:id', wrap(async (req, res) => {
  if (relay.getState().taskId === req.params.id) {
    if (generationJobs.isActive() || genDeck.isBusy()) {
      const error = new Error('当前对话正在生成，暂时不能删除');
      error.code = 'BUSY';
      throw error;
    }
    relay.setTaskId(null);
    relay.setDeck({ title: '', projectTitle: '', taskId: null, templateId: null, canvas: null, slides: [] });
    relay.setDoc({ markdown: '', title: '' });
  }
  history.remove(req.params.id);
  const items = history.list();
  relay.broadcast('history', items);
  res.json({ ok: true, items });
}));

// ---------- 配图 ----------
// 配图存储：POST /api/assets（base64/url）→ 存 → 返回可内联的 slide.image 载荷（配图生成未来接入）
app.post('/api/assets', wrap(async (req, res) => {
  const { data, url, ext } = req.body || {};
  let image;
  if (data) image = assets.saveImageBase64(data, ext || 'png');
  else if (url) image = await assets.saveImageFromUrl(url);
  else return res.status(400).json({ error: '请提供 data(base64) 或 url' });
  res.json(image);
}));

// 生成配图文件（slide.image.url 引用）
app.get('/api/assets/:file', wrap(async (req, res) => {
  const full = assets.resolveAsset(req.params.file);
  res.sendFile(full);
}));

// ---------- 素材（阶段0） ----------
// 浏览器拖拽上传参考素材：base64 存盘（保留原文件名）。生成大纲/整册时服务端自动读取文本类素材折进输入。
app.post('/api/materials', wrap(async (req, res) => {
  const { name, data } = req.body || {};
  if (!data) return res.status(400).json({ error: '请提供文件数据（base64）' });
  const saved = materials.saveMaterial(name, data);
  res.json(saved);
}));

// ---------- 演示态读取（浏览器刷新/重连恢复用） ----------
app.get('/api/deck', (req, res) => {
  res.json(relay.getState());
});

app.get('/api/doc', (req, res) => {
  res.json(relay.getDoc());
});

// The score is derived from actual SVG geometry, typefaces, colors and image
// slots. It is exposed both for UI feedback and automated regression runs.
app.get('/api/deck/style-score', wrap(async (req, res) => {
  const state = relay.getState();
  if (!state.templateId) return res.json({ available: false, reason: '当前还没有生成中的演示文稿' });
  const profile = loadProfile(state.templateId);
  if (!profile) return res.json({ available: false, reason: '当前模板尚未提取参考画像' });
  res.json({ available: true, ...scoreDeck({ profile, slides: state.slides }) });
}));

// ---------- 浏览器就地编辑 ----------
// 把改后的整页 SVG 归一清洗后落权威 deck 并广播（预览==导出消费同一份）。
app.post('/api/deck/slide', wrap(async (req, res) => {
  const { index, svg, slide: rawSlide, themeId, templateId } = req.body || {};
  const idx = Number(index);
  if (!(idx >= 0)) return res.status(400).json({ error: 'index 非法' });
  const raw = (svg !== undefined) ? { svg } : rawSlide;
  if (!raw) return res.status(400).json({ error: '缺少 svg' });
  const state = relay.getState();
  const d = loadDescriptor(themeId || templateId || state.templateId);
  const total = Math.max(state.slides.length, idx + 1);
  const slide = normalize.normalizeSlide(raw, idx, total);
  const version = relay.setSlide(idx, slide, d.canvas);
  res.json({ index: idx, slide, canvas: d.canvas, version });
}));

// ---------- 模型供应商（多供应商 × 多模型 × 能力绑定） ----------
// 有绑定「文本」默认模型（或 OPENAI_* 环境变量）即可生成大纲与整册。
// 生成结果一律经既有 normalizeOutline / normalizeSlide + relay 落库，preview==export 与 SSE 完全不变。

// 一次性拉取设置面板所需全部数据：能力枚举 + 供应商模板（投影）+ 已配实例 + 能力绑定
app.get('/api/providers', (req, res) => {
  res.json({
    capabilities: llmprovider.CAPABILITIES,
    capabilityLabels: llmprovider.CAPABILITY_LABELS,
    templates: llmprovider.PROVIDER_TEMPLATES.map((t) => ({
      id: t.id, name: t.name, baseURL: t.baseURL, keyUrl: t.keyUrl || null, noKey: Boolean(t.noKey),
      short: t.short || t.name[0], color: t.color || '#64748b', tagline: t.tagline || '', tag: t.tag || '',
    })),
    instances: llmprovider.listInstances(),
    active: llmprovider.listActive(),
  });
});

// 新建实例：{ preset?, name?, baseURL?, apiKey? } → { id }
app.post('/api/instances', wrap(async (req, res) => {
  const inst = llmprovider.createInstance(req.body || {});
  res.json({ id: inst.id });
}));

// 改实例（patch，空串=不改）：{ name?, apiKey?, enabled?, baseURL? }
app.put('/api/instances/:id', wrap(async (req, res) => {
  llmprovider.updateInstance(req.params.id, req.body || {});
  res.json({ ok: true });
}));

// 删实例（连带清理指向它的 active 绑定）
app.delete('/api/instances/:id', wrap(async (req, res) => {
  llmprovider.deleteInstance(req.params.id);
  res.json({ ok: true });
}));

// 连接测试（存库前先测）：body 可带 { baseURL?, apiKey? } 覆盖 → { ok, resolvedBaseURL, suggestedBaseURL }
app.post('/api/instances/:id/test', wrap(async (req, res) => {
  res.json(await llmprovider.testInstance(req.params.id, req.body || {}));
}));

// 单模型实测（真实收发一条消息，打 lastTest 标记）：{ model } → { ok, model, ... } | { ok:false, model, error }
app.post('/api/instances/:id/test-model', wrap(async (req, res) => {
  res.json(await llmprovider.testModel(req.params.id, req.body?.model));
}));

// 批量实测该实例下 enabled 的 chat/vision 模型 → { results: [...] }
app.post('/api/instances/:id/test-models', wrap(async (req, res) => {
  res.json(await llmprovider.testModels(req.params.id));
}));

// 从远端 /models 拉列表（只读不写库）→ { ids, existing, suggestedBaseURL }
app.post('/api/instances/:id/remote-models', wrap(async (req, res) => {
  res.json(await llmprovider.peekRemoteModels(req.params.id));
}));

// 加/改模型（upsert）：{ id:<modelId>, caps?, enabled? } → { models }
app.post('/api/instances/:id/models', wrap(async (req, res) => {
  const { id, caps, enabled } = req.body || {};
  res.json({ models: llmprovider.addModel(req.params.id, id, caps, enabled) });
}));

// 删模型（连带清理指向它的 active 绑定）：{ model } 或 ?model= → { models }
app.delete('/api/instances/:id/models', wrap(async (req, res) => {
  const model = req.body?.model || req.query.model;
  res.json({ models: llmprovider.removeModel(req.params.id, model) });
}));

// 设能力绑定：{ capability, instance, model } → { ok, active }
app.post('/api/active', wrap(async (req, res) => {
  const { capability, instance, model } = req.body || {};
  llmprovider.setActiveBinding(capability, instance, model);
  res.json({ ok: true, active: llmprovider.listActive() });
}));

// 生成 / 修订内容大纲：带 comments → 批注改稿（复用 normalizeComments 剔除失效引用）；否则按 topic 首次生成。
// 归一后写权威 doc → SSE 'doc' 推浏览器实时渲染。
app.post('/api/generate/outline', wrap(async (req, res) => {
  if (!llmprovider.listActive().chat) {
    return res.status(400).json({ error: '尚未配置模型：请打开右上角「模型设置」添加供应商并绑定「文本」默认模型' });
  }
  const { topic, pages, materials: pastedMaterials, comments } = req.body || {};
  let markdown;
  if (Array.isArray(comments) && comments.length) {
    const cur = relay.getDoc().markdown;
    const clean = normalizeOutline.normalizeComments(comments, cur); // 剔除已失效引用（quote 不在当前大纲中）
    if (clean.length === 0) return res.status(400).json({ error: '批注均已失效（引用不在当前大纲中）' });
    const existingTask = relay.getState().taskId;
    ensureCurrentTask({ title: relay.getDoc().title || '演示文稿', prompt: relay.getDoc().title || '演示文稿' });
    if (existingTask) appendTaskMessage('user', clean.map((c) => `引用：${c.quote}\n修改：${c.comment}`).join('\n\n'));
    markdown = await genOutline.reviseOutline({ markdown: cur, comments: clean });
  } else {
    const prompt = String(topic || '').trim();
    if (!prompt) return res.status(400).json({ error: '请先输入演示主题' });
    const existingTask = relay.getState().taskId;
    ensureCurrentTask({ title: prompt, prompt });
    if (existingTask) appendTaskMessage('user', prompt);
    // 把已上传的文本类素材内容折进生成输入（服务端自己读素材）
    const mat = materials.readMaterialsText();
    const merged = [pastedMaterials, mat.text].filter(Boolean).join('\n\n') || undefined;
    markdown = await genOutline.generateOutline({ topic: prompt, pages, materials: merged });
  }
  const o = normalizeOutline.normalizeOutline({ markdown });
  const version = relay.setDoc({ markdown: o.markdown, title: o.title });
  res.json({ ...o, version });
}));

// 按主题 + 定稿大纲逐页生成整册 SVG。请求只创建任务，生成在后台继续，进度经 SSE/状态接口恢复。
app.post('/api/generate/deck', wrap(async (req, res) => {
  if (!llmprovider.listActive().chat) {
    return res.status(400).json({ error: '尚未配置模型：请打开右上角「模型设置」添加供应商并绑定「文本」默认模型' });
  }
  if (generationJobs.isActive()) return res.status(409).json({ error: '已有整册生成任务正在运行' });

  const { themeId, templateId } = req.body || {};
  const md = relay.getDoc().markdown;
  if (!md || !md.trim()) return res.status(400).json({ error: '还没有内容大纲，请先在阶段1 生成并定稿' });
  const theme = loadTheme(themeId || templateId);
  const spec = buildSpec(theme, loadThemeLayouts(theme.id));
  const profile = loadProfile(theme.id);
  const { title, sections } = genDeck.splitOutline(md);
  const total = sections.length;
  if (!total) return res.status(400).json({ error: '大纲中没有可生成的页面' });
  const model = profile ? styleModel.loadStyleModel(theme._dir) : null;
  const hints = renderHints(model);
  const effProfile = profile ? { ...profile, tokens: styleModel.resolveTokens(profile, model, theme.palette && theme.palette.primary) } : null;
  const plan = planDeck({ styleModel: model, sections, profile: effProfile });
  const refLoader = refPageLoader(theme._dir);
  const wantImages = !!req.body?.images;

  genDeck.acquire();
  let jobStarted = false;
  try {
    ensureCurrentTask({ title, prompt: relay.getDoc().title || title });
    const currentTask = relay.getState();
    const taskId = currentTask.taskId;
    const projectTitle = currentTask.projectTitle || title;
    const job = generationJobs.start({ title, templateId: theme.id, total }, async (reportProgress) => {
      try {
        relay.setDeck({ title, projectTitle, taskId, templateId: theme.id, canvas: theme.canvas, slides: [] });
        history.updateTask(taskId, { deck: relay.getState(), doc: relay.getDoc(), templateName: theme.name || theme.id });
        let artDirection = null;
        let briefs = null;
        if (profile && wantImages) {
          reportProgress(0, [], '正在分析配图方案');
          artDirection = await genDeck.deckArtDirection({ docTitle: title, sections, profile, cacheKey: `${theme.id}::${md}` });
          reportProgress(0, [], '正在规划每页配图');
          briefs = await genDeck.deckImageBriefs({ docTitle: title, sections, cacheKey: `${theme.id}::${md}::briefs` });
        }
        const recovered = [];
        for (let i = 0; i < total; i++) {
          const section = sections[i];
          reportProgress(i, recovered, `正在生成第 ${i + 1} / ${total} 页`);
          const profilePolicy = spec.imagePolicy || { enabled: wantImages, roles: ['cover', 'section', 'closing'], size: '1024x1024', prompt: artDirection || profile?.imageStyle };
          const imageData = profile ? await genDeck.generateSlideImage({ role: section.role, index: i, docTitle: title, section, policy: profilePolicy, brief: briefs ? briefs[i] : null }) : null;
          const pagePlan = plan.pages[i];
          const diag = {};
          let svg = effProfile ? renderTemplateSlide({ profile: effProfile, templateDir: theme._dir, section, role: section.role, index: i, total, imageData, docTitle: title, plan: pagePlan, hints, diag }) : null;
          if (!svg) {
            svg = await genDeck.generateSlideSvg({ docTitle: title, section, role: section.role, index: i, total, spec, theme, styleModel: model, plan: pagePlan, referenceImages: refLoader(pagePlan) });
            svg = await genDeck.addGeneratedImage(svg, { role: section.role, index: i, docTitle: title, section, policy: spec.imagePolicy });
          }
          const slide = normalize.normalizeSlide({
            svg, role: section.role, title: section.heading,
            meta: { familyId: pagePlan.familyId, variantId: pagePlan.variantId, evidence: pagePlan.evidence, referencePageIndexes: pagePlan.referencePageIndexes, styleModelVersion: plan.styleModelVersion, ...(diag.reason ? { capacityOverflow: diag.reason } : {}) },
          }, i, total);
          if (slide._recovered) recovered.push(i);
          relay.setSlide(i, slide, theme.canvas);
          reportProgress(i + 1, recovered, `已完成 ${i + 1} / ${total} 页`);
        }
        return { themeId: theme.id, pages: total, recovered, renderer: profile ? 'template-profile' : 'free-svg', styleScore: profile ? scoreDeck({ profile, slides: relay.getState().slides }) : null };
      } finally {
        genDeck.release();
      }
    });
    jobStarted = true;
    res.status(202).json({ job });
  } catch (error) {
    if (!jobStarted) genDeck.release();
    throw error;
  }
}));
// 单页重生成：按当前大纲第 index 段重画（可带 feedback 修改意见）→ setSlide 覆盖该页。
app.post('/api/generate/slide', wrap(async (req, res) => {
  if (!llmprovider.listActive().chat) {
    return res.status(400).json({ error: '尚未配置模型：请打开右上角「模型设置」添加供应商并绑定「文本」默认模型' });
  }
  const { index, feedback, themeId, templateId } = req.body || {};
  const idx = Number(index);
  if (!(idx >= 0)) return res.status(400).json({ error: 'index 非法' });
  const md = relay.getDoc().markdown;
  if (!md || !md.trim()) return res.status(400).json({ error: '还没有内容大纲' });
  const state = relay.getState();
  const theme = loadTheme(themeId || templateId || state.templateId);
  const spec = buildSpec(theme, loadThemeLayouts(theme.id));
  const profile = loadProfile(theme.id);
  const { title, sections } = genDeck.splitOutline(md);
  const total = Math.max(sections.length, idx + 1);
  const section = sections[idx];
  if (!section) return res.status(400).json({ error: `大纲中没有第 ${idx + 1} 页对应的内容` });
  const model = profile ? styleModel.loadStyleModel(theme._dir) : null;
  const hints = renderHints(model);
  const effProfile = profile ? { ...profile, tokens: styleModel.resolveTokens(profile, model, theme.palette && theme.palette.primary) } : null;
  const plan = planDeck({ styleModel: model, sections, profile: effProfile });
  const pagePlan = plan.pages[idx];
  const refLoader = refPageLoader(theme._dir);

  genDeck.acquire();
  try {
    const hadTask = Boolean(relay.getState().taskId);
    ensureCurrentTask({ title, prompt: title });
    if (feedback) appendTaskMessage('user', `第 ${idx + 1} 页修改意见：${feedback}`);
    else if (hadTask) appendTaskMessage('user', `重新生成第 ${idx + 1} 页`);
    // Match the deck's imagery choice on single-slide redraw (fidelity by default).
    const wantImages = !!(req.body && req.body.images);
    let artDirection = null;
    let briefs = null;
    if (profile && wantImages) {
      artDirection = await genDeck.deckArtDirection({ docTitle: title, sections, profile, cacheKey: `${theme.id}::${md}` });
      briefs = await genDeck.deckImageBriefs({ docTitle: title, sections, cacheKey: `${theme.id}::${md}::briefs` });
    }
    const profilePolicy = spec.imagePolicy || { enabled: wantImages, roles: ['cover', 'section', 'closing'], size: '1024x1024', prompt: artDirection || profile?.imageStyle };
    const imageData = profile ? await genDeck.generateSlideImage({ role: section.role, index: idx, docTitle: title, section, policy: profilePolicy, brief: briefs ? briefs[idx] : null }) : null;
    // 用户给了修改意见时，确定性渲染器无从理解自然语言：直接把「上一版 SVG + 家族约束 + 意见」
    // 交给模型做局部修复。没有意见且有确定性实现时，才走稳定渲染。
    const prevSlide = relay.getState().slides && relay.getState().slides[idx];
    const previousSvg = feedback && prevSlide && prevSlide.svg ? prevSlide.svg : null;
    const diag = {};
    let svg = (!feedback && effProfile)
      ? renderTemplateSlide({ profile: effProfile, templateDir: theme._dir, section, role: section.role, index: idx, total, imageData, docTitle: title, plan: pagePlan, hints, diag })
      : null;
    if (!svg) {
      svg = await genDeck.generateSlideSvg({ docTitle: title, section, role: section.role, index: idx, total, spec, theme, feedback, styleModel: model, plan: pagePlan, referenceImages: refLoader(pagePlan), previousSvg });
      svg = await genDeck.addGeneratedImage(svg, { role: section.role, index: idx, docTitle: title, section, policy: spec.imagePolicy });
    }
    const slide = normalize.normalizeSlide({
      svg, role: section.role, title: section.heading,
      meta: { familyId: pagePlan.familyId, variantId: pagePlan.variantId, evidence: pagePlan.evidence, referencePageIndexes: pagePlan.referencePageIndexes, styleModelVersion: plan.styleModelVersion, ...(diag.reason ? { capacityOverflow: diag.reason } : {}) },
    }, idx, total);
    relay.setSlide(idx, slide, theme.canvas);
    res.json({ index: idx, recovered: slide._recovered ? [idx] : [], renderer: profile ? 'template-profile' : 'free-svg', styleScore: profile ? scoreDeck({ profile, slides: relay.getState().slides }) : null });
  } finally {
    genDeck.release();
  }
}));

// ---------- 浏览器：服务器推送（SSE） ----------
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const unsubscribe = relay.subscribe(res);
  req.on('close', unsubscribe);
  res.write('retry: 3000\n\n');
  // 先订阅再回放快照，避免生成事件恰好发生在快照与订阅之间而丢失。
  res.write(`event: deck\ndata: ${JSON.stringify(relay.getState())}\n\n`);
  res.write(`event: doc\ndata: ${JSON.stringify(relay.getDoc())}\n\n`);
  res.write(`event: history\ndata: ${JSON.stringify(history.list())}\n\n`);
  const job = generationJobs.get();
  if (job) res.write(`event: generation\ndata: ${JSON.stringify(job)}\n\n`);
});

app.post('/api/export', wrap(async (req, res) => {
  const { slides, title, themeId, templateId, canvas } = req.body;
  if (!Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ error: '没有可导出的幻灯片' });
  }
  // SVG-as-IR：每页 slide.svg 经 svgToScene 编译为原生 pptx 对象，无需 Chrome 栅格化
  // 模板可能已删除（历史册）：导出只依赖 canvas 与 slide.svg 本身，故降级继续，
  // 不能因为模板没了就导不出历史内容。
  let id = themeId || templateId || '';
  let cv = coerceCanvas(canvas);
  try {
    const d = loadDescriptor(id);
    id = d._id;
    cv = cv || d.canvas;
  } catch (e) {
    if (e.code !== 'TEMPLATE_NOT_FOUND') throw e;
  }
  const buf = await buildPptx(slides, title, id, cv ? { canvas: cv } : undefined);
  const filename = encodeURIComponent((title || 'slides') + '.pptx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.send(Buffer.from(buf));
}));

// body-parser 等中间件抛出的错误兜底：返回 JSON，避免默认 HTML 错误页让前端只能显示状态码
app.use((err, req, res, next) => {
  // 响应头已发出（SSE 流中、sendFile 传输中途客户端断开等）不能再写 JSON：
  // 交回默认处理器断开连接即可，否则这里二次抛错会把整个进程打挂
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status === 413) {
    const hint = req.path === '/api/templates/extract' ? '模板文件需小于 20MB' : '请求体过大';
    return res.status(413).json({ error: hint });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体不是合法 JSON' });
  }
  res.status(status).json({ error: err.message || '服务器内部错误' });
});

function start(port = Number(process.env.PORT) || 3210) {
  return new Promise((resolveStart) => {
    const server = app.listen(port, () => {
      const actual = server.address().port;
      try {
        fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
        fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ port: actual, pid: process.pid }), 'utf8');
      } catch { /* 运行时文件写失败不致命，CLI 可退回 --port/PORT */ }
      const ping = setInterval(() => relay.pingAll(), 20000);
      ping.unref(); // 不因心跳阻止进程退出
      const cleanupRuntime = () => { try { fs.unlinkSync(RUNTIME_FILE); } catch { /* 已删则忽略 */ } };
      server.on('close', () => { clearInterval(ping); cleanupRuntime(); });
      // `king-ppt stop` 用 SIGTERM 终止；默认动作会跳过 server.close 的清理，
      // 故显式在退出前删掉运行时文件，避免残留 server.json 误导下条 CLI 命令连到死端口。
      const onSignal = () => { cleanupRuntime(); process.exit(0); };
      process.once('SIGTERM', onSignal);
      process.once('SIGINT', onSignal);
      resolveStart({ server, port: actual });
    });
  });
}

module.exports = { app, start, relay };
