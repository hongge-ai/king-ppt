// SVG-as-IR 创作契约：把一个「主题令牌包」翻译成「怎么用这套设计语言画整页 SVG」的规格。
// 每一页 = 一整张 <svg viewBox="0 0 1280 720">，它就是唯一中间表示（IR）：
//   生成引擎写 SVG → 浏览器内联预览 + 就地编辑 → svg-to-pptx 编译成原生可编辑 .pptx。
// 预览==导出：浏览器与 .pptx 消费同一份被 sanitize 过的 SVG，故此处只谈「怎么写 SVG」，不再有 8 类版式字段。
// 由 GET /api/templates/:id/spec 暴露；生成引擎按此契约逐页作画。

const { contractText } = require('./compiler-contract');

const CANVAS = { vbWidth: 1280, vbHeight: 720 };

// 四种页面角色（role）——只是排版意图的提示，不是硬字段；按内容自行判断
const ROLE_GUIDE = [
  { role: 'cover', when: '第 1 页封面', hint: '超大主标题 + 眉题 + 副标题/署名；大面积主色或留白，一个视觉锚点' },
  { role: 'section', when: '章节过渡页', hint: '深色底 + 超大章节序号(01/02) + 章节名；信息极少，用来换气' },
  { role: 'content', when: '正文页（大多数）', hint: '页标题 + accent 下划线 + 2~5 个要点/卡片/数据；严格对齐、留白充足' },
  { role: 'closing', when: '最后一页', hint: '致谢/收束；一句话 + 可选行动号召，居中安静' },
];

