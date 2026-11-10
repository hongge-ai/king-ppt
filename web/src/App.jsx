import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, subscribe } from './api.js';
import PageRail from './components/PageRail.jsx';
import SlideCanvas from './components/SlideCanvas.jsx';
import AnnotatePanel from './components/AnnotatePanel.jsx';
import ThemePreview from './components/ThemePreview.jsx';
import OutlineView from './components/OutlineView.jsx';
import OutlineBatchPanel from './components/OutlineBatchPanel.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import { useAppDialog, AppDialogHost } from './components/AppDialog.jsx';

// 卷王PPT · 独立生成程序（server-gen）。聊天式工作台中依次完成：
//   ① 内容大纲（生成/批注/定稿） → ② 选择模板（预览确认） → ③ 幻灯片（逐页流式生成/就地编辑/单页重画/导出）。
// deck 与 doc 的权威都在服务端；本页经 SSE 收 deck/slide/doc 事件驱动渲染，经 REST 触发生成与编辑。
const STEPS = [
  { key: 'outline', no: 1, label: '内容大纲' },
  { key: 'theme', no: 2, label: '选择模板' },
  { key: 'slides', no: 3, label: '幻灯片' },
];

const ROLE_LABEL = { cover: '封面', section: '章节', content: '内容', closing: '结束' };

// 模板卡片的色板预览：优先 primary/accent，回退到画像令牌 ink 或中性色。
function swatchOf(t) {
  const p = t.palette || {};
  const c = (k, d) => (p[k] ? `#${String(p[k]).replace(/^#/, '')}` : d);
  return `linear-gradient(135deg, ${c('primary', c('ink', '1F4E79'))} 0%, ${c('accent', c('muted', '2E86C1'))} 100%)`;
}

