// 历史对话：首次发送提示词时创建一个 task，后续对话与 deck/doc 快照持续更新在同一条记录中。
// 打开历史任务会恢复其 relay taskId，因此继续编辑不会产生重复历史项。
//
// 设计要点：
//  - deck/doc 是任务当前状态；messages.json 保存用户提示词和修改意见，打开后可继续同一任务。
//  - 图片按内容哈希去重。烘焙底图以 base64 内联在 slide.svg 里，一册正文页只有 2 KB、
//    封面/章节页却有 1–2 MB，且同模板的章节页底图完全重复。写入时把 data URI 换成
//    {{blob:<sha1>.<ext>}} 占位并单独存 blob，读回时还原为完整 data URI——导出链路无感知。
//  - 保留最近 N 条对话（默认 50），淘汰时回收不再被引用的 blob。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HOME } = require('./paths');

const HISTORY_DIR = path.join(HOME, 'history');
const BLOB_DIR = path.join(HISTORY_DIR, 'blobs');
const KEEP = 50;
const ID_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/;
const DATA_URI_RE = /data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)/g;

function ensureDirs() {
  fs.mkdirSync(BLOB_DIR, { recursive: true });
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function fingerprintForDeck(deck) {
  const slides = Array.isArray(deck && deck.slides) ? deck.slides.filter(Boolean) : [];
  return sha1(JSON.stringify({
    title: deck && deck.title || '',
    templateId: deck && deck.templateId || null,
    svgs: slides.map((slide) => slide.svg || ''),
  })).slice(0, 16);
}

function blobPath(hash, ext) {
  return path.join(BLOB_DIR, hash.slice(0, 2), `${hash}.${ext}`);
}

// 把 svg 里的 data URI 抽成 blob 文件，返回占位后的字符串。
// 同图重复出现只写一次；跨册共享同一份哈希文件。
function externalizeOne(svg) {
  if (typeof svg !== 'string' || !svg.includes('base64,')) return svg;
  return svg.replace(DATA_URI_RE, (_m, ext, b64) => {
    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch { return _m; }
    if (!buf.length) return _m;
    const hash = sha1(buf);
    const file = blobPath(hash, ext);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
    }
    return `{{blob:${hash}.${ext}}}`;
  });
}

// 还原：占位 → 完整 data URI。blob 缺失时保留占位串（渲染会变成空白图，但不崩）。
function inflateOne(svg) {
  if (typeof svg !== 'string' || !svg.includes('{{blob:')) return svg;
  return svg.replace(/\{\{blob:([0-9a-f]{40})\.([a-z]+)\}\}/g, (m, hash, ext) => {
    try {
      const buf = fs.readFileSync(blobPath(hash, ext));
      return `data:image/${ext};base64,${buf.toString('base64')}`;
    } catch { return m; }
  });
}

function mapSlides(slides, fn) {
  if (!Array.isArray(slides)) return [];
  return slides.filter(Boolean).map((s) => ({ ...s, svg: fn(s.svg) }));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, id, 'meta.json'), 'utf8')); } catch { return null; }
}

// 目录 → 列表（新的在前）。损坏条目跳过，不影响其它。
function list() {
  let names = [];
  try { names = fs.readdirSync(HISTORY_DIR, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of names) {
    if (!e.isDirectory() || e.name === 'blobs') continue;
    const m = readMeta(e.name);
    if (!m) continue;
    out.push(m);
  }
  const sorted = out.sort((a, b) => {
    const activityOrder = String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt));
    return activityOrder || String(b.createdAt).localeCompare(String(a.createdAt));
  });
  const seenFingerprints = new Set();
  return sorted.filter((item) => {
    if (!item.fingerprint) return true;
    const legacyDuplicate = item.messageCount === undefined && seenFingerprints.has(item.fingerprint);
    seenFingerprints.add(item.fingerprint);
    return !legacyDuplicate;
  });
}

function findByFingerprint(deck) {
  if (!Array.isArray(deck && deck.slides) || !deck.slides.some(Boolean)) return null;
  const fingerprint = fingerprintForDeck(deck);
  return list().find((item) => item.fingerprint === fingerprint) || null;
}