// ---------- 主题令牌 → 人读的设计系统说明 ----------
// 有 styleModel 时，令牌必须以它为准：template.json 里的色板来自 Office 主题槽位
// （常是 4F81BD/C0504D 这种默认色），与模板真实用色无关；而本说明又要求模型
// 「只用这些值」，用错源就等于强制模型画错色。styleModel 的颜色是从参考页实测/观察得到的。
function tokensText(theme, styleModel) {
  const t = theme.tokens || {};
  const s = t.scale || {};
  const g = t.geometry || {};
  const f = t.font || {};
  const smColors = (styleModel && styleModel.tokens && Array.isArray(styleModel.tokens.color))
    ? styleModel.tokens.color.filter((e) => e && typeof e.value === 'string' && /^#[0-9a-fA-F]{6}$/.test(e.value))
    : [];
  const colorLines = smColors.length
    ? smColors.map((e) => `  ${String(e.id || '').padEnd(14)} ${e.value}   ← ${e.role || ''}`).join('\n')
    : Object.entries(t.color || {}).map(([k, v]) => `  ${k.padEnd(12)} ${v}`).join('\n');
  const scaleLines = Object.entries(s).map(([k, v]) => `  ${k.padEnd(12)} ${v}px`).join('\n');
  const colorSource = smColors.length
    ? '（来自模板分析 styleModel：按每条的用途语义使用，不要把强调色铺成大面积底色）'
    : '（来自模板主题槽位；尚未分析出 styleModel，可能与模板真实用色有出入）';
  return `
设计令牌（这套主题的调色板与字号，务必只用这些值，保证整册一致）：

配色 color${colorSource}，fill / stroke 只允许取这些十六进制值，可叠加 fill-opacity/stroke-opacity 做层次：
${colorLines}

字号 scale（font-size 请就近取这些档位，别随意造字号）：
${scaleLines}

字体 font：
  title  ${f.title || "'Microsoft YaHei', sans-serif"}   ← 标题/大字用
  body   ${f.body || "'Microsoft YaHei', sans-serif"}   ← 正文/说明用

几何 geometry：
  圆角 cornerRadius ${g.cornerRadius ?? 8}px · 细线 hairline ${g.hairline ?? 2}px · 安全边距 margin ${g.margin ?? 80}px

基调 tone：${theme.tone || '简洁专业，大量留白，对齐严谨'}`.trimStart();
}

// ---------- SVG 创作硬规则：由编译器事实派生，不在此手写（见 src/compiler-contract.js） ----------
// 历史教训：这里曾手写「<g> 可选 rotate/scale」，而 svg-to-pptx 只解析 translate，
// 变换被静默丢弃导致预览与导出不一致。能力清单只能有一个来源。
const AUTHORING_RULES = [
  '每页输出一个完整 SVG 字符串。违反下列约束的部分会被服务端清洗掉，或导出后与预览不符：',
  '',
  contractText(),
  '',
  '排版自检：',
  '- 文字元素放在最后（装饰色块/线条在前），确保文字不被遮挡。',
  '- 文字距画布四边 ≥ margin；正文 font-size 不小于 caption 档位。',
  '- 严格对齐：同类元素共用 x 基线；成组卡片等距分布。',
  '- 一页只讲一件事；宁可留白，不要塞满。',
].join('\n');

// ---------- 从令牌合成 4 个角色原型页（既作预览缩略，也作生成起手骨架） ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function prototypeFor(role, theme) {
  const t = theme.tokens || {};
  const c = t.color || {};
  const s = t.scale || {};
  const g = t.geometry || {};
  const f = t.font || {};
  const titleFont = (f.title || "'Microsoft YaHei', sans-serif").replace(/"/g, "'");
  const bodyFont = (f.body || "'Microsoft YaHei', sans-serif").replace(/"/g, "'");
  const m = g.margin ?? 80;
  const bg = c.bg || '#FFFFFF';
  const primary = c.primary || '#1F4E79';
  const primaryDeep = c.primaryDeep || primary;
  const accent = c.accent || primary;
  const text = c.text || '#333333';
  const muted = c.textMuted || '#777777';
  const onDark = c.onDark || '#FFFFFF';
  const onDarkMuted = c.onDarkMuted || onDark;
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">`;
  const T = (x, y, size, fill, anchor, str, font = bodyFont) =>
    `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${esc(str)}</text>`;

  if (role === 'cover') {
    return `${open}
  <rect width="1280" height="720" fill="${bg}"/>
  <rect x="0" y="0" width="14" height="720" fill="${accent}"/>
  <rect x="${m}" y="250" width="120" height="${g.hairline ?? 2}" fill="${accent}"/>
  ${T(m, 210, s.eyebrow || 22, muted, 'start', '眉题 · EYEBROW')}
  ${T(m, 350, s.display || 96, primary, 'start', '演示文稿主标题', titleFont)}
  ${T(m, 420, s.pageTitle || 44, text, 'start', '一句话副标题，点明主旨')}
  ${T(m, 660, s.footer || 16, muted, 'start', '署名 / 团队 · 2026')}
</svg>`;
  }
  if (role === 'section') {
    return `${open}
  <rect width="1280" height="720" fill="${primaryDeep}"/>
  <rect x="${m}" y="470" width="200" height="${g.hairline ?? 2}" fill="${accent}"/>
  ${T(m, 380, s.sectionNo || 120, onDarkMuted, 'start', '01', titleFont)}
  ${T(m, 560, s.sectionTitle || 64, onDark, 'start', '章节名称', titleFont)}
</svg>`;
  }
  if (role === 'closing') {
    return `${open}
  <rect width="1280" height="720" fill="${primary}"/>
  ${T(640, 350, s.display || 96, onDark, 'middle', '谢谢观看', titleFont)}
  ${T(640, 430, s.body || 26, onDarkMuted, 'middle', '欢迎交流与指正')}
</svg>`;
  }
  // content
  const rows = ['第一条要点，陈述一个事实或结论', '第二条要点，给出支撑与数据', '第三条要点，收敛到行动'];
  const rowSvg = rows.map((r, i) => {
    const y = 300 + i * 90;
    return `  <circle cx="${m + 10}" cy="${y - 8}" r="6" fill="${accent}"/>\n  ${T(m + 40, y, s.body || 26, text, 'start', r)}`;
  }).join('\n');
  return `${open}
  <rect width="1280" height="720" fill="${bg}"/>
  ${T(m, 150, s.pageTitle || 44, primary, 'start', '页面标题', titleFont)}
  <rect x="${m}" y="180" width="90" height="4" fill="${accent}"/>
${rowSvg}
  ${T(m, 660, s.footer || 16, muted, 'start', '页脚 · 主题名')}
</svg>`;
}

// 组装 GET /api/templates/:id/spec 响应体。layoutFiles 为 loadThemeLayouts(id) 的产物（可覆盖合成原型）。
function buildSpec(theme, layoutFiles = []) {
  const byName = new Map(layoutFiles.map((l) => [l.name, l.svg]));
  const layouts = ROLE_GUIDE.map((r) => ({
    role: r.role,
    when: r.when,
    hint: r.hint,
    svg: byName.get(r.role) || prototypeFor(r.role, theme),
    source: byName.has(r.role) ? 'file' : 'synth',
  }));
  return {
    themeId: theme.id,
    name: theme.name,
    canvas: theme.canvas || CANVAS,
    tokens: theme.tokens || {},
    imagePolicy: theme.imagePolicy || null,
    tone: theme.tone || '',
    roles: ROLE_GUIDE,
    layouts,                         // 4 个角色原型页（含 svg），生成时可直接改文字/复用骨架
    tokensText: tokensText(theme),   // 人读的设计系统说明
    authoringText: [AUTHORING_RULES, theme.authoringText || ''].filter(Boolean).join('\n\n'),  // SVG 创作硬规则
    deckShape: '{ title, themeId, slides: [ { svg, role?, title? } ] }',
    guidance: '每页写一整张 1280×720 的 SVG。先挑最贴近的角色原型当骨架，替换文字/数据，再按内容增删元素。'
      + '重点页（核心卖点、重磅数字、创意大图）值得多花心思做独特版式；叙述页保持规整一致即可。'
      + '第 1 页用 cover 角色，最后一页用 closing 角色。',
  };
}

module.exports = { buildSpec, prototypeFor, tokensText, ROLE_GUIDE, AUTHORING_RULES, CANVAS };
