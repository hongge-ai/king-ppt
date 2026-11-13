import React, { useState, useEffect } from 'react';
import { api } from '../api.js';
import SlideCanvas from './SlideCanvas.jsx';

const ROLE_LABEL = { cover: '封面', section: '章节', content: '内容', closing: '结束' };
const SOURCE_ROLES = ['cover', 'section', 'content', 'closing'];

// Uploaded decks preview representative pages rendered from the original PPTX.
// Synthesized role prototypes are only shown when no source presentation exists.
export default function ThemePreview({ theme, busy, onClose, onConfirm }) {
  const [spec, setSpec] = useState(null);
  const [source, setSource] = useState(null);
  const [err, setErr] = useState('');
  const [sourceErr, setSourceErr] = useState('');
  const [imageErrors, setImageErrors] = useState({});

  useEffect(() => {
    if (!theme) return undefined;
    let active = true;
    setSpec(null);
    setSource(null);
    setErr('');
    setSourceErr('');
    setImageErrors({});
    api.themeSpec(theme.id).then((value) => { if (active) setSpec(value); }).catch((e) => { if (active) setErr(e.message); });
    api.templatePreview(theme.id).then((value) => { if (active) setSource(value); }).catch((e) => { if (active) setSourceErr(e.message); });
    return () => { active = false; };
  }, [theme && theme.id]);

  if (!theme) return null;
  const sourcePages = source && source.kind === 'source';
  const pageCount = sourcePages ? source.pageCount : 0;
  const samples = sourcePages ? SOURCE_ROLES.map((role, position) => {
    const fallback = [0, Math.min(1, pageCount - 1), Math.min(2, pageCount - 1), pageCount - 1][position];
    const pageIndex = Number.isInteger(source.rolePages && source.rolePages[role]) ? source.rolePages[role] : fallback;
    return { role, pageIndex };
  }).filter((sample) => sample.pageIndex >= 0 && sample.pageIndex < pageCount) : [];
  const waitingForSource = theme.source === 'uploaded' && !source && !sourceErr;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="theme-preview" onClick={(e) => e.stopPropagation()}>
        <div className="theme-preview-head">
          <div className="theme-preview-title">{theme.name || theme.id}</div>
          <button className="icon-btn" onClick={onClose} title="关闭">✕</button>
        </div>
        {err ? (
          <div className="theme-preview-msg err">预览加载失败：{err}</div>
        ) : !spec || waitingForSource ? (
          <div className="theme-preview-msg">正在加载模板原稿预览…</div>
        ) : sourcePages ? (
          <>
            <div className="theme-preview-source-note">原始 PPT 代表页，共 {pageCount} 页</div>
            <div className="theme-preview-grid">
              {samples.map(({ role, pageIndex }) => (
                <figure className="theme-preview-cell" key={`${role}-${pageIndex}`}>
                  <div className="theme-preview-canvas">
                    {imageErrors[role] ? (
                      <div className="theme-preview-msg err">原始第 {pageIndex + 1} 页预览失败</div>
                    ) : (
                      <img
                        className="theme-preview-source-image"
                        src={api.templatePreviewImage(theme.id, pageIndex)}
                        alt={`${theme.name || '模板'}原始第 ${pageIndex + 1} 页`}
                        loading="lazy"
                        onError={() => setImageErrors((prev) => ({ ...prev, [role]: true }))}
                      />
                    )}
                  </div>
                  <figcaption>{ROLE_LABEL[role]} · 原稿第 {pageIndex + 1} 页</figcaption>
                </figure>
              ))}
            </div>
          </>
        ) : sourceErr && theme.source === 'uploaded' ? (
          <div className="theme-preview-msg err">原始 PPT 预览加载失败：{sourceErr}</div>
        ) : (
          <>
            {source && source.kind === 'descriptor' ? <div className="theme-preview-source-note">生成样例预览（此模板没有原始 PPT 文件）</div> : null}
            <div className="theme-preview-grid">
              {(spec.layouts || []).map((layout) => (
                <figure className="theme-preview-cell" key={layout.role}>
                  <div className="theme-preview-canvas">
                    <SlideCanvas svg={layout.svg} index={0} editable={false} active={false} onSelect={() => {}} />
                  </div>
                  <figcaption>{ROLE_LABEL[layout.role] || layout.role}</figcaption>
                </figure>
              ))}
            </div>
          </>
        )}
        <div className="theme-preview-foot">
          <button className="btn" onClick={onClose} disabled={busy}>换一个</button>
          <button className="btn btn-primary" onClick={() => onConfirm(theme.id)} disabled={busy || !spec}>
            用此模板生成
          </button>
        </div>
      </div>
    </div>
  );
}
