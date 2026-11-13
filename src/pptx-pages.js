// source.pptx → 逐页可渲染对象图（模板整册预览用）
// 与 extract.js 共享解析技术（EMU 换算 / rels / grpSp 仿射），但目标不同：
// extract 归纳模板「参数」，这里尽量还原原件「每一页长什么样」——
// 含母版/版式分层叠加、主题色（clrMap + shade/tint/lum 变换）、
// 占位符坐标与字号从版式继承、渐变/描边/旋转。
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { XMLParser } = require('fast-xml-parser');

const EMU = 914400;
const MAX_SLIDES = 200;
const MAX_MEDIA = 20 * 1024 * 1024;

// parseTagValue:false —— 文本节点保持字符串，否则 "01" 会被转成数字丢失前导零
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false });
const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const textNodeValue = (v) => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, '#text')) return String(v['#text'] ?? '');
  return '';
};
const emu2in = (v) => Number(v) / EMU;
const r1 = (v) => Math.round(v * 100) / 100;

// ---------- 颜色：hex 变换 ----------
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));
const toHex = (r, g, b) => [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('').toUpperCase();

function shadeTint(hex, f, isTint) {
  const t = isTint ? 255 : 0;
  return toHex(
    parseInt(hex.slice(0, 2), 16) * f + t * (1 - f),
    parseInt(hex.slice(2, 4), 16) * f + t * (1 - f),
    parseInt(hex.slice(4, 6), 16) * f + t * (1 - f),
  );
}

function hslAdj(hex, kind, f) {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  if (kind === 'lumMod') l = l * f;
  else if (kind === 'lumOff') l = l + f;
  else if (kind === 'satMod') s = Math.min(1, s * f);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return toHex(ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255);
}

// 颜色节点形如 { '@_val': '4472C4', lumMod: { '@_val': '50000' } }
function applyMods(hex, clrNode) {
  let out = String(hex).replace('#', '').toUpperCase();
  if (out.length !== 6) return null;
  let transparency = 0;
  for (const [k, node] of Object.entries(clrNode || {})) {
    if (k[0] === '@' || !node || typeof node !== 'object') continue;
    const f = Number(node['@_val']) / 100000;
    if (!Number.isFinite(f)) continue;
    if (k === 'alpha') transparency = Math.round(100 - f * 100);
    else if (k === 'shade') out = shadeTint(out, f, false);
    else if (k === 'tint') out = shadeTint(out, f, true);
    else if (k === 'lumMod' || k === 'lumOff' || k === 'satMod') out = hslAdj(out, k, f);
  }
  return { hex: out, transparency };
}

// parent 是 solidFill / gs / bgRef 等「装着颜色节点」的容器
function colorFrom(parent, ctx) {
  if (!parent) return null;
  if (parent.srgbClr) return applyMods(parent.srgbClr['@_val'], parent.srgbClr);
  if (parent.schemeClr) {
    const base = resolveScheme(parent.schemeClr['@_val'], ctx);
    return base ? applyMods(base, parent.schemeClr) : null;
  }
  if (parent.sysClr) return applyMods(parent.sysClr['@_lastClr'], parent.sysClr);
  return null;
}

// 主题 scheme 名 → hex；bg1/tx1/bg2/tx2 需先过母版的 clrMap
function resolveScheme(name, ctx) {
  if (!name || !ctx) return null;
  const mapped = ['bg1', 'tx1', 'bg2', 'tx2'].includes(name)
    ? (ctx.clrMap && ctx.clrMap[name]) || { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }[name]
    : name;
  return (ctx.theme && ctx.theme[mapped]) || null;
}

// ---------- 形状属性 ----------
function fillOf(spPr, ctx) {
  if (!spPr) return null;
  if (spPr.noFill) return { none: true };
  if (spPr.solidFill) {
    const c = colorFrom(spPr.solidFill, ctx);
    return c ? { color: c.hex, transparency: c.transparency } : null;
  }
  if (spPr.gradFill) {
    const stops = asArray(spPr.gradFill.gsLst && spPr.gradFill.gsLst.gs)
      .map((gs) => {
        const c = colorFrom(gs, ctx);
        return { pos: Number(gs['@_pos']) / 100000, color: c ? c.hex : null, transparency: c ? c.transparency : 0 };
      })
      .filter((s) => s.color);
    if (stops.length < 2) return null;
    const ang = Number((spPr.gradFill.lin || {})['@_ang'] || 0);
    return { gradient: { stops, direction: ang >= 2700000 && ang <= 8100000 ? 'vertical' : 'horizontal' } };
  }
  return null;
}

function lineOf(spPr, ctx) {
  const ln = spPr && spPr.ln;
  if (!ln || ln.noFill) return null;
  const c = ln.solidFill ? colorFrom(ln.solidFill, ctx) : null;
  if (!c) return null;
  return { color: c.hex, width: ln['@_w'] ? r1(Number(ln['@_w']) / 12700) : 1 };
}

function textsOf(sp, ctx) {
  const txBody = sp.txBody;
  if (!txBody) return [];
  const paras = [];
  for (const p of asArray(txBody.p)) {
    const align = (p.pPr && p.pPr['@_algn']) || null;
    const runs = asArray(p.r).map((r) => {
      const rPr = r.rPr || {};
      const c = rPr.solidFill ? colorFrom(rPr.solidFill, ctx) : null;
      return {
        text: textNodeValue(r.t),
        size: rPr['@_sz'] ? Number(rPr['@_sz']) / 100 : null,
        bold: rPr['@_b'] === '1' || rPr['@_b'] === true,
        italic: rPr['@_i'] === '1' || rPr['@_i'] === true,
        color: c ? c.hex : null,
        font: (rPr.latin && rPr.latin['@_typeface']) || (rPr.ea && rPr.ea['@_typeface']) || null,
      };
    });
    if (runs.map((r) => r.text).join('').trim() === '') continue;
    // 段内换行还原（解析器丢失子节点顺序）：<a:br/> 或同段多组 <a:pPr>+<a:r>
    // （pptxgenjs 的行间换行写法），都按「每个 run 一段」近似；正常的同段多样式
    // run 只有一个 pPr，不受影响
    const split = asArray(p.br).length > 0 || asArray(p.pPr).length > 1;
    if (split && runs.length > 1) {
      for (const r of runs) {
        if (r.text.trim() !== '') paras.push({ align, runs: [r] });
      }
    } else {
      paras.push({ align, runs });
    }
  }
  return paras;
}

function anchorOf(sp) {
  const a = sp.txBody && sp.txBody.bodyPr && sp.txBody.bodyPr['@_anchor'];
  return { t: 't', ctr: 'ctr', b: 'b' }[a] || null;
}

function xfrmOf(spPr) {
  const xfrm = spPr && spPr.xfrm;
  if (!xfrm || !xfrm.off || !xfrm.ext) return null;
  return {
    bbox: [r1(emu2in(xfrm.off['@_x'])), r1(emu2in(xfrm.off['@_y'])), r1(emu2in(xfrm.ext['@_cx'])), r1(emu2in(xfrm.ext['@_cy']))],
    rot: xfrm['@_rot'] ? Math.round(Number(xfrm['@_rot']) / 60000) : 0,
  };
}

function phOf(node) {
  const ph = node.nvSpPr && node.nvSpPr.nvPr && node.nvSpPr.nvPr.ph;
  if (!ph) return null;
  return { type: ph['@_type'] || null, idx: ph['@_idx'] !== undefined ? String(ph['@_idx']) : null };
}

// 版式占位符的默认文本样式：字面 run 优先，其次 lstStyle lvl1pPr defRPr
function phDefaults(sp, ctx) {
  const paras = textsOf(sp, ctx);
  const fromRun = paras[0] && paras[0].runs[0];
  const defRPr = sp.txBody && sp.txBody.lstStyle && sp.txBody.lstStyle.lvl1pPr && sp.txBody.lstStyle.lvl1pPr.defRPr;
  const fromLst = defRPr
    ? {
      size: defRPr['@_sz'] ? Number(defRPr['@_sz']) / 100 : null,
      bold: defRPr['@_b'] === '1',
      color: defRPr.solidFill ? (colorFrom(defRPr.solidFill, ctx) || {}).hex : null,
      font: (defRPr.latin && defRPr.latin['@_typeface']) || null,
    }
    : {};
  return {
    size: (fromRun && fromRun.size) || fromLst.size || null,
    bold: (fromRun && fromRun.bold) || fromLst.bold || false,
    color: (fromRun && fromRun.color) || fromLst.color || null,
    font: (fromRun && fromRun.font) || fromLst.font || null,
  };
}

// ---------- spTree 解析 ----------
// rels: id -> { target, type }
function parseRels(relsXml) {
  const doc = xml.parse(relsXml);
  const map = {};
  for (const rel of asArray(doc.Relationships && doc.Relationships.Relationship)) {
    map[rel['@_Id']] = { target: rel['@_Target'], type: rel['@_Type'] || '' };
  }
  return map;
}

function mediaName(blipFill, rels) {
  const blip = blipFill && blipFill.blip;
  const rid = blip && blip['@_embed'];
  const rel = rid && rels[rid];
  const target = rel && rel.target;
  if (!target || /^(https?:|data:|file:)/i.test(target)) return null;
  return path.basename(target);
}

function rootOf(doc) {
  return doc.sld || doc.sldLayout || doc.sldMaster || null;
}

function bgOf(doc, rels, ctx) {
  const bg = rootOf(doc) && rootOf(doc).cSld && rootOf(doc).cSld.bg;
  if (!bg) return null;
  if (bg.bgPr) {
    const fill = fillOf(bg.bgPr, ctx);
    if (fill && fill.color) return { color: fill.color };
    if (fill && fill.gradient) return { gradient: fill.gradient };
    if (bg.bgPr.blipFill) {
      const name = mediaName(bg.bgPr.blipFill, rels);
      if (name) return { image: name };
    }
    return null;
  }
  if (bg.bgRef) {
    const c = colorFrom(bg.bgRef, ctx);
    return c ? { color: c.hex } : null;
  }
  return null;
}

// 解析一页的 spTree。skipPlaceholders：母版/版式层的占位符是「槽位」不渲染，
// 但要登记到 phRegistry 供页面占位符继承坐标与默认样式。
function parseTree(doc, rels, ctx, mediaUsed, opts = {}) {
  const tree = rootOf(doc) && rootOf(doc).cSld && rootOf(doc).cSld.spTree;
  const objects = [];
  const phRegistry = [];

  const addShape = (n, xf, ownPh) => {
    const prst = n.spPr && n.spPr.prstGeom ? n.spPr.prstGeom['@_prst'] : (n.spPr && n.spPr.custGeom ? 'custGeom' : null);
    if (ownPh && opts.skipPlaceholders) {
      if (xf) phRegistry.push({ ph: ownPh, bbox: xf.bbox, rot: xf.rot, defaults: phDefaults(n, ctx) });
      return;
    }
    if (!xf && !ownPh) return; // 页面占位符允许暂缺坐标，稍后从版式继承
    objects.push({
      type: 'shape', shape: prst || 'rect', bbox: xf ? xf.bbox : null, rot: xf ? xf.rot : 0, ph: ownPh,
      fill: fillOf(n.spPr, ctx), line: lineOf(n.spPr, ctx),
      texts: textsOf(n, ctx), anchor: anchorOf(n),
    });
  };
  const addPic = (n, xf) => {
    const name = n.blipFill ? mediaName(n.blipFill, rels) : null;
    if (!xf || !name) return;
    mediaUsed.add(name);
    objects.push({ type: 'image', bbox: xf.bbox, rot: xf.rot, media: name });
  };
  const addCxn = (n, xf) => {
    if (!xf) return;
    objects.push({ type: 'shape', shape: 'line', bbox: xf.bbox, rot: xf.rot, fill: null, line: lineOf(n.spPr, ctx), texts: [], anchor: null });
  };

  const walk = (node, tf) => {
    if (!node || typeof node !== 'object') return;
    const mapXfrm = (xf) => {
      if (!xf || !tf) return xf;
      const [ox, oy, sx, sy] = tf;
      return { bbox: [r1(ox + xf.bbox[0] * sx), r1(oy + xf.bbox[1] * sy), r1(xf.bbox[2] * sx), r1(xf.bbox[3] * sy)], rot: xf.rot };
    };
    for (const sp of asArray(node.sp)) addShape(sp, mapXfrm(xfrmOf(sp.spPr)), phOf(sp));
    for (const pic of asArray(node.pic)) addPic(pic, mapXfrm(xfrmOf(pic.spPr)));
    for (const cxn of asArray(node.cxnSp)) addCxn(cxn, mapXfrm(xfrmOf(cxn.spPr)));
    for (const grp of asArray(node.grpSp)) {
      const g = grp.grpSpPr && grp.grpSpPr.xfrm;
      let childTf = tf;
      if (g && g.off && g.ext && g.chOff && g.chExt) {
        const sx = emu2in(g.ext['@_cx']) / emu2in(g.chExt['@_cx'] || g.ext['@_cx']);
        const sy = emu2in(g.ext['@_cy']) / emu2in(g.chExt['@_cy'] || g.ext['@_cy']);
        const ox = emu2in(g.off['@_x']) - emu2in(g.chOff['@_x']) * sx;
        const oy = emu2in(g.off['@_y']) - emu2in(g.chOff['@_y']) * sy;
        childTf = tf
          ? [tf[0] + ox * tf[2], tf[1] + oy * tf[3], tf[2] * sx, tf[3] * sy]
          : [ox, oy, sx, sy];
      }
      walk(grp, childTf);
    }
    for (const ac of asArray(node.AlternateContent)) {
      walk(ac.Choice, tf);
      if (!ac.Choice) walk(ac.Fallback, tf);
    }
  };
  walk(tree, null);
  return { objects, phRegistry };
}

// ---------- 主入口 ----------
async function parseSourcePages(buffer, opts = {}) {
  const zip = await JSZip.loadAsync(buffer);
  for (const [name] of Object.entries(zip.files)) {
    if (name.includes('..')) throw new Error('非法的压缩包路径');
  }
  if (!zip.file('ppt/presentation.xml') || !zip.file('ppt/theme/theme1.xml')) {
    throw new Error('不是有效的 .pptx 文件');
  }

  const pres = xml.parse(await zip.file('ppt/presentation.xml').async('text'));
  const sldSz = pres.presentation.sldSz || {};
  const canvas = { width: r1(emu2in(sldSz['@_cx'] || 12192000)), height: r1(emu2in(sldSz['@_cy'] || 6858000)) };

  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (slideNames.length === 0) throw new Error('pptx 中没有幻灯片');
  if (slideNames.length > MAX_SLIDES) throw new Error(`页数超过上限（${MAX_SLIDES}）`);

  // 文件级缓存：doc + rels
  const fileCache = {};
  const load = async (name) => {
    if (!fileCache[name]) {
      const entry = zip.file(name);
      if (!entry) return null;
      const relsName = name.replace(/([^/]+)$/, '_rels/$1.rels');
      const relsEntry = zip.file(relsName);
      fileCache[name] = {
        doc: xml.parse(await entry.async('text')),
        rels: relsEntry ? parseRels(await relsEntry.async('text')) : {},
      };
    }
    return fileCache[name];
  };
  // rels Target 是相对本文件的路径（如 ../slideLayouts/slideLayout2.xml）
  const resolveTarget = (fromName, target) => path.posix.normalize(path.posix.join(path.posix.dirname(fromName), target));
  const relTargetByType = (file, localName, suffix) => {
    for (const rel of Object.values(file.rels)) {
      if (String(rel.type).endsWith('/' + suffix)) {
        return resolveTarget(localName, rel.target);
      }
    }
    return null;
  };

  // 母版/主题 → ctx 缓存（clrMap + 主题色板）
  const ctxCache = {};
  const ctxFor = async (masterPath, themePath) => {
    const key = masterPath + '|' + themePath;
    if (!ctxCache[key]) {
      let clrMap = null;
      if (masterPath) {
        const m = await load(masterPath);
        const attrs = m && m.doc.sldMaster && m.doc.sldMaster.clrMap;
        if (attrs) {
          clrMap = {};
          for (const k of ['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']) {
            if (attrs['@_' + k]) clrMap[k] = attrs['@_' + k];
          }
        }
      }
      let theme = {};
      if (themePath) {
        const t = await load(themePath);
        const scheme = t && t.doc.theme && t.doc.theme.themeElements && t.doc.theme.themeElements.clrScheme;
        if (scheme) {
          for (const [k, node] of Object.entries(scheme)) {
            if (!node || typeof node !== 'object') continue;
            theme[k] = (node.srgbClr && node.srgbClr['@_val']) || (node.sysClr && node.sysClr['@_lastClr']) || null;
          }
        }
      }
      ctxCache[key] = { theme, clrMap };
    }
    return ctxCache[key];
  };

  const mediaUsed = new Set();
  const pages = [];
  for (const slideName of slideNames) {
    const slide = await load(slideName);
    const layoutPath = relTargetByType(slide, slideName, 'slideLayout');
    const layout = layoutPath ? await load(layoutPath) : null;
    const masterPath = layout ? relTargetByType(layout, layoutPath, 'slideMaster') : null;
    const master = masterPath ? await load(masterPath) : null;
    const themePath = master ? relTargetByType(master, masterPath, 'theme') : 'ppt/theme/theme1.xml';
    const ctx = await ctxFor(masterPath, themePath);

    // 分层叠加：母版非占位符 → 版式非占位符 → 页面全部（占位符继承版式坐标）
    const objects = [];
    let background = null;
    const registries = [];
    for (const layer of [master, layout, slide]) {
      if (!layer) continue;
      const { objects: objs, phRegistry } = parseTree(layer.doc, layer.rels, ctx, mediaUsed, { skipPlaceholders: layer !== slide });
      registries.push(phRegistry);
      // 背景就近优先：页面 > 版式 > 母版（后面的层覆盖前面的）
      const layerBg = bgOf(layer.doc, layer.rels, ctx);
      if (layerBg) background = layerBg;
      if (layer === slide) {
        // 页面占位符缺坐标/样式时从版式（其次母版）继承
        for (const o of objs) {
          if (o.ph) {
            const donor = registries.flat().find((r) => r.ph.idx != null && r.ph.idx === o.ph.idx)
              || registries.flat().find((r) => r.ph.type && r.ph.type === o.ph.type);
            if (!o.bbox && donor) o.bbox = donor.bbox;
            if (donor) {
              for (const para of o.texts) {
                for (const run of para.runs) {
                  if (!run.size && donor.defaults.size) run.size = donor.defaults.size;
                  if (!run.color && donor.defaults.color) run.color = donor.defaults.color;
                  if (!run.font && donor.defaults.font) run.font = donor.defaults.font;
                  if (!run.bold && donor.defaults.bold) run.bold = true;
                }
              }
            }
          }
          if (o.bbox) objects.push(o);
        }
      } else {
        objects.push(...objs.filter((o) => o.bbox));
      }
    }
    pages.push({ background, objects });
  }

  // 媒体落盘（幂等缓存，供 /api/templates/:id/media/:file 托管）
  if (opts.mediaDir) {
    fs.mkdirSync(opts.mediaDir, { recursive: true });
    for (const name of mediaUsed) {
      const out = path.join(opts.mediaDir, name);
      if (fs.existsSync(out)) continue;
      const entry = zip.file('ppt/media/' + name);
      if (!entry) continue;
      const data = await entry.async('nodebuffer');
      if (data.length > MAX_MEDIA) continue;
      fs.writeFileSync(out, data);
    }
  }

  return { canvas, pages };
}

module.exports = { parseSourcePages, textNodeValue };
