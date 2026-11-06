// SVG（free 自由排版页载荷）→ Resolved Scene Graph
// 学 PPT Master 的思路：LLM 画 SVG，确定性转换器编译为原生 pptx 对象。
// 支持 rect/circle/ellipse/line/text/polygon(近似)/g(translate)；
// 不支持的元素（滤镜/渐变/图片）在生成端已被 prompt 禁止，这里忽略即可。
const { XMLParser } = require('fast-xml-parser');
const { normalize } = require('./svg-sanitize');
const { textWidthIn } = require('./text-measure');
const { pathToAbsOps, opsBounds } = require('./svg-path');

const DEFAULT_VB = { w: 1280, h: 720 };

const num = (v, d = 0) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : d;
};

// "#1F4E79" / "1F4E79" / "rgb(...)" → "1F4E79"（pptxgenjs 色值）；无效返回 null
function color6(v) {
  if (!v || v === 'none' || v === 'transparent') return null;
  const s = String(v).trim();
  let hex = s.replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split('').map((c) => c + c).join('');
  if (/^[0-9a-f]{6}$/i.test(hex)) return hex.toUpperCase();
  const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (m) {
    const r = Number(m[1]).toString(16).padStart(2, '0');
    const g = Number(m[2]).toString(16).padStart(2, '0');
    const b = Number(m[3]).toString(16).padStart(2, '0');
    return { color: (r + g + b).toUpperCase(), opacity: m[4] !== undefined ? Number(m[4]) : 1 };
  }
  return null;
}

function attrsOf(node) {
  return (node && node[':@']) || {};
}

const SHAPE_TAGS = ['g', 'rect', 'circle', 'ellipse', 'line', 'text', 'polygon', 'polyline', 'path', 'image'];

