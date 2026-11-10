import React from 'react';

// 待提交批注列表（阶段1）：用户攒的划词批注在此列出，一次性提交给服务端按意见改稿。
// 提交 → api.reviseOutline(comments)；定稿 → 进入「选择模板」。
// 点条目 → 激活（文稿内对应标注高亮）；activeId 决定哪条高亮显示。
export default function OutlineBatchPanel({ comments, busy, hasDoc, activeCommentId, onRemove, onActivate, onSend, onFinalize, showFinalize = true }) {
  const n = comments.length;
  return (
    <div className="ol-batch">
      <div className="annotate-head">
        <span>批注 · 待发送</span>
        {n > 0 ? <span className="annotate-scope">{n} 条</span> : null}
      </div>

      {n === 0 ? (
        <div className="ol-batch-empty">
          在大纲中选中文字添加批注；<br />攒够一批后发送，一次性修改。
        </div>
      ) : (
        <div className="ol-batch-list">
          {comments.map((c) => (
            <div
              className={`ol-batch-item${c.id === activeCommentId ? ' active' : ''}`}
              key={c.id}
              onClick={() => onActivate && onActivate(c.id)}
            >
              <button
                className="ol-batch-x"
                title="删除"
                onClick={(e) => { e.stopPropagation(); onRemove(c.id); }}
              >✕</button>
              <div className="ol-batch-quote">“{c.quote.length > 30 ? c.quote.slice(0, 30) + '…' : c.quote}”</div>
              <div className="ol-batch-note">{c.comment}</div>
            </div>
          ))}
        </div>
      )}

      <div className="ol-batch-actions">
        <button className="btn btn-primary" disabled={busy || n === 0} onClick={onSend}>
          发送批注{n > 0 ? ` (${n})` : ''}
        </button>
        {showFinalize ? (
          <button
            className="btn"
            disabled={busy || !hasDoc}
            title="确认内容无误，冻结为内容基线并进入出片阶段"
            onClick={onFinalize}
          >
            定稿
          </button>
        ) : null}
      </div>
    </div>
  );
}
