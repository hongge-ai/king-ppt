import React, { useRef, useState, useCallback, useEffect } from 'react';
import { renderMarkdown } from '../md.js';

// 内容大纲文档视图（阶段1）：渲染 Markdown + 划词批注。
// 划词 → 浮动气泡 → 写意见 → 高亮该段并入队本地批注列表（攒一批后由右栏统一提交改稿）。
// 标注呈现为「下划线 + 浅底色」，单条线、不叠加（重叠选区会被拦下）。
// 双向联动：点文稿标注 → 右栏对应条目高亮；点右栏条目 → 文稿标注高亮并滚动到位（由 activeCommentId 驱动）。
let CID = 0; // 单调批注 id 计数（避免 Math.random）

// 收集与选区相交的所有文本节点（跨 <br>/<li>/加粗 等元素边界）
function collectTextNodes(range) {
  const root = range.commonAncestorContainer;
  const rootEl = root.nodeType === 3 ? root.parentNode : root;
  const nodes = [];
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    if (range.intersectsNode(node)) nodes.push(node);
  }
  return nodes;
}

// 逐文本节点上色：每个相交文本节点的选中片段各包一个 <span class="ol-hl" data-cid>。
// 取代 surroundContents（跨元素即抛错）——这样跨行/跨列表项/跨加粗都能画出连续标注。
function paintRange(range, cid) {
  // 先快照边界（后续 DOM 变更不影响已取的值），再收集节点
  const sc = range.startContainer, so = range.startOffset;
  const ec = range.endContainer, eo = range.endOffset;
  const nodes = collectTextNodes(range);
  const spans = [];
  nodes.forEach((node) => {
    const start = node === sc ? so : 0;
    const end = node === ec ? eo : node.textContent.length;
    if (start >= end) return; // 无实际覆盖（边界零宽），跳过
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    const span = document.createElement('span');
    span.className = 'ol-hl';
    span.setAttribute('data-cid', cid);
    try { r.surroundContents(span); spans.push(span); } catch { /* 单节点内理论不会抛，兜底跳过 */ }
  });
  return spans;
}

export default function OutlineView({ markdown, version, comments, activeCommentId, onAddComment, onActivateComment }) {
  const docRef = useRef(null);
  const [bubble, setBubble] = useState(null); // { top, left, block, quote, range, overlap }
  const [note, setNote] = useState('');
  const [hint, setHint] = useState('');

  const html = renderMarkdown(markdown || '');

  // 划词：抬起鼠标时读取选区，定位所属块、检测是否与已有标注重叠
  const onMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { setBubble(null); return; }
    const quote = sel.toString().trim();
    if (!quote) { setBubble(null); return; }
    const range = sel.getRangeAt(0);
    const host = docRef.current;
    if (!host || !host.contains(range.startContainer)) { setBubble(null); return; }

    const startEl = range.startContainer.nodeType === 3
      ? range.startContainer.parentElement
      : range.startContainer;
    const blockEl = startEl && startEl.closest('[data-block]');
    if (!blockEl) { setBubble(null); return; }
    const block = Number(blockEl.dataset.block);

    // 重叠检测：选区若与任一已有标注相交，则不允许再标注（保证「不叠加、只一条线」）
    let overlap = false;
    host.querySelectorAll('.ol-hl').forEach((h) => {
      try { if (range.intersectsNode(h)) overlap = true; } catch { /* 忽略 */ }
    });

    // 跨块选择：仍锚到起始块，quote 作持久锚点
    const endEl = range.endContainer.nodeType === 3
      ? range.endContainer.parentElement
      : range.endContainer;
    const endBlock = endEl && endEl.closest('[data-block]');
    setHint(
      overlap ? '该处已有批注，重叠区域不能再标注'
        : (endBlock && endBlock !== blockEl ? '跨段落选择：建议在同一段内选取，批注仍会记录' : '')
    );

    const rect = range.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    setBubble({
      top: rect.bottom - hostRect.top + host.scrollTop + 8,
      left: Math.max(0, rect.left - hostRect.left),
      block,
      quote,
      range,
      overlap,
    });
    setNote('');
  }, []);

  const addComment = useCallback(() => {
    if (!bubble || bubble.overlap) return;
    const comment = note.trim();
    if (!comment) return;
    const id = `c_${++CID}`;
    // 逐文本节点上色：跨行/跨列表项/跨加粗都能画出连续标注（surroundContents 跨元素会抛错）
    paintRange(bubble.range, id);
    onAddComment({ id, block: bubble.block, quote: bubble.quote, comment });
    window.getSelection().removeAllRanges();
    setBubble(null);
    setNote('');
    setHint('');
  }, [bubble, note, onAddComment]);

  const cancel = useCallback(() => {
    setBubble(null);
    setNote('');
    setHint('');
  }, []);

  // 点击文稿里的标注 → 激活右栏对应条目
  const onClickDoc = useCallback((e) => {
    const hl = e.target.closest && e.target.closest('.ol-hl');
    if (hl && onActivateComment) onActivateComment(hl.getAttribute('data-cid'));
  }, [onActivateComment]);

  // 文档滚动/点击空白时收起气泡（点在气泡内不收）
  useEffect(() => {
    const onDocMouseDown = (e) => {
      if (e.target.closest && e.target.closest('.ol-bubble')) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setBubble(null);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  // 批注被删除时，抹掉文稿里对应的高亮（把 span 展开还原为文本）
  useEffect(() => {
    const host = docRef.current;
    if (!host) return;
    const ids = new Set((comments || []).map((c) => c.id));
    host.querySelectorAll('.ol-hl').forEach((span) => {
      if (!ids.has(span.getAttribute('data-cid'))) {
        const parent = span.parentNode;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
        parent.normalize();
      }
    });
  }, [comments]);

  // activeCommentId 变化 → 高亮对应标注（可能多段）并滚动到第一段
  useEffect(() => {
    const host = docRef.current;
    if (!host) return;
    let first = null;
    host.querySelectorAll('.ol-hl').forEach((span) => {
      const on = span.getAttribute('data-cid') === activeCommentId;
      span.classList.toggle('active', on);
      if (on && !first) first = span;
    });
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeCommentId]);

  if (!markdown) {
    return (
      <div className="outline-empty">
        <div className="empty-art">📝</div>
        <div className="empty-title">还没有内容大纲</div>
        <div className="empty-sub">
          在下方输入主题并发送即可开始；生成后选中文字添加批注，再统一提交修改。
        </div>
      </div>
    );
  }

  return (
    <div className="outline-wrap">
      <div
        className="outline-doc"
        key={version}
        ref={docRef}
        onMouseUp={onMouseUp}
        onClick={onClickDoc}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {bubble ? (
        <div className="ol-bubble" style={{ top: bubble.top, left: bubble.left }}>
          <div className="ol-bubble-quote">“{bubble.quote.length > 40 ? bubble.quote.slice(0, 40) + '…' : bubble.quote}”</div>
          {hint ? <div className="ol-bubble-hint">{hint}</div> : null}
          {!bubble.overlap ? (
            <>
              <textarea
                className="ol-bubble-input"
                rows={2}
                autoFocus
                value={note}
                placeholder="写下对这段的修改意见…"
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(); }
                  if (e.key === 'Escape') { e.preventDefault(); cancel(); }
                }}
              />
              <div className="ol-bubble-actions">
                <button className="btn btn-primary" disabled={!note.trim()} onClick={addComment}>添加</button>
                <button className="btn" onClick={cancel}>取消</button>
              </div>
            </>
          ) : (
            <div className="ol-bubble-actions">
              <button className="btn" onClick={cancel}>知道了</button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
