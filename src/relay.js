// 有状态存储 + 广播总线：在「服务端生成」与「人类浏览器」之间同步演示态。
//  - deck 存储：当前整册（title/templateId/canvas/slides[]/version），单调 version，单页粒度写入。
//  - doc 存储：阶段1 内容大纲镜像（markdown/title/version），与 deck 并列、独立 version。
//  - 事件总线：浏览器通过 SSE 订阅；服务端每次 setDeck/setSlide/setDoc 实时推给浏览器预览。
//  - 落盘持久化：deck/doc 写入 KING_PPT_HOME，服务重启/崩溃后自动恢复——演示态不再随进程消失。
// Node 单线程 + 路由内同步 read-modify-write 单页 → 逐页流式生成与人类就地编辑并发不丢更新。
const fs = require('fs');
const path = require('path');
const { HOME } = require('./paths');

const DECK_FILE = path.join(HOME, 'relay-deck.json');
const DOC_FILE = path.join(HOME, 'relay-doc.json');

function createRelay({ onChange = () => {} } = {}) {
  const deck = { title: '', projectTitle: '', taskId: null, templateId: null, canvas: null, slides: [], version: 0 };
  const doc = { markdown: '', title: '', version: 0 };
  const subscribers = new Set(); // SSE 响应对象（浏览器侧）

  // 启动时恢复上次演示态（重启/崩溃自愈）。坏文件忽略，退回空态。
  try { Object.assign(deck, JSON.parse(fs.readFileSync(DECK_FILE, 'utf8'))); } catch { /* 无快照 */ }
  try { Object.assign(doc, JSON.parse(fs.readFileSync(DOC_FILE, 'utf8'))); } catch { /* 无快照 */ }

  // deck 可能含内联图（数 MB），逐页流式写会抖动磁盘——合并到空闲后写一次。
  let deckTimer = null;
  function persistDeck() {
    if (deckTimer) return;
    deckTimer = setTimeout(() => {
      deckTimer = null;
      try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(DECK_FILE, JSON.stringify(deck)); } catch { /* 落盘失败不影响运行 */ }
    }, 400);
  }
  function persistDoc() {
    try { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(DOC_FILE, JSON.stringify(doc)); } catch { /* 忽略 */ }
  }

  // ---------- deck 存储（单页粒度） ----------
  function bump() { deck.version += 1; return deck.version; }

  function getState() {
    return {
      title: deck.title, projectTitle: deck.projectTitle || deck.title, taskId: deck.taskId || null, templateId: deck.templateId, canvas: deck.canvas,
      slides: deck.slides, version: deck.version,
    };
  }

  // 整册替换（如逐页生成前建空册）。slides 已由 server 归一。
  function setDeck({ title, projectTitle, taskId, templateId, canvas, slides }) {
    if (title !== undefined) deck.title = title;
    if (projectTitle !== undefined) deck.projectTitle = projectTitle;
    else if (title !== undefined && !deck.projectTitle) deck.projectTitle = title;
    if (taskId !== undefined) deck.taskId = taskId;
    if (templateId !== undefined) deck.templateId = templateId;
    if (canvas !== undefined) deck.canvas = canvas;
    deck.slides = Array.isArray(slides) ? slides : [];
    const version = bump();
    persistDeck();
    broadcast('deck', { ...getState() });
    onChange();
    return version;
  }

  // 单页写入（逐页生成 / 人类就地编辑）。同步改 slides[index]，不跨 await。
  function setSlide(index, slide, canvas) {
    if (!(index >= 0)) throw new Error('页序号非法');
    if (canvas !== undefined && canvas !== null) deck.canvas = canvas;
    deck.slides[index] = slide;
    const version = bump();
    persistDeck();
    broadcast('slide', { index, slide, canvas: deck.canvas, version });
    onChange();
    return version;
  }

  function setTaskId(taskId) {
    deck.taskId = taskId || null;
    const version = bump();
    persistDeck();
    broadcast('deck', { ...getState() });
    onChange();
    return version;
  }

  function setProjectTitle(projectTitle) {
    deck.projectTitle = String(projectTitle || '');
    const version = bump();
    persistDeck();
    broadcast('deck', { ...getState() });
    onChange();
    return version;
  }

  // ---------- 内容大纲镜像（阶段1） ----------
  function getDoc() {
    return { markdown: doc.markdown, title: doc.title, version: doc.version };
  }

  function setDoc({ markdown, title }) {
    if (markdown !== undefined) doc.markdown = markdown;
    if (title !== undefined) doc.title = title;
    doc.version += 1;
    persistDoc();
    broadcast('doc', getDoc());
    onChange();
    return doc.version;
  }

  // ---------- SSE 事件总线（浏览器侧） ----------
  function subscribe(res) {
    subscribers.add(res);
    return () => subscribers.delete(res);
  }

  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of subscribers) {
      try { res.write(frame); } catch { subscribers.delete(res); }
    }
  }

  function pingAll() {
    for (const res of subscribers) {
      try { res.write(': ping\n\n'); } catch { subscribers.delete(res); }
    }
  }

  return {
    getState, setDeck, setSlide, setTaskId, setProjectTitle,
    getDoc, setDoc,
    subscribe, broadcast, pingAll,
  };
}

module.exports = { createRelay };
