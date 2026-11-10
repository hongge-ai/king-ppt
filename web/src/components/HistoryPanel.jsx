import React, { useState, useCallback, useEffect } from 'react';
import { api } from '../api.js';

// 历史任务抽屉：列出磁盘上的 deck 快照，点一条即载入服务端 relay（= 打开并可继续编辑）。
// 快照不可变——打开后所有改动都发生在 relay 的工作副本上；想固化再点「存档当前」。
export default function HistoryPanel({ onClose, onOpened, flash }) {
  const [items, setItems] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState(null);

  const reload = useCallback(async () => {
    try {
      const r = await api.history();
      setItems(Array.isArray(r.items) ? r.items : []);
    } catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const open = useCallback(async (item) => {
    setBusyId(item.id);
    try {
      const r = await api.openHistory(item.id);
      onOpened(r);
      flash(`已打开「${item.title}」（${r.pages} 页）`, 'ok');
      if (!r.templateAvailable) {
        flash('该册所用模板已删除：仍可编辑与导出，但无法重新生成页面', 'error');
      }
      onClose();
    } catch (e) {
      flash(`打开失败：${e.message}`, 'error');
    } finally { setBusyId(null); }
  }, [onOpened, onClose, flash]);

  const archive = useCallback(async () => {
    try {
      const r = await api.archiveHistory();
      if (r.skipped === 'empty') flash('当前没有可存档的幻灯片', 'error');
      else if (r.skipped === 'duplicate') flash('当前内容与最近一册完全相同，已跳过', 'ok');
      else flash(`已存档（${r.pages} 页）`, 'ok');
      reload();
    } catch (e) { flash(`存档失败：${e.message}`, 'error'); }
  }, [flash, reload]);

  const del = useCallback(async (item) => {
    try {
      const r = await api.deleteHistory(item.id);
      setItems(Array.isArray(r.items) ? r.items : []);
      flash('已删除历史条目', 'ok');
    } catch (e) { flash(`删除失败：${e.message}`, 'error'); }
  }, [flash]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>历史任务</span>
          <button className="modal-x" title="关闭" onClick={onClose}>✕</button>
        </div>
        <div className="history-toolbar">
          <span className="history-tip">每次生成整册前会自动存档；打开历史后可以继续编辑、导出。</span>
          <button className="btn" onClick={archive}>存档当前</button>
        </div>
        <div className="history-body">
          {err ? <div className="history-empty">加载失败：{err}</div>
            : items === null ? <div className="history-empty">加载中…</div>
            : items.length === 0 ? (
              <div className="history-empty">
                还没有历史任务。<br />生成一次幻灯片后，旧内容会自动存到这里。
              </div>
            ) : (
              <div className="history-list">
                {items.map((it) => (
                  <div className="history-item" key={it.id}>
                    <button
                      className="history-hit"
                      disabled={busyId !== null}
                      onClick={() => open(it)}
                      title="打开并继续编辑"
                    >
                      <div className="history-item-title">{it.title || '未命名'}</div>
                      <div className="history-item-meta">
                        {fmtTime(it.createdAt)} · {it.pages} 页
                        {it.templateName ? ` · ${it.templateName}` : ''}
                        {it.bytes ? ` · ${fmtSize(it.bytes)}` : ''}
                      </div>
                    </button>
                    <button
                      className="history-del"
                      title="删除此历史条目"
                      onClick={() => del(it)}
                    >✕</button>
                  </div>
                ))}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