function taskDirectory(id) {
  if (!ID_RE.test(String(id))) {
    const e = new Error('历史任务 id 非法'); e.code = 'BAD_INPUT'; throw e;
  }
  const dir = path.join(HISTORY_DIR, id);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) {
    const e = new Error('历史任务不存在'); e.code = 'SESSION_NOT_FOUND'; throw e;
  }
  return dir;
}

function writeSnapshot(dir, deck, doc) {
  const slides = Array.isArray(deck && deck.slides) ? deck.slides.filter(Boolean) : [];
  const stored = {
    title: deck && deck.title || '',
    templateId: deck && deck.templateId || null,
    canvas: deck && deck.canvas || null,
    slides: mapSlides(slides, externalizeOne),
  };
  fs.writeFileSync(path.join(dir, 'deck.json'), JSON.stringify(stored));
  const docPath = path.join(dir, 'doc.md');
  if (doc && typeof doc.markdown === 'string' && doc.markdown.trim()) fs.writeFileSync(docPath, doc.markdown, 'utf8');
  else { try { fs.unlinkSync(docPath); } catch { /* no saved outline */ } }
  return { stored, slides };
}

function writeMeta(dir, meta) {
  const metaPath = path.join(dir, 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  try {
    meta.bytes = fs.readdirSync(dir).reduce((n, file) => n + fs.statSync(path.join(dir, file)).size, 0);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  } catch { /* storage size is informational */ }
}

function createTask({ title, prompt, deck = {}, doc = null, templateName = '' }) {
  ensureDirs();
  let id;
  let dir;
  do {
    id = `${stamp()}-${crypto.randomBytes(2).toString('hex')}`;
    dir = path.join(HISTORY_DIR, id);
  } while (fs.existsSync(dir));
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const promptText = String(prompt || '').trim();
  const cleanTitle = String(title || promptText || deck.projectTitle || deck.title || '新对话').trim().slice(0, 80) || '新对话';
  const messages = promptText ? [{ role: 'user', content: promptText, createdAt: now }] : [];
  const { stored, slides } = writeSnapshot(dir, deck, doc);
  fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify(messages, null, 2), 'utf8');
  const meta = {
    id,
    title: cleanTitle,
    prompt: promptText,
    createdAt: now,
    updatedAt: now,
    pages: slides.length,
    templateId: stored.templateId,
    templateName: templateName || stored.templateId || '',
    canvas: stored.canvas,
    hasDoc: Boolean(doc && doc.markdown && doc.markdown.trim()),
    messageCount: messages.length,
    fingerprint: fingerprintForDeck(deck),
    bytes: 0,
  };
  writeMeta(dir, meta);
  prune();
  return meta;
}

function updateTask(id, { deck = {}, doc = null, templateName } = {}) {
  const dir = taskDirectory(id);
  const meta = readMeta(id);
  const { stored, slides } = writeSnapshot(dir, deck, doc);
  meta.pages = slides.length;
  meta.templateId = stored.templateId;
  meta.templateName = templateName || meta.templateName || stored.templateId || '';
  meta.canvas = stored.canvas;
  meta.hasDoc = Boolean(doc && doc.markdown && doc.markdown.trim());
  meta.fingerprint = slides.length ? fingerprintForDeck(deck) : '';
  meta.updatedAt = new Date().toISOString();
  writeMeta(dir, meta);
  prune();
  return meta;
}