export default function App() {
  const [step, setStep] = useState('outline'); // 'outline' | 'theme' | 'slides'
  const [deck, setDeck] = useState({ title: '', themeId: null, slides: [], version: 0 });
  const [styleScore, setStyleScore] = useState(null);
  const [doc, setDocState] = useState({ markdown: '', title: '', version: 0 });
  const [outlineComments, setOutlineComments] = useState([]);
  const [activeCommentId, setActiveCommentId] = useState(null);
  const [themes, setThemes] = useState([]);
  const [selectedThemeId, setSelectedThemeId] = useState(''); // 无内置默认；由用户上传/选择
  const [uploadingTpl, setUploadingTpl] = useState(false);    // 模板上传（提取+烘焙）进行中
  const [aiImages, setAiImages] = useState(false);            // 封面/章节是否用 AI 配图（默认关=忠于模板原图）
  const [previewTheme, setPreviewTheme] = useState(null);       // 正在预览的主题对象（null=不显示弹层）
  const [activeIndex, setActiveIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [connected, setConnected] = useState(false);
  const [providers, setProviders] = useState(null); // 多供应商配置视图（不含明文 key）
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState([]);
  const [editingHistoryId, setEditingHistoryId] = useState(null);
  const [editingHistoryTitle, setEditingHistoryTitle] = useState('');
  const [historyBusyId, setHistoryBusyId] = useState(null);
  const [topic, setTopic] = useState('');       // 阶段1 主题输入
  const deckVersionRef = useRef(0);
  const docVersionRef = useRef(0);
  const tplInputRef = useRef(null); // 隐藏的 .pptx 文件选择器
  const initedRef = useRef(false); // 是否已按首份快照设过初始步骤（之后以用户操作为准）
  const dialog = useAppDialog();

  const flash = useCallback((text, type = 'info') => {
    setToast({ text, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const r = await api.history();
      setHistoryItems(Array.isArray(r.items) ? r.items : []);
    } catch { /* 历史列表不可用时不阻断创作 */ }
  }, []);

  const onArchiveCurrent = useCallback(async () => {
    if (!deck.slides.some(Boolean) || busy) return;
    try {
      const r = await api.archiveHistory();
      if (r.skipped === 'duplicate') flash('当前内容已在历史记录中', 'info');
      else if (r.skipped === 'empty') flash('当前没有可存档的幻灯片', 'error');
      else flash('已存入历史演示文稿', 'ok');
      refreshHistory();
    } catch (e) { flash(`存档失败：${e.message}`, 'error'); }
  }, [deck.slides, busy, flash, refreshHistory]);

  const onRenameHistory = useCallback(async (event, id) => {
    event.preventDefault();
    const title = editingHistoryTitle.trim();
    if (!title) { flash('标题不能为空', 'error'); return; }
    setHistoryBusyId(id);
    try {
      const r = await api.renameHistory(id, title);
      setHistoryItems(Array.isArray(r.items) ? r.items : []);
      setEditingHistoryId(null);
      setEditingHistoryTitle('');
      flash('历史标题已更新', 'ok');
    } catch (e) { flash(`重命名失败：${e.message}`, 'error'); }
    finally { setHistoryBusyId(null); }
  }, [editingHistoryTitle, flash]);

  const onDeleteHistory = useCallback(async (item) => {
    const ok = await dialog.ask({
      title: '删除历史演示文稿？',
      body: `将永久删除「${item.title || '未命名演示文稿'}」，此操作无法撤销。`,
      okText: '删除',
    });
    if (!ok) return;
    setHistoryBusyId(item.id);
    try {
      const r = await api.deleteHistory(item.id);
      setHistoryItems(Array.isArray(r.items) ? r.items : []);
      flash('历史演示文稿已删除', 'ok');
    } catch (e) { flash(`删除失败：${e.message}`, 'error'); }
    finally { setHistoryBusyId(null); }
  }, [dialog, flash]);

  // 初始化：拉主题列表 + 供应商配置 + 当前 deck / doc 快照（刷新/重连恢复）
  useEffect(() => {
    api.listThemes().then((r) => setThemes(r.templates || [])).catch(() => {});
    api.getProviders().then(setProviders).catch(() => {});
    refreshHistory();
    api.deck().then((st) => {
      if (st && Array.isArray(st.slides)) {
        deckVersionRef.current = st.version || 0;
        setDeck({ title: st.title || '', themeId: st.templateId || null, slides: st.slides, version: st.version || 0 });
        if (st.templateId) setSelectedThemeId(st.templateId);
        // 恢复初始步骤：已有幻灯片 → 出片步；否则留在大纲步
        if (!initedRef.current && st.slides.filter(Boolean).length > 0) { initedRef.current = true; setStep('slides'); }
      }
    }).catch(() => {});
    api.doc().then((d) => {
      if (d && typeof d.markdown === 'string') {
        if (d.version && d.version < docVersionRef.current) return;
        docVersionRef.current = d.version || 0;
        setDocState({ markdown: d.markdown, title: d.title || '', version: d.version || 0 });
        setTopic(d.title || '');
      }
    }).catch(() => {});
  }, [refreshHistory]);

  // SSE 订阅：整册替换 / 单页写入 / 大纲替换。丢弃过期版本回放（version 单调）。
  useEffect(() => {
    const unsub = subscribe({
      onDeck: (data) => {
        if (data.version && data.version < deckVersionRef.current) return;
        deckVersionRef.current = data.version || deckVersionRef.current;
        setConnected(true);
        setDeck({
          title: data.title || '',
          themeId: data.templateId || null,
          slides: Array.isArray(data.slides) ? data.slides : [],
          version: data.version || 0,
        });
        if (data.templateId) setSelectedThemeId(data.templateId);
      },
      onSlide: (data) => {
        if (data.version && data.version < deckVersionRef.current) return;
        deckVersionRef.current = data.version || deckVersionRef.current;
        setConnected(true);
        setDeck((prev) => {
          const slides = prev.slides.slice();
          slides[data.index] = data.slide;
          return { ...prev, slides, version: data.version || prev.version };
        });
      },
      onDoc: (data) => {
        if (data.version && data.version < docVersionRef.current) return;
        const changed = (data.version || 0) !== docVersionRef.current;
        docVersionRef.current = data.version || docVersionRef.current;
        setConnected(true);
        setDocState({ markdown: data.markdown || '', title: data.title || '', version: data.version || 0 });
        // 大纲更新（改稿重推）：清空本地批注与选中，旧高亮随 key 重挂丢弃
        if (changed) { setOutlineComments([]); setActiveCommentId(null); }
      },
      onError: () => setConnected(false),
    });
    return unsub;
  }, []);

  const slides = deck.slides.filter(Boolean);
  const hasSlides = slides.length > 0;
  const hasDoc = !!doc.markdown;
  const hasModel = !!providers?.active?.chat; // 已绑定文本默认模型才能生成
  const activeThemeId = selectedThemeId || deck.themeId;

  // Re-score after each streamed page. The score is computed from the same SVG
  // payload used by preview/export, so the badge reflects the current deck.
  useEffect(() => {
    if (!hasSlides || !deck.themeId) { setStyleScore(null); return undefined; }
    let alive = true;
    const timer = setTimeout(() => {
      api.styleScore().then((r) => { if (alive) setStyleScore(r.available ? r : null); }).catch(() => {});
    }, 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [deck.version, deck.themeId, hasSlides]);

  // ---------- 阶段2：出片 ----------
  // 就地编辑：把改后的整页 SVG 交回服务端（sanitize 后落权威 deck 并广播）
  const onEdit = useCallback((index, svg) => {
    api.editSlide(index, svg).catch((e) => flash(`同步编辑失败：${e.message}`, 'error'));
  }, [flash]);

  // 按意见重画当前页
  const onAnnotate = useCallback((instruction, index) => {
    if (!(index >= 0)) { flash('请先选中要修改的页', 'error'); return; }
    setBusy(true);
    api.regenSlide(index, instruction, aiImages)
      .then(() => flash(`已按意见重画第 ${index + 1} 页`, 'ok'))
      .catch((e) => flash(`重画失败：${e.message}`, 'error'))
      .finally(() => setBusy(false));
  }, [flash, aiImages]);

  // 重画当前页（无修改意见）
  const onRegenerate = useCallback((index) => {
    setBusy(true);
    api.regenSlide(index, undefined, aiImages)
      .then(() => flash(`已重画第 ${index + 1} 页`, 'ok'))
      .catch((e) => flash(`重画失败：${e.message}`, 'error'))
      .finally(() => setBusy(false));
  }, [flash, aiImages]);

  // 打开模板预览弹层
  const onPreviewTheme = useCallback((theme) => setPreviewTheme(theme), []);

  // 上传一份 .pptx 作模板：提取+烘焙 → 落库 → 刷新列表 → 选中并预览。可重复上传多份。
  const onUploadTemplate = useCallback((files) => {
    const file = Array.from(files || []).find((f) => /\.pptx$/i.test(f.name));
    if (!file) { flash('请选择 .pptx 模板文件', 'error'); return; }
    setUploadingTpl(true);
    flash('正在提取并烘焙模板…', 'ok');
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const b64 = String(reader.result || '').split(',')[1] || '';
        const ex = await api.extractTemplate(file.name, b64);
        if (!ex || !ex.stagingId) throw new Error('提取失败');
        const saved = await api.saveTemplate(ex.stagingId, file.name.replace(/\.pptx$/i, '').slice(0, 30));
        setThemes(saved.templates || []);
        setSelectedThemeId(saved.id);
        const t = (saved.templates || []).find((x) => x.id === saved.id);
        if (t) setPreviewTheme(t);
        flash('模板已上传', 'ok');
        // 分析模板视觉语义（styleModel）：多模态长任务，失败不阻塞使用——
        // 没有 styleModel 时生成端按纯测量画像走，只是家族与风格纪律信息更少。
        flash('正在分析模板风格…', 'ok');
        try {
          const an = await api.analyzeTemplate(saved.id);
          const bad = an && an.validation && an.validation.ok === false;
          flash(bad
            ? `模板已分析（${an.families || 0} 个家族，${an.validation.errors.length} 项待确认）`
            : `模板已分析（${(an && an.families) || 0} 个家族）`, 'ok');
        } catch (e) {
          flash(`风格分析未完成：${e.message}（生成仍可用，但缺少家族与风格纪律）`, 'error');
        }
      } catch (e) {
        flash(`上传失败：${e.message}`, 'error');
      } finally {
        setUploadingTpl(false);
      }
    };
    reader.onerror = () => { setUploadingTpl(false); flash('读取文件失败', 'error'); };
    reader.readAsDataURL(file);
  }, [flash]);

  // 删除一份本地模板（本地维护）
  const onDeleteTemplate = useCallback(async (id, name) => {
    const ok = await dialog.ask({ title: '删除模板？', body: `将从本地移除「${name || id}」，不可恢复。`, okText: '删除' });
    if (!ok) return;
    try {
      const r = await api.deleteTheme(id);
      setThemes(r.templates || []);
      setSelectedThemeId((cur) => (cur === id ? '' : cur));
      flash('已删除模板', 'ok');
    } catch (e) { flash(`删除失败：${e.message}`, 'error'); }
  }, [dialog, flash]);

  const onOpenHistory = useCallback(async (item) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.openHistory(item.id);
      initedRef.current = true;
      setStep(r.pages > 0 ? 'slides' : 'outline');
      setActiveIndex(0);
      setSelectedThemeId(r.meta && r.meta.templateId ? r.meta.templateId : '');
      setTopic(r.meta && r.meta.title ? r.meta.title : '');
      setSidebarOpen(false);
      flash(`已打开「${item.title}」`, 'ok');
      refreshHistory();
    } catch (e) {
      flash(`打开失败：${e.message}`, 'error');
    } finally { setBusy(false); }
  }, [busy, flash, refreshHistory]);

  const onNewPresentation = useCallback(async () => {
    if (busy) return;
    if (hasSlides || hasDoc) {
      const ok = await dialog.ask({
        title: '新建演示文稿？',
        body: hasSlides
          ? '当前幻灯片会先保存到历史记录。尚未出片的大纲不会单独保留。'
          : '当前大纲尚未生成幻灯片，开始新建后会清空。',
        okText: '新建',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await api.newPresentation();
      deckVersionRef.current = r.deckVersion || 0;
      docVersionRef.current = r.docVersion || 0;
      initedRef.current = true;
      setDeck({ title: '', themeId: null, slides: [], version: r.deckVersion || 0 });
      setDocState({ markdown: '', title: '', version: r.docVersion || 0 });
      setHistoryItems(Array.isArray(r.history) ? r.history : []);
      setSelectedThemeId('');
      setTopic('');
      setStep('outline');
      setSidebarOpen(false);
      setActiveIndex(0);
      setOutlineComments([]);
      setActiveCommentId(null);
      flash('已新建演示文稿', 'ok');
    } catch (e) {
      flash(`新建失败：${e.message}`, 'error');
    } finally { setBusy(false); }
  }, [busy, hasSlides, hasDoc, dialog, flash]);

  // 确认用此模板：切到出片步，服务端逐页流式生成（结果经 SSE 实时冒页）
  const onConfirmTheme = useCallback((themeId) => {
    if (!hasModel) { flash('请先在右上角「模型设置」绑定文本模型', 'error'); return; }
    setSelectedThemeId(themeId);
    setPreviewTheme(null);
    setStep('slides');
    setActiveIndex(0);
    setBusy(true);
    flash(aiImages ? '正在按模板逐页生成（含 AI 配图）…' : '正在按模板逐页生成…', 'ok');
    api.generateDeck(themeId, aiImages)
      .then((r) => flash(r.recovered?.length ? `生成完成，其中 ${r.recovered.length} 页需重画` : '生成完成', 'ok'))
      .catch((e) => flash(`生成失败：${e.message}`, 'error'))
      .finally(() => { setBusy(false); refreshHistory(); });
  }, [hasModel, flash, aiImages, refreshHistory]);

  // ---------- 阶段1：内容大纲 ----------
  const onAddComment = useCallback((c) => setOutlineComments((prev) => [...prev, c]), []);
  const onRemoveComment = useCallback((id) => {
    setOutlineComments((prev) => prev.filter((c) => c.id !== id));
    setActiveCommentId((cur) => (cur === id ? null : cur));
  }, []);
  const onActivateComment = useCallback((id) => setActiveCommentId((cur) => (cur === id ? null : id)), []);

  // 按主题让服务端生成大纲（结果经 SSE 'doc' 回来）
  const onGenerateOutline = useCallback(() => {
    if (!topic.trim()) return;
    setBusy(true);
    api.generateOutline({ topic: topic.trim() })
      .then(() => flash('大纲已生成', 'ok'))
      .catch((e) => flash(`生成失败：${e.message}`, 'error'))
      .finally(() => setBusy(false));
  }, [topic, flash]);

  const onSendBatch = useCallback(() => {
    if (outlineComments.length === 0) return;
    setBusy(true);
    api.reviseOutline(outlineComments)
      .then(() => { setOutlineComments([]); setActiveCommentId(null); flash('正在按批注改稿…', 'ok'); })
      .catch((e) => flash(`发送失败：${e.message}`, 'error'))
      .finally(() => setBusy(false));
  }, [outlineComments, flash]);

  const onFinalize = useCallback(async () => {
    const ok = await dialog.ask({
      title: '确认定稿？',
      body: '将以当前大纲作为内容基线，进入「选择模板」。',
      okText: '定稿',
    });
    if (!ok) return;
    setStep('theme');
    flash('已定稿，请选择模板', 'ok');
  }, [flash, dialog]);

  // 拖拽上传参考素材 → base64 → 上传 → 服务端存盘（生成时自动参考）
  const uploadFiles = useCallback((files) => {
    Array.from(files || []).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = String(reader.result || '').split(',')[1] || '';
        api.uploadMaterial(file.name, b64)
          .then((r) => flash(`素材已上传：${r.name}，生成时将参考`, 'ok'))
          .catch((e) => flash(`上传失败：${e.message}`, 'error'));
      };
      reader.readAsDataURL(file);
    });
  }, [flash]);

  const onExport = useCallback(async () => {
    if (!hasSlides) return;
    setBusy(true);
    try {
      const blob = await api.export(deck.slides, deck.title, deck.themeId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${deck.title || 'slides'}.pptx`;
      a.click();
      URL.revokeObjectURL(url);
      flash('已导出 .pptx', 'ok');
    } catch (e) {
      flash(`导出失败：${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }, [deck, hasSlides, flash]);

  const scrollToSlide = useCallback((i) => {
    setActiveIndex(Math.max(0, i));
  }, []);

  // 键盘翻页：出片步用 ← → 切页（焦点在输入框/文本框时不拦截）
  useEffect(() => {
    if (step !== 'slides') return undefined;
    const onKey = (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); setActiveIndex((i) => Math.max(0, i - 1)); }
      if (e.key === 'ArrowRight') { e.preventDefault(); setActiveIndex((i) => Math.min(deck.slides.length - 1, i + 1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, deck.slides.length]);

  // 步骤可达性：大纲随时可回；选模板需已有大纲；幻灯片需已生成
  const canGo = useCallback((key) => {
    if (key === 'outline') return true;
    if (key === 'theme') return hasDoc;
    if (key === 'slides') return hasSlides;
    return false;
  }, [hasDoc, hasSlides]);

  const headerTitle = step === 'outline'
    ? (doc.title ? `《${doc.title}》· 内容大纲` : '内容大纲')
    : step === 'theme'
      ? '选择模板风格'
      : (deck.title ? `《${deck.title}》` : 'SVG 演示文稿');

  return (
    <div className="app-shell">
      <aside className={`chat-sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-brand">
          <span className="brand-logo">卷</span>
          <span className="brand-name">卷王PPT</span>
        </div>
        <button className="new-chat-btn" disabled={busy} onClick={onNewPresentation}>
          <span aria-hidden="true">＋</span>新建演示文稿
        </button>
        <div className="sidebar-section-label">当前项目</div>
        {hasSlides || hasDoc ? (
          <button className="sidebar-history-item current" onClick={() => { setStep(hasSlides ? 'slides' : 'outline'); setActiveIndex(0); setSidebarOpen(false); }}>
            <span className="sidebar-history-mark">▧</span>
            <span className="sidebar-history-copy">
              <span className="sidebar-history-title">{deck.title || doc.title || '未命名演示文稿'}</span>
              <span className="sidebar-history-meta">{hasSlides ? `${slides.length} 页 · 当前项目` : '大纲草稿'}</span>
            </span>
          </button>
        ) : <div className="sidebar-current-empty">还没有打开的演示文稿</div>}
        <div className="sidebar-section-label history-section-label">
          <span>历史演示文稿</span>
          <span className="sidebar-history-count">{historyItems.length}</span>
        </div>
        <nav className="sidebar-history" aria-label="历史演示文稿">
          {historyItems.map((item) => (
            <div key={item.id} className="sidebar-history-entry">
              {editingHistoryId === item.id ? (
                <form className="sidebar-rename-form" onSubmit={(e) => onRenameHistory(e, item.id)}>
                  <input
                    autoFocus
                    maxLength={80}
                    aria-label="历史演示文稿标题"
                    value={editingHistoryTitle}
                    disabled={historyBusyId === item.id}
                    onChange={(e) => setEditingHistoryTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { setEditingHistoryId(null); setEditingHistoryTitle(''); }
                    }}
                  />
                  <button type="submit" disabled={historyBusyId === item.id} title="保存标题" aria-label="保存标题">✓</button>
                  <button type="button" disabled={historyBusyId === item.id} title="取消重命名" aria-label="取消重命名" onClick={() => { setEditingHistoryId(null); setEditingHistoryTitle(''); }}>×</button>
                </form>
              ) : (
                <>
                  <button className="sidebar-history-item" disabled={busy || historyBusyId !== null} onClick={() => onOpenHistory(item)}>
                    <span className="sidebar-history-mark">▤</span>
                    <span className="sidebar-history-copy">
                      <span className="sidebar-history-title">{item.title || '未命名演示文稿'}</span>
                      <span className="sidebar-history-meta">{item.pages || 0} 页 · {item.templateName || '历史项目'}</span>
                    </span>
                  </button>
                  <div className="sidebar-history-actions">
                    <button className="sidebar-history-action" disabled={historyBusyId !== null} title="重命名" aria-label={`重命名 ${item.title || '历史演示文稿'}`} onClick={() => { setEditingHistoryId(item.id); setEditingHistoryTitle(item.title || ''); }}>✎</button>
                    <button className="sidebar-history-action danger" disabled={historyBusyId !== null} title="删除" aria-label={`删除 ${item.title || '历史演示文稿'}`} onClick={() => onDeleteHistory(item)}>×</button>
                  </div>
                </>
              )}
            </div>
          ))}
          {historyItems.length === 0 ? <div className="sidebar-history-empty">还没有历史演示文稿</div> : null}
        </nav>
        <div className="sidebar-footer">
          {hasSlides ? (
            <button className="sidebar-action" disabled={busy} onClick={onArchiveCurrent}>
              <span aria-hidden="true">▣</span><span>存档当前</span>
            </button>
          ) : null}
          <button className="sidebar-action" onClick={() => setShowSettings(true)}>
            <span aria-hidden="true">⚙</span><span>模型设置</span>
          </button>
          <div className="sidebar-model-status">
            <span className={`conn-dot${connected ? ' on' : ''}`} />
            <span>{hasModel ? providers.active.chat.model : '尚未配置模型'}</span>
          </div>
        </div>
      </aside>
      {sidebarOpen ? <button className="sidebar-backdrop" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} /> : null}
      <div className="app-main">
        <header className="topbar">
          <button className="mobile-sidebar-toggle icon-btn" title="显示历史演示文稿" aria-label="显示历史演示文稿" onClick={() => setSidebarOpen(true)}>☰</button>
          <div className="topbar-context">
            <div className="deck-title">{headerTitle}</div>
            <div className="topbar-caption">{step === 'outline' ? '输入主题，整理成可编辑的大纲' : step === 'theme' ? '选择视觉风格，生成整套幻灯片' : '预览、修改并导出演示文稿'}</div>
          </div>
          <div className="stepper">
            {STEPS.map((s) => (
              <button
                key={s.key}
                className={`step${step === s.key ? ' on' : ''}${canGo(s.key) ? '' : ' locked'}`}
                disabled={!canGo(s.key)}
                onClick={() => canGo(s.key) && setStep(s.key)}
              >
                <span className="step-no">{s.no}</span>
                <span className="step-label">{s.label}</span>
              </button>
            ))}
          </div>
          <div className="topbar-right">
            {styleScore ? <span className={`score-chip${styleScore.pass ? ' pass' : ''}`} title="模板风格评分：配色、字体、版式、图片槽位与正文页一致性综合评分">风格 {styleScore.score.toFixed(1)}</span> : null}
            <button className="model-chip" title="模型设置" onClick={() => setShowSettings(true)}>
              <span className={`chip-dot${hasModel ? ' ok' : ''}`} />
              <span className="model-info">{hasModel ? `${providers.active.chat.instanceName} · ${providers.active.chat.model}` : '未配置模型'}</span>
            </button>
            <button className="btn btn-primary" disabled={!hasSlides || busy} onClick={onExport}>导出 PPTX</button>
          </div>
        </header>

        {step === 'outline' ? (
          <div className={`workarea chat-workarea${hasDoc ? ' has-outline' : ''}`}>
            <main className="chat-thread">
              <div
                className="chat-thread-scroll"
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag'); }}
                onDragLeave={(e) => e.currentTarget.classList.remove('drag')}
                onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('drag'); uploadFiles(e.dataTransfer.files); }}
              >
                {!hasDoc ? (
                  <div className="chat-welcome">
                    <span className="welcome-mark">卷</span>
                    <p className="welcome-kicker">卷王PPT 助手</p>
                    <h1>先说说你想讲什么</h1>
                    <p>输入一个主题，我会先整理出逐页大纲。你可以批注修改，再选择模板生成幻灯片。</p>
                    <div className="prompt-suggestions">
                      <button onClick={() => setTopic('大模型的发展')}>大模型的发展</button>
                      <button onClick={() => setTopic('产品方案介绍')}>产品方案介绍</button>
                    </div>
                  </div>
                ) : (
                  <div className="chat-message-list">
                    <div className="chat-turn user-turn">
                      <span className="chat-avatar user-avatar">你</span>
                      <div className="user-bubble">
                        <span className="message-label">演示主题</span>
                        <p>{doc.title || topic || '未命名演示文稿'}</p>
                      </div>
                    </div>
                    <div className="chat-turn assistant-turn">
                      <span className="chat-avatar assistant-avatar">卷</span>
                      <div className="assistant-message">
                        <div className="assistant-message-head">
                          <div>
                            <strong>内容大纲</strong>
                            <span>可选中文字添加批注</span>
                          </div>
                          <span className={`message-state${busy ? ' working' : ''}`}>{busy ? '正在整理…' : '草稿'}</span>
                        </div>
                        <OutlineView
                          markdown={doc.markdown}
                          version={doc.version}
                          comments={outlineComments}
                          activeCommentId={activeCommentId}
                          onAddComment={onAddComment}
                          onActivateComment={onActivateComment}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div className="chat-compose-area">
                <div className={`chat-composer${busy ? ' busy' : ''}`}>
                  <textarea
                    className="chat-input"
                    aria-label="演示文稿主题"
                    placeholder="输入演示主题，例如：给管理层讲解大模型的发展"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onGenerateOutline(); }
                    }}
                  />
                  <div className="chat-composer-footer">
                    <label className="chat-attach" title="添加参考资料">
                      <span aria-hidden="true">＋</span>添加资料
                      <input
                        type="file"
                        multiple
                        accept=".pdf,.docx,.md,.txt,.png,.jpg,.jpeg,.webp"
                        onChange={(e) => { uploadFiles(e.target.files); e.target.value = ''; }}
                      />
                    </label>
                    <span className="chat-compose-note">{hasModel ? 'Enter 发送 · Shift+Enter 换行' : '先配置文本模型即可开始'}</span>
                    <button className="chat-send-btn" disabled={busy || !topic.trim() || !hasModel} onClick={onGenerateOutline} aria-label={hasDoc ? '重新生成大纲' : '生成大纲'}>
                      {busy ? '…' : '↑'}
                    </button>
                  </div>
                </div>
                <div className="chat-compose-caption">
                  <span>支持拖入参考资料</span>
                  {!hasModel ? <button className="link-btn" onClick={() => setShowSettings(true)}>配置模型</button> : null}
                  {hasDoc ? <button className="btn btn-primary btn-sm" disabled={busy} onClick={onFinalize}>确认大纲并选择模板</button> : null}
                </div>
              </div>
            </main>
            {hasDoc ? (
              <aside className="right-panel chat-context">
                <OutlineBatchPanel
                  comments={outlineComments}
                  busy={busy}
                  hasDoc={hasDoc}
                  activeCommentId={activeCommentId}
                  onRemove={onRemoveComment}
                  onActivate={onActivateComment}
                  onSend={onSendBatch}
                  onFinalize={onFinalize}
                  showFinalize={false}
                />
              </aside>
            ) : null}
          </div>
      ) : step === 'theme' ? (
        <div className="workarea theme-workarea">
          <main
            className="stage stage-theme"
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag'); }}
            onDragLeave={(e) => e.currentTarget.classList.remove('drag')}
            onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('drag'); onUploadTemplate(e.dataTransfer.files); }}
          >
            <div className="theme-pick-head">
              <div>
                <div className="theme-pick-title">选择你的模板</div>
                <div className="theme-pick-sub">上传任意 .pptx 作为模板，程序按它的风格 + 你的大纲逐页生成。可上传多份，本地维护。</div>
              </div>
              <div className="theme-pick-actions">
                <label className="ai-toggle" title="默认复刻模板的封面/章节设计；勾选则改用 AI 按主题生成插画">
                  <input type="checkbox" checked={aiImages} onChange={(e) => setAiImages(e.target.checked)} />
                  <span>封面/章节用 AI 配图</span>
                </label>
                <input
                  ref={tplInputRef}
                  type="file"
                  accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                  style={{ display: 'none' }}
                  onChange={(e) => { onUploadTemplate(e.target.files); e.target.value = ''; }}
                />
                <button className="btn btn-primary" disabled={uploadingTpl} onClick={() => tplInputRef.current && tplInputRef.current.click()}>
                  {uploadingTpl ? '上传中…' : '＋ 上传模板 (.pptx)'}
                </button>
              </div>
            </div>
            {themes.length === 0 ? (
              <button className="tpl-empty" disabled={uploadingTpl} onClick={() => tplInputRef.current && tplInputRef.current.click()}>
                <div className="tpl-empty-icon">⬆</div>
                <div className="tpl-empty-title">{uploadingTpl ? '正在提取并烘焙模板…' : '上传你的第一份 .pptx 模板'}</div>
                <div className="tpl-empty-sub">拖到这里，或点此选择文件。程序会提取它的配色、版式与封面/章节底图作为你的专属模板。</div>
              </button>
            ) : (
              <div className="theme-pick-grid">
                {themes.map((t) => (
                  <div key={t.id} className={`theme-pick-card${t.id === activeThemeId ? ' active' : ''}`}>
                    <button className="theme-pick-hit" onClick={() => onPreviewTheme(t)} title={`预览「${t.name || t.id}」`}>
                      <span className="theme-pick-swatch" style={{ background: swatchOf(t) }} />
                      <span className="theme-pick-name">{t.name || t.id}</span>
                    </button>
                    <button className="theme-pick-del" title="删除此模板" onClick={() => onDeleteTemplate(t.id, t.name)}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </main>
        </div>
      ) : (
        <div className="workarea slide-workarea">
          <aside className="left-rail rail-pages">
            {hasSlides ? (
              <>
                <div className="page-rail-label">页面 {slides.length}</div>
                <PageRail slides={deck.slides} activeIndex={activeIndex} onSelect={scrollToSlide} />
              </>
            ) : (
              <div className="theme-gallery-empty">生成后这里会出现页面缩略图</div>
            )}
          </aside>

          <main className="stage stage-single">
            {!hasSlides ? (
              <div className="empty">
                <div className="empty-art">🎞️</div>
                <div className="empty-title">{busy ? '正在按模板逐页生成…' : '还没有幻灯片'}</div>
                <div className="empty-sub">{busy ? '页面会逐张实时出现；生成后点击文字即可就地编辑' : '回到「选择模板」步，挑一套风格开始生成'}</div>
              </div>
            ) : (
              <>
                <div className="stage-bar">
                  <div className="stage-bar-left">
                    <span className="stage-page-no">{activeIndex + 1} / {slides.length}</span>
                    <span className="stage-page-role">{ROLE_LABEL[slides[activeIndex] && slides[activeIndex].role] || ''}</span>
                    {busy ? <span className="stage-gen">正在生成…</span> : null}
                  </div>
                  <div className="stage-bar-right">
                    <button className="btn btn-ghost" disabled={activeIndex <= 0} onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}>← 上一页</button>
                    <button className="btn btn-ghost" disabled={activeIndex >= slides.length - 1} onClick={() => setActiveIndex((i) => Math.min(slides.length - 1, i + 1))}>下一页 →</button>
                  </div>
                </div>
                <div className="stage-viewport">
                  <div className="stage-slide" id={`slide-${activeIndex}`} key={activeIndex}>
                    {slides[activeIndex] ? (
                      <SlideCanvas
                        svg={slides[activeIndex].svg}
                        index={activeIndex}
                        editable
                        active
                        onSelect={setActiveIndex}
                        onEdit={onEdit}
                      />
                    ) : <div className="canvas-fail">此页尚未生成</div>}
                    {slides[activeIndex] && slides[activeIndex]._recovered ? (
                      <div className="slide-recovered">
                        此页未能正确生成，<button className="link-btn" disabled={busy} onClick={() => onRegenerate(activeIndex)}>重新生成</button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </>
            )}
          </main>

          <aside className="right-panel">
            <AnnotatePanel
              activeIndex={activeIndex}
              hasSlides={hasSlides}
              busy={busy}
              onAnnotate={onAnnotate}
              onRegenerate={onRegenerate}
            />
          </aside>
        </div>
      )}

      {previewTheme ? (
        <ThemePreview
          theme={previewTheme}
          busy={busy}
          onClose={() => setPreviewTheme(null)}
          onConfirm={onConfirmTheme}
        />
      ) : null}

      {showSettings ? (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          onProvidersChange={(d) => setProviders(d)}
          flash={flash}
        />
      ) : null}
      <AppDialogHost dialog={dialog} />
      {toast ? <div className={`toast ${toast.type}`}>{toast.text}</div> : null}
      </div>
    </div>
  );
}
