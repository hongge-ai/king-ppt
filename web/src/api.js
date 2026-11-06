// 前端 API 客户端：REST + SSE 订阅。浏览器与本程序服务端对话，生成由服务端内置完成（server-gen）。
//   浏览器 POST /api/generate/* 触发生成；POST /api/deck/* 直接改演示态（选主题 / 就地编辑）；
//   服务端 SSE /api/stream 推 deck / slide / doc 事件回浏览器实时预览。

async function req(path, { method = 'GET', body, raw = false } = {}) {
  const resp = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).error || ''; } catch { /* 非 JSON 错误体 */ }
    throw new Error(detail || `${method} ${path} → ${resp.status}`);
  }
  return raw ? resp : resp.json();
}

export const api = {
  listThemes: () => req('/api/templates'),
  themeSpec: (id) => req(`/api/templates/${encodeURIComponent(id)}/spec`),
  // 上传模板：先提取+烘焙为暂存（base64），再落库为可复用模板；删除用于本地维护
  extractTemplate: (name, data) => req('/api/templates/extract', { method: 'POST', body: { name, data } }),
  saveTemplate: (stagingId, name) => req('/api/templates', { method: 'POST', body: { stagingId, name } }),
  // 模板分析：逐页渲染证据 + 测量画像 → styleModel（写回 template-profile.json）。
  // 多模态长任务，上传保存后触发一次，后续生成与验收共用这份规格。
  analyzeTemplate: (id) => req(`/api/templates/${encodeURIComponent(id)}/analyze`, { method: 'POST', body: {} }),
  deleteTheme: (id) => req(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 演示态快照（刷新/重连恢复）：deck=整册幻灯片，doc=内容大纲
  deck: () => req('/api/deck'),
  styleScore: () => req('/api/deck/style-score'),
  doc: () => req('/api/doc'),
  // 就地编辑：把改后的整页 SVG 落回服务端（sanitize 后广播，预览==导出消费同一份）
  editSlide: (index, svg) => req('/api/deck/slide', { method: 'POST', body: { index, svg } }),
  // 阶段0：上传参考素材（base64）；服务端存盘，生成大纲/整册时自动参考
  uploadMaterial: (name, data) => req('/api/materials', { method: 'POST', body: { name, data } }),
  // 内置生成（阶段1，server-gen 模式）：多供应商配置读写/测试 + 生成/改稿大纲。生成结果经 SSE 'doc' 回来。
  getProviders: () => req('/api/providers'),
  createInstance: (body) => req('/api/instances', { method: 'POST', body }),
  updateInstance: (id, patch) => req(`/api/instances/${encodeURIComponent(id)}`, { method: 'PUT', body: patch }),
  deleteInstance: (id) => req(`/api/instances/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} }),
  testInstance: (id, override = {}) => req(`/api/instances/${encodeURIComponent(id)}/test`, { method: 'POST', body: override }),
  testModel: (id, model) => req(`/api/instances/${encodeURIComponent(id)}/test-model`, { method: 'POST', body: { model } }),
  testModels: (id) => req(`/api/instances/${encodeURIComponent(id)}/test-models`, { method: 'POST', body: {} }),
  remoteModels: (id) => req(`/api/instances/${encodeURIComponent(id)}/remote-models`, { method: 'POST', body: {} }),
  addModel: (id, model, caps, enabled) => req(`/api/instances/${encodeURIComponent(id)}/models`, { method: 'POST', body: { id: model, caps, enabled } }),
  removeModel: (id, model) => req(`/api/instances/${encodeURIComponent(id)}/models`, { method: 'DELETE', body: { model } }),
  setActive: (capability, instance, model) => req('/api/active', { method: 'POST', body: { capability, instance, model } }),
  generateOutline: ({ topic, pages, materials } = {}) =>
    req('/api/generate/outline', { method: 'POST', body: { topic, pages, materials } }),
  reviseOutline: (comments) =>
    req('/api/generate/outline', { method: 'POST', body: { comments } }),
  // 阶段2：按主题 + 定稿大纲，服务端逐页流式生成整册（结果经 SSE 'deck'/'slide' 实时回来）
  // images=true 时封面/章节用 AI 生成插画；默认 false = 复刻模板原图（忠于模板）
  generateDeck: (themeId, images = false) =>
    req('/api/generate/deck', { method: 'POST', body: { themeId, images } }),
  // 单页重生成（可带修改意见 feedback）
  regenSlide: (index, feedback, images = false) =>
    req('/api/generate/slide', { method: 'POST', body: { index, feedback, images } }),
  // 导出当前 deck 为 .pptx（返回 Blob）
  async export(slides, title, themeId) {
    const resp = await req('/api/export', { method: 'POST', raw: true, body: { slides, title, themeId } });
    return resp.blob();
  },
};

// SSE 订阅：deck（整册）/ slide（单页）/ doc（内容大纲）。返回取消函数。自动重连由浏览器按 retry 处理。
export function subscribe({ onDeck, onSlide, onDoc, onError }) {
  const es = new EventSource('/api/stream');
  es.addEventListener('deck', (e) => { try { onDeck(JSON.parse(e.data)); } catch { /* 忽略坏帧 */ } });
  es.addEventListener('slide', (e) => { try { onSlide(JSON.parse(e.data)); } catch { /* 忽略坏帧 */ } });
  if (onDoc) es.addEventListener('doc', (e) => { try { onDoc(JSON.parse(e.data)); } catch { /* 忽略坏帧 */ } });
  es.onerror = () => { if (onError) onError(); };
  return () => es.close();
}
