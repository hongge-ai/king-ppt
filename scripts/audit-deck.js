// 整册验收：把当前演示态的逐页 SVG 渲染成图，按 audit-slide 契约做三种模式之一的检查。
//
//   node scripts/audit-deck.js <templateId> [--mode style_transfer|reconstruction|export_fidelity]
//   node scripts/audit-deck.js <templateId> --deck deck.json --mode style_transfer
//
// 输出 exports/audit/<mode>.json。没有 PPTX 渲染图时 export_fidelity 一律 unverified。
const fs = require('fs');
const path = require('path');
const { auditDeck } = require('../src/audit');
const genDeck = require('../src/generate-deck');

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

(async () => {
  const templateId = process.argv[2];
  if (!templateId || templateId.startsWith('--')) {
    console.error('用法: node scripts/audit-deck.js <templateId> [--mode …] [--deck deck.json]');
    process.exit(1);
  }
  const mode = argOf('mode', 'style_transfer');
  const deckFile = argOf('deck', null);

  const deck = deckFile && deckFile !== '-'
    ? JSON.parse(fs.readFileSync(deckFile, 'utf8'))
    : await (await fetch('http://localhost:3210/api/deck')).json();
  if (!deck || !Array.isArray(deck.slides) || !deck.slides.length) {
    console.error('当前没有整册内容：请先生成，或用 --deck 指定导出的 deck JSON');
    process.exit(1);
  }

  // 大纲单独取：deck 载荷只有幻灯片本身，原始内容在 doc 里
  const base = 'http://localhost:3210';
  const doc = await (await fetch(`${base}/api/doc`)).json();
  const markdown = (doc && doc.markdown) || '';
  const sections = markdown ? genDeck.splitOutline(markdown).sections : [];

  const report = await auditDeck({ templateId, slides: deck.slides, sections, mode });
  const outFile = path.join('exports', 'audit', `${mode}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  const blockers = report.blockingIssues || [];
  console.log(`mode=${report.auditMode} status=${report.status} blockers=${blockers.length} issues=${(report.issues || []).length}`);
  for (const b of blockers) console.log(`  [BLOCKER] p${(b.slideIndex ?? 0) + 1} ${b.category}: ${b.observed || b.expected || ''}`);
  for (const i of report.issues || []) console.log(`  [${i.severity || 'major'}] p${(i.slideIndex ?? 0) + 1} ${i.category}: ${i.observed || ''}`);
  if ((report.unverifiedChecks || []).length) console.log('  未验证:', report.unverifiedChecks.join(' / '));
  console.log('report ->', outFile);
})().catch((e) => { console.error(e); process.exit(1); });
