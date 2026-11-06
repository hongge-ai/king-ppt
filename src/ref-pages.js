// 参考页渲染：把源模板逐页画成 PNG，并合成一张接触表，作为多模态分析的图像证据。
//
// 这是 styleModel 分析阶段的「眼睛」：机器测量（template-profile）给出像素事实，
// 参考页图给出视觉语义。两者一起喂给 analyze-template 提示词，冲突时以测量为准。
//
// 页数超上限时均匀抽样全页图，但接触表始终覆盖全部页——跨页节奏（章节交替、深浅页、
// 疏密变化）只有看全册才判断得了。全页图做降采样：上游多模态网关有 ~100s 硬超时，
// payload 必须轻。
const fs = require('fs');
const path = require('path');
const { parseSourcePages } = require('./pptx-pages');
const { pageToHtml } = require('./bake');
const htmlShot = require('./html-shot');

const dataUri = (f) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;

async function renderRefPages(buffer, { outDir, maxFull = 3, mediaDir, fullScale = 0.72 }) {
  const { canvas, pages } = await parseSourcePages(buffer, { mediaDir });
  fs.mkdirSync(outDir, { recursive: true });
  const H = Math.round(1280 * canvas.height / canvas.width);
  const shots = [];
  for (let i = 0; i < pages.length; i++) {
    const html = pageToHtml(pages[i], canvas, mediaDir);
    const png = await htmlShot.renderToPng(html, { width: 1280, height: H, scale: 1 });
    const f = path.join(outDir, `page-${String(i + 1).padStart(2, '0')}.png`);
    fs.writeFileSync(f, png);
    shots.push(f);
  }

  // 接触表：每格 320px 宽的网格，格角标页号（1-based，与 sourcePageIndex+1 对齐）
  const cols = Math.min(6, Math.ceil(Math.sqrt(shots.length)));
  const cw = 320; const ch = Math.round(320 * canvas.height / canvas.width);
  const rows = Math.ceil(shots.length / cols);
  const cells = shots.map((f, i) => `<div style="position:relative;width:${cw}px;height:${ch}px;overflow:hidden;border:1px solid #ddd;box-sizing:border-box">`
    + `<img src="file:///${f.replace(/\\/g, '/')}" style="width:100%;height:100%;display:block">`
    + `<span style="position:absolute;left:2px;top:2px;font:bold 12px sans-serif;color:#fff;background:#0009;padding:1px 5px">${i + 1}</span></div>`).join('');
  const sheet = path.join(outDir, 'contact-sheet.png');
  fs.writeFileSync(sheet, await htmlShot.renderToPng(
    `<div style="display:grid;grid-template-columns:repeat(${cols},${cw}px);gap:4px;background:#fafafa">${cells}</div>`,
    { width: cols * cw + (cols + 1) * 4, height: rows * ch + (rows + 1) * 4, scale: 1 }));

  // 全页图均匀抽样：首尾必含（封面与结尾的呼应关系要看得见）
  const picks = new Set([0, shots.length - 1]);
  for (let k = 1; k < maxFull - 1; k++) picks.add(Math.round((k * (shots.length - 1)) / (maxFull - 1)));
  const full = [...picks].sort((a, b) => a - b).map((i) => ({ n: i + 1, file: shots[i] }));

  const W2 = Math.round(1280 * fullScale);
  const fullSmall = [];
  for (const p of full) {
    const f = p.file.replace('.png', '.small.png');
    fs.writeFileSync(f, await htmlShot.renderToPng(
      `<img src="file:///${p.file.replace(/\\/g, '/')}" style="width:${W2}px;display:block">`,
      { width: W2, height: Math.round(W2 * canvas.height / canvas.width), scale: 1 }));
    fullSmall.push({ n: p.n, file: f });
  }

  return { canvas, pageCount: pages.length, sheet, shots, full: fullSmall };
}

// 机器测量画像的摘要：作为交叉验证底稿喂给视觉模型。
// 视觉与测量冲突时以测量为准，所以这里只给事实，不给结论。
function profileSummary(profile) {
  if (!profile) return '(无机器测量画像)';
  const r = profile.roles || {};
  const roleLine = (x) => x && ({
    asset: x.asset,
    hIn: x.hIn,
    title: x.slot && { rect: x.slot.rect, size: x.slot.size, color: x.slot.color, font: x.slot.font },
    slots: x.slots && Object.fromEntries(Object.entries(x.slots).map(([k, s]) => [k, s.rect && [s.rect.map((v) => Math.round(v * 100) / 100), s.size, s.color]])),
  });
  return JSON.stringify({
    canvas: profile.canvas,
    tokens: profile.tokens,
    fonts: profile.invariants && profile.invariants.fonts,
    fontFamilies: profile.invariants && profile.invariants.fontFamilies,
    sourceSlideCount: profile.sourceSlideCount,
    roles: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, roleLine(v)])),
  }, null, 1);
}

module.exports = { renderRefPages, profileSummary, dataUri };
