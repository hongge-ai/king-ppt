// 历史任务：把「一册 deck + 对应大纲」冻结成磁盘上的不可变快照，并支持读回 relay 继续编辑。
//
// 设计要点：
//  - 快照不可变。relay 里的 deck 永远是「工作副本」，历史条目只在 archive 时写入一次。
//    打开历史 = 把快照塞回 relay；之后所有编辑都发生在工作副本上，不会污染历史。
//  - 图片按内容哈希去重。烘焙底图以 base64 内联在 slide.svg 里，一册正文页只有 2 KB、
//    封面/章节页却有 1–2 MB，且同模板的章节页底图完全重复。写入时把 data URI 换成
//    {{blob:<sha1>.<ext>}} 占位并单独存 blob，读回时还原为完整 data URI——导出链路无感知。
//  - 保留最近 N 册（默认 50），淘汰时回收不再被引用的 blob。
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
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// 存档当前 deck。空册跳过；内容与最新一册完全相同也跳过（避免连点生成堆积重复快照）。
function archive({ deck, doc, templateName }) {
  const slides = Array.isArray(deck && deck.slides) ? deck.slides.filter(Boolean) : [];
  if (!slides.length) return { skipped: 'empty' };
  const fingerprint = sha1(JSON.stringify({
    title: deck.title || '', templateId: deck.templateId || null,
    svgs: slides.map((s) => s.svg || ''),
  })).slice(0, 16);
  const latest = list()[0];
  if (latest && latest.fingerprint === fingerprint) return { skipped: 'duplicate', id: latest.id };

  ensureDirs();
  const id = `${stamp()}-${crypto.randomBytes(2).toString('hex')}`;
  const dir = path.join(HISTORY_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const stored = {
    title: deck.title || '',
    templateId: deck.templateId || null,
    canvas: deck.canvas || null,
    slides: mapSlides(slides, externalizeOne),
  };
  fs.writeFileSync(path.join(dir, 'deck.json'), JSON.stringify(stored));
  if (doc && typeof doc.markdown === 'string' && doc.markdown.trim()) {
    fs.writeFileSync(path.join(dir, 'doc.md'), doc.markdown, 'utf8');
  }

  const meta = {
    id,
    title: stored.title || '未命名',
    createdAt: new Date().toISOString(),
    pages: stored.slides.length,
    templateId: stored.templateId,
    templateName: templateName || stored.templateId || '',
    canvas: stored.canvas,
    fingerprint,
    hasDoc: Boolean(doc && doc.markdown && doc.markdown.trim()),
    bytes: 0,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  // 体积按落盘后实测回填，列表页据此展示
  try {
    const size = fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    meta.bytes = size;
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  } catch { /* 体积只是展示信息 */ }

  prune();
  return { id, pages: meta.pages };
}

// 读回一册（图片已还原成 data URI）：{ meta, deck, doc }
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
    deck: { title: stored.title || '', templateId: stored.templateId || null, canvas: stored.canvas || null, slides: mapSlides(stored.slides, inflateOne) },
    doc: markdown ? { markdown, title: stored.title || '' } : null,
  };
}

function rename(id, title) {
  if (!ID_RE.test(String(id))) {
    const e = new Error('历史条目 id 非法'); e.code = 'BAD_INPUT'; throw e;
  }
  const dir = path.join(HISTORY_DIR, id);
  const metaPath = path.join(dir, 'meta.json');
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
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  try {
    meta.bytes = fs.readdirSync(dir).reduce((n, file) => n + fs.statSync(path.join(dir, file)).size, 0);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  } catch { /* 体积只是展示信息 */ }
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

module.exports = { list, archive, load, rename, remove, HISTORY_DIR, KEEP };
