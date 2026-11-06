// 页面计划（pagePlan）—— 每页「用哪一种设计、填什么、放不放得下」。
//
// 这是 styleModel 与渲染器之间的中间层，对应 generate-slide 提示词里的 `pagePlan` 输入：
// 家族选择必须显式发生，不能因为「存在画像」就把所有正文交给同一种布局——那正是
// 「所有模板都被改成通用商务卡片」的根因。
//
// 本模块只做确定性推导：不调模型、不看像素。家族从 styleModel 里**实际识别出的**取，
// 参考稿没有的页型标 inferred，不假称模板拥有。
const ROLES = ['cover', 'section', 'content', 'closing'];

// 内容形态：决定候选家族与容量上限。判定只看大纲结构，不看视觉。
function shapeOf(section) {
  const body = String(section && section.body ? section.body : '');
  const quotes = body.split('\n').filter((l) => /^\s*>/.test(l)).map((l) => l.replace(/^\s*>\s*/, '').trim()).filter(Boolean);
  const items = body.split('\n')
    .map((x) => x.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter((x) => x && !x.startsWith('>'));
  if (quotes.length >= 3) return { kind: 'verse', quotes, items };
  if (items.length === 1) return { kind: 'single', quotes, items };
  if (items.length >= 5) return { kind: 'dense', quotes, items };
  return { kind: 'list', quotes, items };
}

// styleModel 里家族字段的命名由分析模型决定（id/name/variant/layout/slots 等），
// 这里做容错读取：只在确有结构证据时采信，读不到就返回空而不是瞎猜。
function familiesOf(model, role) {
  const fams = Array.isArray(model && model.families) ? model.families : [];
  return fams.filter((f) => f && f.role === role);
}

function textOfFamily(f) {
  return JSON.stringify({
    id: f.id, name: f.name, purpose: f.purpose, suits: f.suits || f.useFor || f.contentFit,
    layout: f.layout, structure: f.structure, variants: (f.variants || []).map((v) => ({ id: v.id, name: v.name, when: v.when || v.useFor })),
  });
}

// 内容形态 → 家族关键词。只用于在**已识别的家族**里排序，不会凭空造家族。
const SHAPE_HINTS = {
  verse: ['引用', '诗文', '诗词', '金句', 'quote', 'verse', 'poem', 'statement', 'statement-only'],
  single: ['观点', '结论', '单点', '要点强调', 'key message', 'statement', 'callout', 'hero'],
  list: ['列表', '条目', '要点', 'bullet', 'list', 'card', '卡片', 'grid'],
  dense: ['多栏', '两栏', '三栏', 'columns', 'multi-column', 'dense', '高密度', 'table', '表格', 'matrix'],
};

function pickVariant(family, shapeKind) {
  const vs = Array.isArray(family && family.variants) ? family.variants : [];
  if (!vs.length) return null;
  const hits = SHAPE_HINTS[shapeKind] || [];
  const scored = vs
    .map((v) => ({ v, score: hits.filter((h) => textOfFamily({ ...family, variants: [v] }).toLowerCase().includes(h.toLowerCase())).length }))
    .sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score > 0 ? scored[0].v.id : vs[0].id;
}

function referencePages(family, variantId) {
  const v = (family && family.variants || []).find((x) => x && x.id === variantId);
  const idx = (v && Array.isArray(v.sourcePageIndexes) && v.sourcePageIndexes.length ? v.sourcePageIndexes : null)
    || (family && Array.isArray(family.sourcePageIndexes) ? family.sourcePageIndexes : []);
  return idx.filter((i) => Number.isInteger(i) && i >= 0);
}

// 确定性渲染器（renderContent）能表达的内容形态：条目、卡片、引用/诗文、单点陈述、
// 结论条——它本身已按内容形态分支，所以这些家族都能交给它。
// 判断方向刻意是「识别出明确不属于它的结构与数据家族才分流」：家族命名来自模型，
// 词表不可能穷尽；未知命名沿用既有确定性版式，不会因为叫不出名字就退回 LLM。
const NOT_DETERMINISTIC = [
  'chart', 'graph', 'plot', 'table', 'timeline', 'roadmap', 'flow', 'process', 'matrix',
  'formula', 'equation', 'code', 'algorithm', 'diagram', 'architecture', 'comparison-table',
  '图表', '柱状', '折线', '饼图', '数据表', '表格', '时间线', '时间轴', '流程', '矩阵',
  '公式', '代码', '算法', '架构', '拓扑',
];

function deterministicFor(family) {
  const probe = textOfFamily(family || {}).toLowerCase();
  return NOT_DETERMINISTIC.some((w) => probe.includes(w.toLowerCase())) ? null : 'cards';
}

// 骨架页（封面/章节/结尾）沿用既有确定性渲染器；正文按家族分流。
function planDeck({ styleModel, sections, profile } = {}) {
  const pages = [];
  (sections || []).forEach((section, index) => {
    const shape = shapeOf(section);
    const role = section.role || (index === 0 ? 'cover' : 'content');
    const fams = role === 'content' ? familiesOf(styleModel, 'content') : familiesOf(styleModel, role);
    const hints = SHAPE_HINTS[shape.kind] || [];
    const ranked = fams
      .map((f) => ({ f, score: hints.filter((h) => textOfFamily(f).toLowerCase().includes(h.toLowerCase())).length }))
      .sort((a, b) => b.score - a.score);
    const top = ranked[0] && ranked[0].score > 0 ? ranked[0].f : (fams[0] || null);
    const familyId = top ? top.id : null;
    const variantId = top ? pickVariant(top, shape.kind) : null;
    const renderer = role === 'content' ? deterministicFor(top) : role;
    pages.push({
      index,
      role,
      familyId,
      variantId,
      shape: shape.kind,
      itemCount: shape.items.length,
      quoteCount: shape.quotes.length,
      referencePageIndexes: top ? referencePages(top, variantId) : [],
      // 参考稿里没有对应家族 → 本页设计属于推导，必须在 meta 里如实标注
      evidence: top ? (top.evidenceType || 'observed') : 'inferred',
      renderer: role === 'content' ? renderer : role,
      purpose: top ? (top.purpose || top.name || '') : '',
    });
  });
  return { pages, styleModelVersion: (styleModel && styleModel.schemaVersion) || null };
}

// 渲染提示：从 styleModel 里读编号风格、封面文案标签、强调色纪律、标题色。
// 只做结构读取——早期版本按中文关键词嗅探散文，换模型或换语言就失效。


function renderHints(styleModel) {
  const covers = familiesOf(styleModel, 'cover');
  const sections = familiesOf(styleModel, 'section');
  const coverPrefer = [];
  for (const f of covers) {
    const tg = f && f.textRules && (f.textRules.prefer || f.textRules.priority);
    if (Array.isArray(tg)) coverPrefer.push(...tg.filter((x) => typeof x === 'string'));
  }
  const numbering = (sections.find((f) => f && (f.numbering || f.textRules && f.textRules.numbering)) || {});
  const style = numbering.numbering || (numbering.textRules && numbering.textRules.numbering) || null;
  const tokensColor = (styleModel && styleModel.tokens && styleModel.tokens.color) || {};
  return {
    coverPrefer: coverPrefer.length ? [...new Set(coverPrefer)].slice(0, 6) : null,
    numbering: ['bilingual', 'cn', 'numCn'].includes(style) ? style : 'bilingual',
    titleColor: typeof tokensColor.title === 'string' ? tokensColor.title : (typeof tokensColor.pageTitle === 'string' ? tokensColor.pageTitle : null),
    watermarkAccent: typeof tokensColor.accent2 === 'string' ? 2 : 1,
  };
}

module.exports = { planDeck, renderHints };
