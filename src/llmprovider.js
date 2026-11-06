// LLM Provider 抽象层：多供应商实例 × 多模型，按「能力」路由。
// 能力: chat(文本对话) / vision(多模态识图) / image(生图)。video/music 已退役——本项目做 PPT，不预留。
//
// 配置 schema（KING_PPT_HOME/config.json，由通用 config.js 整存整取）：
// {
//   instances: {
//     [id]: { id, preset, name, adapter, baseURL, apiKey, enabled,
//             models: [{ id, caps: ['chat','vision','image'], enabled, lastTest, lastError }] }
//   },
//   active: { [capability]: { instance: id, model: modelId } }
// }
const crypto = require('crypto');
const store = require('./config');

const REQUEST_TIMEOUT_MS = 120000; // 出站请求硬超时：上游僵死时快速失败，及时释放 generate-outline 的 inflight 锁

const CAPABILITIES = ['chat', 'vision', 'image'];
const CAPABILITY_LABELS = { chat: '文本对话', vision: '多模态识图', image: '图像生成' };

// ---------- 供应商模板（一键添加用；自定义中转站走 custom） ----------
// 全部走 OpenAI 兼容端点（/chat/completions）。模板不预置模型（models 恒为空），
// 模型由用户手动添加或从接口 /models 拉取后多选。
const PROVIDER_TEMPLATES = [
  {
    id: 'kimi', name: 'Kimi（月之暗面）', adapter: 'openai',
    baseURL: 'https://api.moonshot.cn/v1',
    models: [],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    short: 'K', color: '#0f0f1a', tagline: '长文本强', tag: '长文本',
  },
  {
    // 国内站 api.minimaxi.com；国际站为 api.minimax.io，两边 API Key 不通用
    id: 'minimax', name: 'MiniMax', adapter: 'openai',
    baseURL: 'https://api.minimaxi.com/v1',
    models: [],
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    short: 'M', color: '#ff3b30', tagline: 'M 系列旗舰', tag: '文本/识图',
  },
  {
    id: 'ollama', name: '本地 Ollama', adapter: 'openai',
    baseURL: 'http://localhost:11434/v1',
    models: [],
    noKey: true,
    short: 'Ol', color: '#111827', tagline: '隐私本地', tag: '隐私本地',
  },
  {
    id: 'custom', name: '自定义 / 中转站', adapter: 'openai',
    baseURL: '',
    models: [],
    short: '＋', color: '#64748b', tagline: '任意 OpenAI 兼容端点', tag: '中转/私有',
  },
];

function getTemplate(id) {
  return PROVIDER_TEMPLATES.find((t) => t.id === id) || null;
}

