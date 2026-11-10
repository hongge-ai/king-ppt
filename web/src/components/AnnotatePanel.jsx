import React, { useState } from 'react';

// 修改面板（出片阶段）：对「当前选中页」提自然语言修改意见，服务端按意见重画该页（regenSlide）。
// 与就地编辑不同——这是让 AI 重新创作整页版式；结果经 SSE 覆盖该页。
export default function AnnotatePanel({ activeIndex, hasSlides, busy, onAnnotate, onRegenerate }) {
  const [text, setText] = useState('');
  const hasPage = hasSlides && activeIndex >= 0;

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onAnnotate(t, activeIndex);
    setText('');
  };

  return (
    <div className="annotate">
      <div className="annotate-head">
        <span>AI 修改本页</span>
        {hasPage ? <span className="annotate-scope">当前第 {activeIndex + 1} 页</span> : null}
      </div>
      <textarea
        className="annotate-input"
        rows={3}
        value={text}
        placeholder={'说说这页要改什么，例如：配色更冷静，标题再大一点'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
      />
      <div className="annotate-actions">
        <button className="btn btn-primary" disabled={busy || !hasPage || !text.trim()} onClick={submit}>
          按意见重画
        </button>
        {hasPage ? (
          <button className="btn" disabled={busy} onClick={() => onRegenerate(activeIndex)} title="不加意见，直接重画当前页">
            重画本页
          </button>
        ) : null}
      </div>
    </div>
  );
}