// preserveOrder 树的层间结构：父节点 = { <tag>: [子节点...], ':@': {属性} }。
// 按输入顺序收集元素。不能按 tag 分批遍历，否则最后处理的 image 会压住
// 原本位于其后的 text，造成预览与导出的 z-order 不一致。
function flatten(children, tx, ty, out) {
  for (const child of children) {
    const tag = SHAPE_TAGS.find((t) => t in child);
    if (!tag) continue;
    if (tag === 'g') {
      const a = attrsOf(child);
      const tr = String(a['@_transform'] || '');
      const m = tr.match(/translate\s*\(\s*([-\d.]+)\s*[ ,]\s*([-\d.]+)/i) || tr.match(/translate\s*\(\s*([-\d.]+)/i);
      const gx = tx + (m ? Number(m[1]) : 0);
      const gy = ty + (m ? Number(m[2] || 0) : 0);
      const gc = child['g'] || [];
      flatten(gc, gx, gy, out);
    } else {
      // preserveOrder 下元素形如 { <tag>: [ { '#text': '内容' }, ... ], ':@': {属性} }
      const inner = child[tag] || [];
      out.push({
        tag,
        attrs: attrsOf(child),
        text: inner.filter((n) => n['#text'] !== undefined).map((n) => n['#text']).join(''),
        tx, ty,
      });
    }
  }
}

// polygon/polyline → 就近预设形状（3 点=三角，4 点对角线互相平分=菱形），其余退化到外接矩形
function polygonShape(points) {
  const pts = String(points || '').trim().split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  if (pts.length < 6) return 'rect';
  const n = pts.length / 2;
  if (n === 3) return 'triangle';
  if (n === 4) {
    // 对角线中点重合 → 菱形（含正方形/矩形旋转 45° 的常见装饰形态）
    const isDiamond = pts[0] + pts[4] === pts[2] + pts[6] && pts[1] + pts[5] === pts[3] + pts[7];
    return isDiamond ? 'diamond' : 'rect';
  }
  return 'rect';
}

// <path d> → custGeom：绝对算子先算包围盒，再相对化并换英寸。pptxgenjs 点坐标是「相对形状盒、单位英寸」。
function pathObject(el, k, base) {
  const ops = pathToAbsOps(el.attrs['@_d']);
  if (!ops.length) return null;
  const b = opsBounds(ops);
  if (!b) return null;
  const ox = el.tx + b.minX;
  const oy = el.ty + b.minY;
  const rx = (x) => (x - b.minX) * k; // 绝对 → 相对盒 → 英寸
  const ry = (y) => (y - b.minY) * k;
  const points = ops.map((op) => {
    if (op.close) return { close: true };
    if (op.curve && op.curve.type === 'cubic') {
      return { x: rx(op.x), y: ry(op.y), curve: { type: 'cubic', x1: rx(op.curve.x1), y1: ry(op.curve.y1), x2: rx(op.curve.x2), y2: ry(op.curve.y2) } };
    }
    if (op.curve && op.curve.type === 'quadratic') {
      return { x: rx(op.x), y: ry(op.y), curve: { type: 'quadratic', x1: rx(op.curve.x1), y1: ry(op.curve.y1) } };
    }
    return op.moveTo ? { x: rx(op.x), y: ry(op.y), moveTo: true } : { x: rx(op.x), y: ry(op.y) };
  });
  return {
    kind: 'shape', shape: 'custGeom',
    x: ox * k, y: oy * k, w: (b.maxX - b.minX) * k, h: (b.maxY - b.minY) * k,
    points,
    ...base,
  };
}

// <image href="data:..."> → 内联图片对象（外链已被 sanitize 清除，只剩 data URI）
function imageObject(el, k) {
  const a = el.attrs;
  const href = a['@_href'] || a['@_xlink:href'];
  if (!href || !/^data:/.test(String(href))) return null;
  const x = (el.tx + num(a['@_x'])) * k;
  const y = (el.ty + num(a['@_y'])) * k;
  const w = num(a['@_width']) * k;
  const h = num(a['@_height']) * k;
  // preserveAspectRatio="… slice" == CSS object-fit:cover: scale to fill the
  // frame and crop, no distortion. pptxgenjs stretches by default, so map slice
  // to sizing:{type:'cover'} — otherwise a square illustration gets squished
  // into the 16:9 frame (preview honored slice; export must too).
  const par = String(a['@_preserveAspectRatio'] || '');
  const cover = /\bslice\b/.test(par);
  return {
    kind: 'image', data: String(href), x, y, w, h,
    ...(cover ? { sizing: { type: 'cover', w, h } } : {}),
  };
}
function textObject(el, k) {
  const a = el.attrs;
  const fsPx = num(a['@_font-size'], 20);
  const fontSize = Math.max(6, fsPx * k * 72);
  const anchor = String(a['@_text-anchor'] || 'start');
  let text = el.text.trim();
  if (!text) return null;
  const explicitW = num(a['@_data-box-w'], 0);
  const explicitH = num(a['@_data-box-h'], 0);
  const wIn = explicitW > 0 ? explicitW * k : Math.min(textWidthIn(text, fontSize) + 0.1, 1e6);
  const hIn = explicitH > 0 ? explicitH * k : (fontSize * 1.35) / 72;
  const xIn = (el.tx + num(a['@_x'])) * k;
  const yIn = (el.ty + num(a['@_y'])) * k;
  const boxX = anchor === 'middle' ? xIn - wIn / 2 : anchor === 'end' ? xIn - wIn : xIn;
  const boxY = yIn - (fsPx * 0.82) * k; // 基线 → 盒顶（近似 ascent 0.82em）
  const fill = color6(a['@_fill'] || a['@_color']);
  const c = fill && typeof fill === 'object' ? fill.color : fill;
  const op = fill && typeof fill === 'object' && fill.opacity !== undefined ? fill.opacity : num(a['@_fill-opacity'], 1);
  return {
    kind: 'text',
    x: boxX, y: boxY, w: wIn, h: hIn,
    text,
    fontSize: Math.round(fontSize * 10) / 10,
    bold: String(a['@_font-weight'] || '').match(/bold|[6-9]00/i) !== null,
    italic: String(a['@_font-style'] || '').toLowerCase() === 'italic',
    fontFace: String(a['@_font-family'] || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '') || undefined,
    color: c || '333333',
    align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
    valign: 'middle',
    wrap: false, // each <text> is one pre-wrapped line; never let PowerPoint re-wrap (preview == export)
    ...(op < 1 ? { transparency: Math.round((1 - op) * 100) } : {}),
  };
}

// SVG 字符串 → 场景图（背景白；形状/文本对象，坐标英寸）
function svgToScene(svgString, canvas) {
  const normalized = normalize(svgString);
  if (!normalized) throw new Error('SVG 格式不正确');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    preserveOrder: true,
    trimValues: true,
    parseTagValue: false, // keep text nodes as strings so "01"/"02" don't become 1/2
  });
  const tree = parser.parse(normalized);
  const root = tree.find((n) => n.svg);
  if (!root) throw new Error('SVG 缺少根元素');

  const ra = attrsOf(root);
  const vb = String(ra['@_viewBox'] || '').trim().split(/[\s,]+/).map(Number);
  const vbW = vb.length === 4 && vb[2] > 0 ? vb[2] : DEFAULT_VB.w;
  const vbH = vb.length === 4 && vb[3] > 0 ? vb[3] : DEFAULT_VB.h;
  const k = canvas.width / vbW; // px → inch（预览与导出等比）

  const els = [];
  const rootChildren = root['svg'] || [];
  flatten(rootChildren, 0, 0, els);

  const objects = [];
  for (const el of els) {
    const a = el.attrs;
    const stroke = color6(a['@_stroke']);
    const strokeWidth = num(a['@_stroke-width'], 0) * k;
    const line = stroke && strokeWidth > 0
      ? { color: stroke && typeof stroke === 'object' ? stroke.color : stroke, width: strokeWidth * 72 }
      : undefined;
    const fillRaw = color6(a['@_fill']);
    const fill = fillRaw === null ? undefined : typeof fillRaw === 'object' ? fillRaw.color : fillRaw;
    const fillOp = fillRaw && typeof fillRaw === 'object' && fillRaw.opacity !== undefined
      ? fillRaw.opacity : num(a['@_fill-opacity'], 1);
    // SVG 默认 fill 黑色：未写 fill 的装饰色块按黑色处理
    const effFill = a['@_fill'] === undefined && el.tag !== 'line' && el.tag !== 'text' ? '000000' : fill;
    const base = {
      ...(effFill ? { fill: effFill } : {}),
      ...(fillOp < 1 ? { transparency: Math.round((1 - fillOp) * 100) } : {}),
      ...(line ? { line } : {}),
    };

    if (el.tag === 'rect') {
      const rx = num(a['@_rx'], 0);
      objects.push({
        kind: 'shape', shape: rx > 0 ? 'roundRect' : 'rect',
        x: (el.tx + num(a['@_x'])) * k, y: (el.ty + num(a['@_y'])) * k,
        w: num(a['@_width']) * k, h: num(a['@_height']) * k,
        ...(rx > 0 ? { rectRadius: rx * k } : {}),
        ...base,
      });
    } else if (el.tag === 'circle') {
      const r = num(a['@_r']) * k;
      objects.push({
        kind: 'shape', shape: 'ellipse',
        x: (el.tx + num(a['@_cx'])) * k - r, y: (el.ty + num(a['@_cy'])) * k - r,
        w: r * 2, h: r * 2, ...base,
      });
    } else if (el.tag === 'ellipse') {
      const rx = num(a['@_rx']) * k;
      const ry = num(a['@_ry']) * k;
      objects.push({
        kind: 'shape', shape: 'ellipse',
        x: (el.tx + num(a['@_cx'])) * k - rx, y: (el.ty + num(a['@_cy'])) * k - ry,
        w: rx * 2, h: ry * 2, ...base,
      });
    } else if (el.tag === 'line') {
      const x1 = el.tx + num(a['@_x1']);
      const y1 = el.ty + num(a['@_y1']);
      const x2 = el.tx + num(a['@_x2']);
      const y2 = el.ty + num(a['@_y2']);
      objects.push({
        kind: 'shape', shape: 'line',
        x: Math.min(x1, x2) * k, y: Math.min(y1, y2) * k,
        w: Math.abs(x2 - x1) * k, h: Math.abs(y2 - y1) * k,
        line: {
          color: (stroke && (typeof stroke === 'object' && stroke !== null ? stroke.color : stroke)) || '333333',
          width: Math.max(0.5, (strokeWidth || 2 / vbW * canvas.width) * 72),
        },
        ...(x2 < x1 ? { flipH: true } : {}),
        ...(y2 < y1 ? { flipV: true } : {}),
      });
    } else if (el.tag === 'polygon' || el.tag === 'polyline') {
      const pts = String(a['@_points'] || '').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
      if (pts.length >= 4) {
        const xs = pts.filter((_, i) => i % 2 === 0);
        const ys = pts.filter((_, i) => i % 2 === 1);
        objects.push({
          kind: 'shape', shape: polygonShape(a['@_points']),
          x: (el.tx + Math.min(...xs)) * k, y: (el.ty + Math.min(...ys)) * k,
          w: (Math.max(...xs) - Math.min(...xs)) * k,
          h: (Math.max(...ys) - Math.min(...ys)) * k,
          ...base,
        });
      }
    } else if (el.tag === 'text') {
      const obj = textObject(el, k);
      if (obj) objects.push(obj);
    } else if (el.tag === 'path') {
      const obj = pathObject(el, k, base);
      if (obj) objects.push(obj);
    } else if (el.tag === 'image') {
      const obj = imageObject(el, k);
      if (obj) objects.push(obj);
    }
  }

  return { background: { color: 'FFFFFF' }, objects };
}

// SHAPE_TAGS 一并导出：src/compiler-contract.js 以它为「允许元素」的唯一事实来源，
// 避免提示词里的能力清单与编译器实际遍历的标签脱节。
module.exports = { svgToScene, SHAPE_TAGS };