// ---------- 错误 ----------
function fail(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ---------- 状态 ----------
function getState() {
  const cfg = store.getConfig();
  cfg.instances = cfg.instances || {};
  cfg.active = cfg.active || {};
  return cfg;
}

// ---------- 实例 CRUD ----------
function createInstance({ preset, name, baseURL, apiKey } = {}) {
  const state = getState();
  const tpl = preset ? getTemplate(preset) : null;
  if (preset && !tpl) throw fail(`未知的供应商模板: ${preset}`, 'NO_MODEL_CONFIG');
  if (!tpl && !name) throw fail('自定义供应商需要填写名称', 'NO_MODEL_CONFIG');
  const id = `inst_${crypto.randomBytes(4).toString('hex')}`;
  state.instances[id] = {
    id,
    preset: tpl ? tpl.id : null,
    name: name || tpl.name,
    adapter: tpl ? tpl.adapter : 'openai',
    baseURL: (baseURL ?? tpl?.baseURL ?? '').replace(/\/$/, ''),
    apiKey: apiKey || '',
    enabled: true,
    models: tpl ? tpl.models.map((m) => ({ ...m, caps: [...m.caps] })) : [],
  };
  store.saveConfig(state);
  return state.instances[id];
}

function updateInstance(id, patch = {}) {
  const state = getState();
  const inst = state.instances[id];
  if (!inst) throw fail(`供应商实例不存在: ${id}`, 'NO_MODEL_CONFIG');
  // 空字符串视为「不修改」
  for (const key of ['name', 'apiKey', 'enabled']) {
    if (patch[key] !== undefined && patch[key] !== '') inst[key] = patch[key];
  }
  if (patch.baseURL !== undefined && patch.baseURL !== '') {
    inst.baseURL = String(patch.baseURL).replace(/\/$/, '');
  }
  store.saveConfig(state);
  return inst;
}

function deleteInstance(id) {
  const state = getState();
  if (!state.instances[id]) throw fail(`供应商实例不存在: ${id}`, 'NO_MODEL_CONFIG');
  delete state.instances[id];
  for (const [cap, b] of Object.entries(state.active)) {
    if (b.instance === id) delete state.active[cap];
  }
  store.saveConfig(state);
}

function addModel(instanceId, modelId, caps = ['chat'], enabled = undefined) {
  const state = getState();
  const inst = state.instances[instanceId];
  if (!inst) throw fail(`供应商实例不存在: ${instanceId}`, 'NO_MODEL_CONFIG');
  if (!modelId || !modelId.trim()) throw fail('模型名不能为空', 'NO_MODEL_CONFIG');
  const id = modelId.trim();
  const existing = inst.models.find((m) => m.id === id);
  if (existing) {
    if (Array.isArray(caps) && caps.length) {
      const cleanCaps = [...new Set(caps)].filter((c) => CAPABILITIES.includes(c));
      if (cleanCaps.length === 0) throw fail('无效的能力标记', 'NO_MODEL_CONFIG');
      existing.caps = cleanCaps; // upsert：精确覆盖能力标记
    }
    if (enabled !== undefined) existing.enabled = Boolean(enabled);
  } else {
    if (!Array.isArray(caps) || caps.length === 0) throw fail('模型至少保留一种能力', 'NO_MODEL_CONFIG');
    const cleanCaps = [...new Set(caps)].filter((c) => CAPABILITIES.includes(c));
    if (cleanCaps.length === 0) throw fail('无效的能力标记', 'NO_MODEL_CONFIG');
    inst.models.push({ id, caps: cleanCaps, enabled: enabled !== false });
  }
  store.saveConfig(state);
  return inst.models;
}

function removeModel(instanceId, modelId) {
  const state = getState();
  const inst = state.instances[instanceId];
  if (!inst) throw fail(`供应商实例不存在: ${instanceId}`, 'NO_MODEL_CONFIG');
  inst.models = inst.models.filter((m) => m.id !== modelId);
  for (const [cap, b] of Object.entries(state.active)) {
    if (b.instance === instanceId && b.model === modelId) delete state.active[cap];
  }
  store.saveConfig(state);
  return inst.models;
}

// 从远端 /models 拉取模型列表（只读，不写库；由前端弹窗让用户多选后再逐个添加）
async function peekRemoteModels(instanceId) {
  const state = getState();
  const inst = state.instances[instanceId];
  if (!inst) throw fail(`供应商实例不存在: ${instanceId}`, 'NO_MODEL_CONFIG');
  const { value: ids, suggestedBaseURL } = await fetchRemoteModelIds(inst);
  return { ids, existing: inst.models.map((m) => m.id), suggestedBaseURL };
}

async function fetchRemoteModelIds(inst) {
  const { baseURL, apiKey } = instAuth(inst);
  const fetchAt = async (candidate) => {
    const resp = await httpGet(`${candidate}/models`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {});
    if (!resp.ok) {
      const err = fail(`拉取模型列表失败 (${resp.status})`, 'LLM_HTTP');
      err.httpStatus = resp.status;
      throw err;
    }
    let data;
    try { data = await resp.json(); } catch {
      const err = fail('服务地址未返回 JSON，请检查 Base URL 是否包含 /v1', 'LLM_HTTP');
      err.httpStatus = 404;
      throw err;
    }
    if (!Array.isArray(data.data)) {
      const err = fail('服务地址未返回 OpenAI 兼容模型列表', 'LLM_HTTP');
      err.httpStatus = 404;
      throw err;
    }
    return data.data.map((m) => m.id).filter(Boolean);
  };
  return probeCandidates(baseURL, fetchAt); // { value: ids, resolvedBaseURL, suggestedBaseURL }
}

// ---------- 能力激活绑定 ----------
function setActiveBinding(capability, instanceId, model) {
  if (!CAPABILITIES.includes(capability)) throw fail(`未知的能力: ${capability}`, 'NO_MODEL_CONFIG');
  const state = getState();
  if (!state.instances[instanceId]) throw fail(`供应商实例不存在: ${instanceId}`, 'NO_MODEL_CONFIG');
  if (!model) throw fail('模型名不能为空', 'NO_MODEL_CONFIG');
  state.active[capability] = { instance: instanceId, model };
  store.saveConfig(state);
  return state.active;
}

// ---------- 解析某能力的生效配置 ----------
function instAuth(inst) {
  const tpl = inst.preset ? getTemplate(inst.preset) : null;
  // 只用实例自己存的 Key，不跨实例回退，否则 A 供应商的 Key 会被误当成 B 的用
  return { baseURL: (inst.baseURL || '').replace(/\/$/, ''), apiKey: inst.apiKey || null, noKey: Boolean(tpl?.noKey) };
}

function resolve(capability) {
  const state = getState();
  let binding = state.active[capability];
  if (!binding && capability === 'vision') binding = state.active.chat;

  if (!binding && capability === 'chat') {
    // 环境变量兜底（无任何 active 绑定时让配了 OPENAI_* 的用户开箱即用）
    const apiKey = process.env.OPENAI_API_KEY || null;
    if (!apiKey) {
      throw fail('尚未配置模型：请打开右上角「模型设置」添加供应商并选择默认模型', 'NO_API_KEY');
    }
    return {
      instance: { name: 'OpenAI' },
      adapter: 'openai',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      baseURL: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
      apiKey,
    };
  }
  if (!binding) {
    throw fail(`尚未为「${CAPABILITY_LABELS[capability]}」能力选择默认模型，请打开右上角「模型设置」`, 'NO_MODEL_CONFIG');
  }
  const inst = state.instances[binding.instance];
  if (!inst) throw fail('默认模型指向的供应商已被删除，请重新选择', 'NO_MODEL_CONFIG');
  if (inst.enabled === false) throw fail(`供应商「${inst.name}」已停用，请在模型设置中启用`, 'NO_MODEL_CONFIG');
  const { baseURL, apiKey, noKey } = instAuth(inst);
  if (!baseURL) throw fail(`供应商「${inst.name}」缺少服务地址（baseURL）`, 'NO_MODEL_CONFIG');
  if (!apiKey && !noKey) {
    throw fail(`未配置「${inst.name}」的 API Key：请打开右上角「模型设置」填写`, 'NO_API_KEY');
  }
  return { instance: inst, adapter: inst.adapter, model: binding.model, baseURL, apiKey };
}

// ---------- HTTP 工具（带硬超时） ----------
// timeoutMs 可按调用覆盖：多模态反推等长任务传更大值（如 300000），其余维持 120s 快速失败
async function postJSON(url, { key, body, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS }) {
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw fail('模型请求超时', 'LLM_TIMEOUT');
    throw fail(`模型连接失败：${e.message}`, 'LLM_HTTP');
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const err = fail(`模型请求失败 (${resp.status}): ${text.slice(0, 300)}`, 'LLM_HTTP');
    err.httpStatus = resp.status;
    throw err;
  }
  try {
    return await resp.json();
  } catch {
    // A web homepage can return HTTP 200 HTML for an API-looking path. Mark it
    // as a not-found candidate so root URLs can still fall through to /v1.
    const err = fail('服务地址未返回 JSON，请检查 Base URL 是否包含 /v1', 'LLM_HTTP');
    err.httpStatus = 404;
    throw err;
  }
}