function messagesFor(id) {
  const file = path.join(taskDirectory(id), 'messages.json');
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function appendMessage(id, { role = 'user', content } = {}) {
  const dir = taskDirectory(id);
  const text = String(content || '').trim();
  if (!text) return null;
  if (!['user', 'assistant', 'system'].includes(role)) {
    const e = new Error('消息角色非法'); e.code = 'BAD_INPUT'; throw e;
  }
  const messages = messagesFor(id);
  const message = { role, content: text, createdAt: new Date().toISOString() };
  messages.push(message);
  fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify(messages, null, 2), 'utf8');
  const meta = readMeta(id);
  meta.messageCount = messages.length;
  meta.updatedAt = message.createdAt;
  writeMeta(dir, meta);
  return message;
}
// 读回一个对话任务（图片还原为 data URI，并返回对话消息）。
function load(id) {
  if (!ID_RE.test(String(id))) {
    const e = new Error('历史条目 id 非法'); e.code = 'BAD_INPUT'; throw e;
  }
  const dir = path.join(HISTORY_DIR, id);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) {
    const e = new Error('历史条目不存在'); e.code = 'SESSION_NOT_FOUND'; throw e;
  }
  const meta = readMeta(id);
  let stored = {};
  try { stored = JSON.parse(fs.readFileSync(path.join(dir, 'deck.json'), 'utf8')); } catch { /* 损坏按空册 */ }
  let markdown = '';
  try { markdown = fs.readFileSync(path.join(dir, 'doc.md'), 'utf8'); } catch { /* 无大纲快照 */ }
  return {
    meta,
    deck: { title: stored.title || '', projectTitle: meta.title || stored.title || '', taskId: meta.id, templateId: stored.templateId || null, canvas: stored.canvas || null, slides: mapSlides(stored.slides, inflateOne) },
    doc: markdown ? { markdown, title: stored.title || '' } : null,
    messages: messagesFor(id),
  };
}

function rename(id, title) {
  if (!ID_RE.test(String(id))) {
    const e = new Error('历史条目 id 非法'); e.code = 'BAD_INPUT'; throw e;
  }
  const dir = path.join(HISTORY_DIR, id);
  const meta = readMeta(id);
  if (!meta) {
    const e = new Error('历史条目不存在'); e.code = 'SESSION_NOT_FOUND'; throw e;
  }
  const nextTitle = String(title || '').trim();
  if (!nextTitle) {
    const e = new Error('标题不能为空'); e.code = 'BAD_INPUT'; throw e;
  }
  if (nextTitle.length > 80) {
    const e = new Error('标题不能超过 80 个字符'); e.code = 'BAD_INPUT'; throw e;
  }
  meta.title = nextTitle;
  meta.updatedAt = new Date().toISOString();
  writeMeta(dir, meta);
  return meta;
}

function remove(id) {
  if (!ID_RE.test(String(id))) {
    const e = new Error('历史条目 id 非法'); e.code = 'BAD_INPUT'; throw e;
  }
  const dir = path.join(HISTORY_DIR, id);
  if (!fs.existsSync(dir)) {
    const e = new Error('历史条目不存在'); e.code = 'SESSION_NOT_FOUND'; throw e;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  collectOrphanBlobs();
  return { removed: id };
}

// 保留最近 KEEP 册，其余按时间淘汰
function prune() {
  const all = list();
  for (const m of all.slice(KEEP)) {
    try { fs.rmSync(path.join(HISTORY_DIR, m.id), { recursive: true, force: true }); } catch { /* 单项失败忽略 */ }
  }
  if (all.length > KEEP) collectOrphanBlobs();
}

// 删除没有任何历史条目引用的 blob（跨册共享，所以必须整体统计后回收）
function collectOrphanBlobs() {
  const referenced = new Set();
  let dirs = [];
  try { dirs = fs.readdirSync(HISTORY_DIR, { withFileTypes: true }); } catch { return; }
  for (const e of dirs) {
    if (!e.isDirectory() || e.name === 'blobs') continue;
    let raw = '';
    try { raw = fs.readFileSync(path.join(HISTORY_DIR, e.name, 'deck.json'), 'utf8'); } catch { continue; }
    for (const m of raw.matchAll(/\{\{blob:([0-9a-f]{40})\.([a-z]+)\}\}/g)) referenced.add(m[1]);
  }
  let prefixes = [];
  try { prefixes = fs.readdirSync(BLOB_DIR, { withFileTypes: true }); } catch { return; }
  for (const p of prefixes) {
    if (!p.isDirectory()) continue;
    const abs = path.join(BLOB_DIR, p.name);
    let files = [];
    try { files = fs.readdirSync(abs); } catch { continue; }
    for (const f of files) {
      const hash = f.split('.')[0];
      if (!referenced.has(hash)) { try { fs.unlinkSync(path.join(abs, f)); } catch { /* 忽略 */ } }
    }
    try { if (!fs.readdirSync(abs).length) fs.rmdirSync(abs); } catch { /* 忽略 */ }
  }
}

module.exports = { list, findByFingerprint, createTask, updateTask, appendMessage, messagesFor, load, rename, remove, HISTORY_DIR, KEEP };
