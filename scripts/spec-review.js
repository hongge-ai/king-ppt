// 出片前 AI 自检（闭环渲染测试协议的产品化）：
// 生成整册的接触表 + 反推规格（TEMPLATE_SPEC）→ 视觉模型逐维差分 → findings JSON。
// 用法: node scripts/spec-review.js <templateId> [deck.json|-]
const fs = require('fs');
const path = require('path');
const htmlShot = require('../src/html-shot');
const { loadDescriptor } = require('../src/descriptor');
const llm = require('../src/llm');

const templateId = process.argv[2];
const deckFile = process.argv[3] || '-';
const outDir = 'exports/spec-review';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

(async () => {
  const d = loadDescriptor(templateId);
  if (!d) { console.error('template not found:', templateId); process.exit(1); }
  const spec = JSON.parse(fs.readFileSync(path.join(d._dir, 'template-spec.json'), 'utf8'));
  const deck = deckFile === '-' ? await (await fetch('http://localhost:3210/api/deck')).json() : JSON.parse(fs.readFileSync(deckFile, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });

  // 渲染每页 + 接触表
  const shots = [];
  for (let i = 0; i < deck.slides.length; i++) {
    const svg = String(deck.slides[i].svg || '');
    if (!svg) continue;
    const f = path.join(outDir, `slide-${i + 1}.png`);
    fs.writeFileSync(f, await htmlShot.renderToPng(
      `<div style="width:1280px;height:720px;overflow:hidden">${svg.replace(/^<svg\s/i, '<svg width="1280" height="720" ')}</div>`,
      { width: 1280, height: 720, scale: 2 }));
    shots.push({ n: i + 1, f, title: deck.slides[i].title || '', role: deck.slides[i].role || '' });
  }
  const cell = (f, label) => `<figure style="margin:0"><img src="file:///${f.replace(/\\/g, '/')}" style="width:420px;height:236px;display:block;border:1px solid #ccc"><figcaption style="font:12px sans-serif;color:#333;padding:2px">${esc(label)}</figcaption></figure>`;
  const sheet = path.join(outDir, 'sheet.png');
  fs.writeFileSync(sheet, await htmlShot.renderToPng(
    `<div style="display:grid;grid-template-columns:repeat(3,420px);gap:10px;background:#fafafa;padding:10px">`
    + shots.map((s) => cell(s.f, `${s.n}. ${s.role} ${s.title}`)).join('') + '</div>',
    { width: 3 * 420 + 40, height: Math.ceil(shots.length / 3) * (236 + 24) + 24, scale: 1 }));

  // QA 提示词：闭环协议 + 规格锚点
  const anchor = JSON.stringify({
    canvas: spec.canvas,
    tokens: spec.tokens,
    layoutGrammar: spec.layoutGrammar,
    sequence: spec.sequence,
    generalization: spec.generalization,
    criticalInvariants: spec.criticalInvariants,
    avoid: spec.avoid,
    accentDiscipline: spec.tokens && spec.tokens.accentDiscipline,
  }, null, 1);
  const prompt = [
    '你是 PPT 整册的视觉质检员，执行「闭环渲染测试协议」：把生成整册与模板规格逐维差分。',
    '逐页检查以下维度，只报告有真实证据的问题，不做审美泛评：',
    '1. Chrome Fidelity（部件位置/遮挡/碰撞） 2. Grid & Geometry（对齐/卡片几何）',
    '3. Typography（字阶/截断/折行孤字） 4. Color Roles（色彩角色/强调色纪律/对比度）',
    '5. Layout Grammar（编号/装饰语法/密度节奏） 6. Sequence Rhythm（角色序列/标识贯穿）。',
    '同时核对规格的 criticalInvariants 是否在成册中可辨认、avoid/forbidden 清单是否被违反。',
    '注意：spec.sequence 描述的是「原模板的节奏模板」（章节交替方式、页码格式、贯穿元素），',
    '不是内容要求——生成册的章节标题/数量/总页数由用户大纲决定，只检查节奏类型与贯穿',
    '元素是否复刻；把原模板章节名或页数当成要求属于误报，不得输出。',
    '严重度：P0=崩坏必须修，P1=明显缺陷应修，P2=打磨项可忽略。',
    '只输出一个 JSON：{"findings":[{"page":页码,"severity":"P0|P1|P2","dimension":"维度","finding":"问题","suggestion":"修法"}],"invariantsOk":[在成册中可辨认的辨识特征],"verdict":"pass|needs-fix"}',
    '',
    'TEMPLATE_SPEC 锚点：',
    anchor,
  ].join('\n');
  const content = [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + fs.readFileSync(sheet).toString('base64') } }];
  // 页数多时补发逐页大图（前 6 页），保证细节可查
  for (const s of shots.slice(0, 6)) {
    content.push({ type: 'text', text: `第 ${s.n} 页：` });
    content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + fs.readFileSync(s.f).toString('base64') } });
  }
  const raw = await llm.chatVision([{ role: 'user', content }], { temperature: 0.2, maxTokens: 4000 });
  const m = raw.match(/\{[\s\S]*\}/);
  const report = m ? JSON.parse(m[0]) : { findings: [], invariantsOk: [], verdict: 'unknown', raw };
  report._meta = { templateId, deckTitle: deck.title, pages: shots.length, at: new Date().toISOString() };
  const outFile = path.join(outDir, 'report.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log('verdict:', report.verdict, '| findings:', (report.findings || []).length);
  for (const f of report.findings || []) console.log(`  [${f.severity}] p${f.page} ${f.dimension}: ${f.finding}`);
  console.log('invariantsOk:', (report.invariantsOk || []).join(' / '));
  console.log('report ->', outFile);
})().catch((e) => { console.error(e); process.exit(1); });