async function httpGet(url, headers = {}) {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw fail('连接测试超时', 'LLM_TIMEOUT');
    throw fail(`连接失败：${e.message}`, 'LLM_HTTP');
  }
}

// ---------- Base URL 归一化与候选探测（防呆：忘加 /v1） ----------
// 去首尾空白与尾斜杠，剥掉误粘贴的 /chat/completions、/models 后缀
function normalizeBaseURL(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/models$/i, '');
}

// 仅当路径为空（或 /）时追加 +/v1 候选；路径已有 /v\d+ 或其他段则不探测，避免搞错智谱 /api/paas/v4 这类地址
function baseURLCandidates(raw) {
  const u = normalizeBaseURL(raw);
  if (!u) return [];
  let pathname = '';
  try { pathname = new URL(u).pathname; } catch { return [u]; }
  if (!pathname || pathname === '/') return [u, `${u}/v1`];
  return [u];
}

// 依次用候选 baseURL 执行 fn(candidate)，404 时尝试下一个候选，其余错误直接抛出
// 返回 { value, resolvedBaseURL, suggestedBaseURL }（suggestedBaseURL = 实际跑通的地址与用户填写不一致时给出）
async function probeCandidates(rawBase, fn) {
  const candidates = baseURLCandidates(rawBase);
  const raw = String(rawBase || '').trim().replace(/\/+$/, '');
  let lastErr = null;
  for (const candidate of candidates) {
    try {
      const value = await fn(candidate);
      return {
        value,
        resolvedBaseURL: candidate,
        suggestedBaseURL: candidate !== raw ? candidate : null,
      };
    } catch (err) {
      lastErr = err;
      const isLast = candidate === candidates[candidates.length - 1];
      // 404 = 路径不存在，值得试下一个；401/403 = 路径在只是 Key 错；网络错误 = 换地址也没用
      if (err.httpStatus === 404 && !isLast) continue;
      throw err;
    }
  }
  throw lastErr;
}

