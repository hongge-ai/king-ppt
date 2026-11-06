// 编译器能力契约 —— 从代码事实派生，而非手写散文。
//
// 提示词（analyze-template / generate-slide）都需要「当前 SVG 创作能力」这份输入：
// 分析阶段据此记录实现风险，生成阶段据此决定哪些画法可用。手写这份契约会和
// svg-sanitize / svg-to-pptx 的真实行为脱节——历史上就出过 AUTHORING_RULES 允许
// <g> 带 rotate/scale、而编译器只解析 translate 的静默不一致。
// 所以这里把两处的实际行为作为唯一来源，提示词只消费本模块的输出。
const { STRIP_SUBTREE } = require('./svg-sanitize');
const { SHAPE_TAGS } = require('./svg-to-pptx');

// 允许出现在 SVG 里的元素：以编译器实际会遍历的 SHAPE_TAGS 为准，
// 再去掉清洗器会整棵删掉的（STRIP_SUBTREE 里的 tag 若与 SHAPE_TAGS 相交说明代码自相矛盾）。
const ALLOWED = SHAPE_TAGS.filter((t) => !STRIP_SUBTREE.includes(t));

// 会被整棵删除的元素（清洗器行为）：脚本/外部内容/CSS、SMIL 动画、引用型定义、
// 渐变/滤镜/蒙版/裁剪。它们要么是安全问题，要么 pptxgenjs 无法忠实还原。
const FORBIDDEN = [...STRIP_SUBTREE, 'use'];

// 已知的近似编译（形状还在，但不是等价物）。生成端要么避开，要么接受损失。
const APPROX = [
  { from: 'polygon/polyline', to: '预设形状（3 点→triangle，4 点对角线平分→diamond，其余→外接矩形 rect）', note: '任意多边形请改写为 <path d>，编译器会转成 custGeom 保留真实顶点' },
  { from: 'rgba()/fill-opacity', to: '填充色 + transparency', note: '半透明可以表达，但混合模式、描边透明度不保证' },
  { from: 'preserveAspectRatio="…slice"', to: 'sizing:{type:"cover"}', note: '裁切语义一致，但需要图片已有真实像素尺寸' },
];

const STRUCTURE = [
  '根元素固定 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">…</svg>。',
  '<g> 仅支持 transform="translate(x,y)"。rotate / scale / matrix 会被忽略（不报错），必须预先展开成页面坐标。',
  '每个元素显式声明自身样式；<g> 上的 fill / stroke / font 不会被继承。',
  '<text> 的 x、y 是基线，不是文本框顶边；换行必须写成多个独立 <text>，<tspan> 不保证定位。',
  '<text> 建议提供 data-box-w（实际槽位宽度，用户单位），否则导出端按字体度量估算宽度，可能二次换行。',
  '<text> 导出时 wrap=false：一页一行文字就是一个 <text>，不要让 PowerPoint 自动另起折行。',
  '<image> 只接受内联 data: URI（先经 /api/assets 换 base64）；外链会被清洗掉。',
  '背景、图片、图形、文字按明确层序排列：后绘制者在上层，任何图像都必须先于文字绘制。',
];

// 与 canvases 相关：非 16:9 参考的处理策略。当前导出链路按模板 canvas 等比换算 px→英寸，
// 生成端统一以 1280×720 作为工作坐标。
const CANVAS_NOTE = '生成侧统一以 1280×720 用户单位作画；非 16:9 的参考模板必须显式声明适配策略，不得静默拉伸。';

function compilerContract() {
  return {
    version: 1,
    canvas: { width: 1280, height: 720 },
    allowedElements: ALLOWED,
    forbiddenElements: FORBIDDEN,
    approximations: APPROX,
    structure: STRUCTURE,
    canvasNote: CANVAS_NOTE,
    editable: {
      nativeShapes: ['rect', 'roundRect', 'ellipse', 'line', 'custGeom(<path>)'],
      text: '每行一个可编辑文本框',
      images: '嵌入为图片对象，非矢量',
      notSemantic: ['用 SVG 形状拼出的图表/表格/公式不具备原生数据或公式编辑能力'],
    },
  };
}

// 注入提示词的文本形态：结构规则 + 能力/禁用清单 + 近似编译说明。
function contractText() {
  const c = compilerContract();
  return [
    '## 当前 SVG 编译能力（由清洗器与 pptx 编译器源码事实生成，不得假设超出其上的能力）',
    '',
    '允许的元素：' + c.allowedElements.join('、'),
    '',
    '禁止的元素（会被整棵删除）：' + c.forbiddenElements.join('、'),
    '',
    '结构规则：',
    ...c.structure.map((s) => `- ${s}`),
    '',
    '已知近似编译（可用但有损失）：',
    ...c.approximations.map((a) => `- ${a.from} → ${a.to}（${a.note}）`),
    '',
    c.canvasNote,
    '',
    '能力边界：' + c.editable.notSemantic.join('；') + '。不得宣称编译器未实现的语义编辑能力。',
  ].join('\n');
}

module.exports = { compilerContract, contractText, ALLOWED, FORBIDDEN };
