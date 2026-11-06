const path = require('path');
const fs = require('fs');
const express = require('express');
const { buildPptx } = require('./pptx');
const { loadDescriptor, listDescriptors, loadTheme, loadThemeLayouts, loadProfile, deleteTemplate } = require('./descriptor');
const { resolve } = require('./layout-resolver'); // 仅供旧模板画廊 sample/preview 路由；P3 主题系统落地后连同这些路由一并移除
const assets = require('./assets');
const { extractFromPptx, saveTemplate } = require('./extract');
const { parseSourcePages } = require('./pptx-pages');
const normalize = require('./normalize');
const normalizeOutline = require('./normalize-outline');
const materials = require('./materials');
const { buildSpec } = require('./spec');
const { createRelay } = require('./relay');
const { RUNTIME_FILE } = require('./paths');
const llmprovider = require('./llmprovider');
const genOutline = require('./generate-outline');
const genDeck = require('./generate-deck');
const { renderTemplateSlide } = require('./template-renderer');
const reverseSpecMod = require('./reverse-spec');
const { scoreDeck } = require('./style-score');

const app = express();
const relay = createRelay(); // 演示态存储（deck/doc）+ SSE 广播总线

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
app.get('/api/templates/:id/preview', wrap(async (req, res) => {
  const { id } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return res.status(400).json({ error: '非法的模板 id' });
  const d = loadDescriptor(id);
  const sourcePath = path.join(d._dir, 'source.pptx');
  if (fs.existsSync(sourcePath)) {
    const mtime = fs.statSync(sourcePath).mtimeMs;
    let hit = tplPreviewCache.get(id);
    if (!hit || hit.mtime !== mtime) {
      hit = { mtime, data: await parseSourcePages(fs.readFileSync(sourcePath), { mediaDir: path.join(d._dir, '.media') }) };
      tplPreviewCache.set(id, hit);
      if (tplPreviewCache.size > 8) tplPreviewCache.delete(tplPreviewCache.keys().next().value);
    }
    return res.json({ kind: 'source', name: d.meta.name, canvas: hit.data.canvas, pages: hit.data.pages });
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
  res.json({
    kind: 'descriptor',
    name: d.meta.name,
    canvas: d.canvas,
    types: samples.map((s) => s.type),
    scenes: resolve(d, samples, { title: d.meta.name }).slides,
  });
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

// 视觉反推：源模板逐页渲染图 + 机器测量画像 → TEMPLATE_SPEC（视觉语义层规格）。
// 产物存模板目录 template-spec.json，供生成端（版式语法旋钮）与 QA 端（自检闭环）共用。
app.post('/api/templates/:id/reverse-spec', wrap(async (req, res) => {
  const d = loadDescriptor(req.params.id);
  const sourcePath = path.join(d._dir, 'source.pptx');
  if (!fs.existsSync(sourcePath)) return res.status(400).json({ error: '该模板没有 source.pptx 原件，无法反推' });
  const profile = loadProfile(d._id);
  const { spec } = await reverseSpecMod.reverseSpec({
    buffer: fs.readFileSync(sourcePath),
    profile,
    outDir: path.join(d._dir, '.reverse'),
    mediaDir: path.join(d._dir, '.media'),
    specDir: d._dir,
  });
  res.json({ ok: true, spec });
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
    markdown = await genOutline.reviseOutline({ markdown: cur, comments: clean });
  } else {
    // 把已上传的文本类素材内容折进生成输入（服务端自己读素材）
    const mat = materials.readMaterialsText();
    const merged = [pastedMaterials, mat.text].filter(Boolean).join('\n\n') || undefined;
    markdown = await genOutline.generateOutline({ topic, pages, materials: merged });
  }
  const o = normalizeOutline.normalizeOutline({ markdown });
  const version = relay.setDoc({ markdown: o.markdown, title: o.title });
  res.json({ ...o, version });
}));

// 按主题 + 定稿大纲，逐页流式生成整册 SVG。大纲取自当前权威 doc；每页 setSlide → SSE 'slide' 实时冒页。
app.post('/api/generate/deck', wrap(async (req, res) => {
  if (!llmprovider.listActive().chat) {
    return res.status(400).json({ error: '尚未配置模型：请打开右上角「模型设置」添加供应商并绑定「文本」默认模型' });
  }
  const { themeId, templateId } = req.body || {};
  const md = relay.getDoc().markdown;
  if (!md || !md.trim()) return res.status(400).json({ error: '还没有内容大纲，请先在阶段1 生成并定稿' });
  const theme = loadTheme(themeId || templateId);
  const spec = buildSpec(theme, loadThemeLayouts(theme.id));
  const profile = loadProfile(theme.id);
  const { title, sections } = genDeck.splitOutline(md);
  const total = sections.length;
  const tplSpec = reverseSpecMod.loadTemplateSpec(theme._dir); // 反推规格（存在则驱动版式语法旋钮）
  // 规格生效的整册画像：令牌校正（视觉判定的 bg/ink + 模板实测主色）
  const effProfile = tplSpec ? reverseSpecMod.applySpecTokens(profile, tplSpec, theme.palette && theme.palette.primary) : profile;

  genDeck.acquire();
  try {
    // 先落空册（含 title/templateId/canvas），浏览器据此切到出片步等待逐页冒出
    relay.setDeck({ title, templateId: theme.id, canvas: theme.canvas, slides: [] });
    // Fidelity-first: by default封面/章节复刻模板烘焙设计（imageData=null→baked）。
    // 仅当请求显式开启 images 时，才让文本模型写 art-direction + 每页专属视觉 brief，
    // 再生成 AI 插画（封面/章节/结尾各配本页立意的画面，共享同一风格锚点）。
    const wantImages = !!(req.body && req.body.images);
    let artDirection = null;
    let briefs = null;
    if (profile && wantImages) {
      artDirection = await genDeck.deckArtDirection({ docTitle: title, sections, profile, cacheKey: `${theme.id}::${md}` });
      briefs = await genDeck.deckImageBriefs({ docTitle: title, sections, cacheKey: `${theme.id}::${md}::briefs` });
    }
    const recovered = [];
    for (let i = 0; i < total; i++) {
      const s = sections[i];
      const profilePolicy = spec.imagePolicy || { enabled: wantImages, roles: ['cover', 'section', 'closing'], size: '1024x1024', prompt: artDirection || profile?.imageStyle };
      const imageData = profile ? await genDeck.generateSlideImage({ role: s.role, index: i, docTitle: title, section: s, policy: profilePolicy, brief: briefs ? briefs[i] : null }) : null;
      let svg = profile ? renderTemplateSlide({ profile, templateDir: theme._dir, section: s, role: s.role, index: i, total, imageData, docTitle: title, spec: tplSpec }) : null;
      if (!svg) {
        svg = await genDeck.generateSlideSvg({ docTitle: title, section: s, role: s.role, index: i, total, spec });
        svg = await genDeck.addGeneratedImage(svg, { role: s.role, index: i, docTitle: title, section: s, policy: spec.imagePolicy });
      }
      const slide = normalize.normalizeSlide({ svg, role: s.role, title: s.heading }, i, total);
      if (slide._recovered) recovered.push(i);
      relay.setSlide(i, slide, theme.canvas);
    }
    res.json({ themeId: theme.id, pages: total, recovered, renderer: profile ? 'template-profile' : 'free-svg', styleScore: profile ? scoreDeck({ profile, slides: relay.getState().slides }) : null });
  } finally {
    genDeck.release();
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

  genDeck.acquire();
  try {
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
    let svg = profile ? renderTemplateSlide({ profile, templateDir: theme._dir, section, role: section.role, index: idx, total, imageData, docTitle: title, spec: reverseSpecMod.loadTemplateSpec(theme._dir) }) : null;
    if (!svg) {
      svg = await genDeck.generateSlideSvg({ docTitle: title, section, role: section.role, index: idx, total, spec, feedback });
      svg = await genDeck.addGeneratedImage(svg, { role: section.role, index: idx, docTitle: title, section, policy: spec.imagePolicy });
    }
    const slide = normalize.normalizeSlide({ svg, role: section.role, title: section.heading }, idx, total);
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
  res.write('retry: 3000\n\n');
  // 新连接立即得到当前整册（含各页 scene），支持刷新/重连恢复
  res.write(`event: deck\ndata: ${JSON.stringify(relay.getState())}\n\n`);
  // 同时回放当前内容大纲，后连接的浏览器也能立即拿到阶段1 的 doc
  res.write(`event: doc\ndata: ${JSON.stringify(relay.getDoc())}\n\n`);
  const unsubscribe = relay.subscribe(res);
  req.on('close', unsubscribe);
});

app.post('/api/export', wrap(async (req, res) => {
  const { slides, title, themeId, templateId } = req.body;
  if (!Array.isArray(slides) || slides.length === 0) {
    return res.status(400).json({ error: '没有可导出的幻灯片' });
  }
  // SVG-as-IR：每页 slide.svg 经 svgToScene 编译为原生 pptx 对象，无需 Chrome 栅格化
  const d = loadDescriptor(themeId || templateId);
  const buf = await buildPptx(slides, title, d._id, { canvas: d.canvas });
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