// ---------- 适配器：OpenAI 兼容 ----------
const openaiAdapter = {
  async chat(ctx, messages, { temperature = 0.7, json = false, maxTokens, timeoutMs } = {}) {
    const body = { model: ctx.model, messages, temperature };
    if (json) body.response_format = { type: 'json_object' };
    if (maxTokens) body.max_tokens = maxTokens;
    let data;
    try {
      data = await postJSON(`${ctx.baseURL}/chat/completions`, { key: ctx.apiKey, body, timeoutMs });
    } catch (e) {
      // 部分网关（如 Kimi k3）只接受固定 temperature：去掉该参数重试一次
      if (!/invalid temperature/i.test(String(e && e.message))) throw e;
      delete body.temperature;
      data = await postJSON(`${ctx.baseURL}/chat/completions`, { key: ctx.apiKey, body, timeoutMs });
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw fail('模型返回内容为空', 'LLM_EMPTY');
    return content;
  },

  async generateImage(ctx, prompt, { size = '1024x1024' } = {}) {
    const data = await postJSON(`${ctx.baseURL}/images/generations`, {
      key: ctx.apiKey,
      body: { model: ctx.model, prompt, n: 1, size },
    });
    const item = data.data?.[0];
    if (!item) throw fail('图像生成返回为空', 'LLM_EMPTY');
    return { url: item.url || null, b64: item.b64_json || null };
  },

  async test(ctx) {
    const resp = await httpGet(`${ctx.baseURL}/models`, ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {});
    if (!resp.ok) {
      const err = fail(`连接测试失败 (${resp.status})`, 'LLM_HTTP');
      err.httpStatus = resp.status;
      throw err;
    }
    try {
      const data = await resp.json();
      if (!data || !Array.isArray(data.data)) {
        const err = fail('服务地址未返回 OpenAI 兼容模型列表', 'LLM_HTTP');
        err.httpStatus = 404;
        throw err;
      }
      return true;
    } catch (err) {
      if (err.code === 'LLM_HTTP') throw err;
      const bad = fail('服务地址未返回 JSON，请检查 Base URL 是否包含 /v1', 'LLM_HTTP');
      bad.httpStatus = 404;
      throw bad;
    }
  },
};

const ADAPTERS = { openai: openaiAdapter };

// ---------- 统一调用入口 ----------
// messages 支持 OpenAI 多模态格式：content 可为 [{type:'text'},{type:'image_url',image_url:{url}}]
async function chat(capability, messages, opts = {}) {
  const ctx = resolve(capability === 'vision' ? 'vision' : 'chat');
  return ADAPTERS[ctx.adapter].chat(ctx, messages, opts);
}

async function generateImage(prompt, opts = {}) {
  const ctx = resolve('image');
  const adapter = ADAPTERS[ctx.adapter];
  if (!adapter.generateImage) {
    throw fail(`供应商「${ctx.instance.name}」暂不支持图像生成`, 'CAPABILITY_NOT_SUPPORTED');
  }
  return adapter.generateImage(ctx, prompt, opts);
}

// ---------- 给前端的安全视图（不回传 key 明文） ----------
// 缩略掩码：前 4 位 + **** + 后 4 位；过短则全掩
function maskKey(key) {
  if (!key) return null;
  const s = String(key);
  return s.length > 8 ? `${s.slice(0, 4)}****${s.slice(-4)}` : '****';
}

function listInstances() {
  const state = getState();
  return Object.values(state.instances).map((inst) => {
    const tpl = inst.preset ? getTemplate(inst.preset) : null;
    const { apiKey, noKey } = instAuth(inst);
    return {
      id: inst.id,
      preset: inst.preset,
      name: inst.name,
      baseURL: inst.baseURL,
      enabled: inst.enabled !== false,
      hasKey: Boolean(apiKey),
      keyPreview: maskKey(apiKey),
      noKey,
      keyUrl: tpl?.keyUrl || null,
      models: inst.models.map((m) => ({
        id: m.id, caps: m.caps, enabled: m.enabled !== false,
        lastTest: m.lastTest || null, lastError: m.lastError || null,
      })),
    };
  });
}

function listActive() {
  const state = getState();
  const active = {};
  for (const cap of CAPABILITIES) {
    const b = state.active[cap] || (cap === 'vision' ? state.active.chat : null);
    const inst = b && state.instances[b.instance];
    active[cap] = b && inst
      ? { instance: inst.id, instanceName: inst.name, model: b.model }
      : cap === 'chat' && !b
        ? (process.env.OPENAI_API_KEY
          ? { instance: null, instanceName: 'OpenAI（环境变量）', model: process.env.OPENAI_MODEL || 'gpt-4o-mini' }
          : null)
        : null;
  }
  return active;
}

// override: 可选的候选 baseURL/apiKey，只用于测试，不写入配置
// 返回 { ok, resolvedBaseURL, suggestedBaseURL }：跑通的是补 /v1 的候选时给出 suggestedBaseURL
async function testInstance(id, override = {}) {
  const state = getState();
  const inst = state.instances[id];
  if (!inst) throw fail(`供应商实例不存在: ${id}`, 'NO_MODEL_CONFIG');
  const auth = instAuth(inst);
  const rawBase = override.baseURL || auth.baseURL;
  const apiKey = override.apiKey || auth.apiKey;
  const { noKey } = auth;
  if (!rawBase) throw fail('请先填写服务地址（baseURL）', 'NO_MODEL_CONFIG');
  if (!apiKey && !noKey) throw fail('请先填写 API Key', 'NO_API_KEY');
  const { resolvedBaseURL, suggestedBaseURL } = await probeCandidates(
    rawBase,
    (candidate) => ADAPTERS[inst.adapter].test({ baseURL: candidate, apiKey }),
  );
  return { ok: true, resolvedBaseURL, suggestedBaseURL };
}

// ---------- 单模型实测（真实发一条短消息，通过则给模型打上已验证标记） ----------
async function testModel(instanceId, modelId) {
  const state = getState();
  const inst = state.instances[instanceId];
  if (!inst) throw fail(`供应商实例不存在: ${instanceId}`, 'NO_MODEL_CONFIG');
  const model = inst.models.find((m) => m.id === modelId);
  if (!model) throw fail(`模型不存在: ${modelId}`, 'NO_MODEL_CONFIG');
  const { baseURL, apiKey, noKey } = instAuth(inst);
  if (!baseURL) throw fail('请先填写服务地址（baseURL）', 'NO_MODEL_CONFIG');
  if (!apiKey && !noKey) throw fail('请先填写 API Key', 'NO_API_KEY');

  const mark = (ok, error) => {
    model.lastTest = ok ? 'ok' : 'fail';
    model.testedAt = Date.now();
    model.lastError = ok ? undefined : error;
    store.saveConfig(state);
  };

  try {
    const { resolvedBaseURL, suggestedBaseURL } = await probeCandidates(
      baseURL,
      (candidate) => ADAPTERS[inst.adapter].chat(
        { baseURL: candidate, apiKey, model: modelId },
        [{ role: 'user', content: '你好，这是一条连通性测试消息，请回复「您好」。' }],
        { temperature: 0 }, // 不限 max_tokens，让模型（含推理模型）自然完成回复
      ).catch((err) => {
        // HTTP 200 但正文为空的极端情况：端点确实返回了结构完整的响应，算通过
        if (err.code === 'LLM_EMPTY') return null;
        throw err;
      }),
    );
    mark(true);
    return { ok: true, model: modelId, resolvedBaseURL, suggestedBaseURL };
  } catch (err) {
    mark(false, err.message);
    return { ok: false, model: modelId, error: err.message };
  }
}

// 批量实测该供应商下所有启用的 chat/vision 模型（生图模型调用即扣费，不测）
async function testModels(instanceId) {
  const state = getState();
  const inst = state.instances[instanceId];
  if (!inst) throw fail(`供应商实例不存在: ${instanceId}`, 'NO_MODEL_CONFIG');
  const targets = inst.models.filter((m) => m.enabled !== false
    && (m.caps.includes('chat') || m.caps.includes('vision')));
  const results = [];
  for (const m of targets) results.push(await testModel(instanceId, m.id));
  return { results };
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_LABELS,
  chat,
  generateImage,
  // 模板与实例
  PROVIDER_TEMPLATES,
  getTemplate,
  listInstances,
  listActive,
  createInstance,
  updateInstance,
  deleteInstance,
  addModel,
  removeModel,
  peekRemoteModels,
  testModel,
  testModels,
  setActiveBinding,
  testInstance,
};
