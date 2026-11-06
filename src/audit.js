// 验收层：把「参考 — 生成 — 导出」三方证据交给 audit-slide 提示词，并叠加不依赖模型的确定性检查。
//
// 三种模式严格分开（提示词要求）：
//   reconstruction   同内容复刻：参考页 vs 重建页
//   style_transfer   新内容迁移：新页 vs 对应家族的参考页
//   export_fidelity  导出保真：清洗后 SVG 渲染 vs 导出 PPTX 的重新渲染
// 本机没有 LibreOffice 之类的 PPTX 渲染器时，export_fidelity 只能返回 unverified——
// 用 SVG 截图冒充 PPTX 渲染是明确禁止的。
const fs = require('fs');
const path = require('path');
const llm = require('./llm');
const htmlShot = require('./html-shot');
const { scanSvg } = require('./style-score');
const { dataUri } = require('./ref-pages');
const { loadDescriptor } = require('./descriptor');
const styleModel = require('./style-model');

const PROMPT_FILE = path.join(__dirname, 'prompts', 'audit-slide.md');
const MODES = ['reconstruction', 'style_transfer', 'export_fidelity'];

// 把整册 SVG 逐页渲染成 PNG（scale 2 供视觉审查），返回 { n, file, title, role }[]
async function renderSlides(slides, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const shots = [];
  for (let i = 0; i < slides.length; i++) {
    const svg = String((slides[i] && slides[i].svg) || '');
    if (!svg) continue;
    const file = path.join(outDir, `slide-${String(i + 1).padStart(2, '0')}.png`);
    fs.writeFileSync(file, await htmlShot.renderToPng(
      `<div style="width:1280px;height:720px;overflow:hidden">${svg.replace(/^<svg\s/i, '<svg width="1280" height="720" ')}</div>`,
      { width: 1280, height: 720, scale: 2 }));
    shots.push({ n: i + 1, file, title: (slides[i] && slides[i].title) || '', role: (slides[i] && slides[i].role) || '' });
  }
  return shots;
}

// 内容完整性：正文里的数字、百分号、正负号必须出现在该页 SVG 的文本节点里。
// 这是「不得为了排得下而静默删除正文」的可执行版本——现有工具完全没有这一项。
function contentChecks(sections, slides) {
  const issues = [];
  (sections || []).forEach((section, i) => {
    const svg = (slides[i] && slides[i].svg) || '';
    if (!svg) return;
    const drawn = scanSvg(svg).texts.map((t) => t.text).join('');
    const numbers = [...String(section.raw || '').matchAll(/[-−+]?\d+(?:\.\d+)?%?/g)].map((m) => m[0]);
    for (const num of [...new Set(numbers)]) {
      // 页码/章节号这类结构性数字本来就由渲染器生成，不要求逐字出现
      if (/^\d{1,2}$/.test(num) && Number(num) <= 30) continue;
      const bare = num.replace(/^[-−+]/, '');
      if (!drawn.includes(num) && !drawn.includes(bare)) {
        issues.push({
          issueId: `content-missing-${i + 1}-${bare}`,
          slideIndex: i,
          category: 'content',
          severity: 'blocker',
          expected: num,
          observed: '该页 SVG 中未找到此数值',
          evidence: 'text 节点全文比对',
          suggestedFix: '重新生成该页，确保数值原样保留',
          suggestedOwner: 'svg-generator',
          confidence: 'high',
        });
      }
    }
  });
  return issues;
}

function promptText() {
  return fs.readFileSync(PROMPT_FILE, 'utf8');
}

// 主入口。返回提示词定义的那套 JSON（不含任何综合相似度百分比）。
async function auditDeck({ templateId, slides, sections, mode = 'style_transfer', pptxImages = null, outDir } = {}) {
  if (!MODES.includes(mode)) throw new Error(`auditMode 非法：${mode}`);
  const d = loadDescriptor(templateId);
  const model = styleModel.loadStyleModel(d._dir);
  const dir = outDir || path.join(d._dir, '.audit');
  const shots = await renderSlides(slides, path.join(dir, 'slides'));
  const structural = contentChecks(sections, slides);

  // export_fidelity 没有真实 PPTX 渲染图 → 直接 unverified，不调模型、不假通过
  if (mode === 'export_fidelity' && !pptxImages) {
    return {
      auditMode: mode,
      status: 'unverified',
      coverage: { pages: shots.length, images: 0, evidence: '缺少导出 PPTX 的重新渲染图' },
      blockingIssues: [],
      issues: structural,
      passedChecks: [],
      unverifiedChecks: ['export_fidelity：本机没有 PPTX 渲染器，无法对比导出结果'],
      repairOrder: structural.map((x) => x.issueId),
      regressionScope: '导出保真未验证，不能宣称预览==导出已验证',
    };
  }

  // 参考页图：分析阶段留在 .ref 下的逐页渲染
  const refDir = path.join(d._dir, '.ref');
  const refImgs = fs.existsSync(refDir)
    ? fs.readdirSync(refDir).filter((f) => /^page-\d+\.png$/.test(f)).sort().slice(0, 6).map((f) => path.join(refDir, f))
    : [];

  const content = [{
    type: 'text',
    text: [
      promptText(),
      '',
      '【调用方补充】',
      `auditMode: ${mode}`,
      '下面依次给出：结构检查结果（程序计算，不是模型判断）、生成页渲染图、参考页图、styleModel。',
      '结构检查里 severity=blocker 的问题已确认存在，不要因为视觉上「看起来还行」而忽略。',
      '',
      'STRUCTURAL_CHECKS:',
      JSON.stringify(structural, null, 1),
      '',
      'STYLE_MODEL:',
      JSON.stringify(model, null, 1),
    ].join('\n'),
  }];
  for (const s of shots) {
    content.push({ type: 'text', text: `生成第 ${s.n} 页（${s.role} ${s.title}）：` });
    content.push({ type: 'image_url', image_url: { url: dataUri(s.file) } });
  }
  for (const f of refImgs) {
    content.push({ type: 'text', text: `参考页 ${path.basename(f)}：` });
    content.push({ type: 'image_url', image_url: { url: dataUri(f) } });
  }

  const raw = await llm.chatVision([{ role: 'user', content }], { temperature: 0.2, maxTokens: 6000, timeoutMs: 300000 });
  const fenced = String(raw || '').match(/```json\s*([\s\S]*?)```/);
  let report;
  try {
    report = JSON.parse(fenced ? fenced[1] : String(raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
  } catch {
    report = { status: 'unverified', issues: [], unverifiedChecks: ['模型输出无法解析为 JSON'], blockingIssues: [], passedChecks: [], repairOrder: [], regressionScope: '' };
  }
  // 结构检查里的 blocker 不可被模型忽略：合并进 blockingIssues
  const blockers = [...new Set([...(report.blockingIssues || []), ...structural.filter((x) => x.severity === 'blocker')])];
  const merged = {
    auditMode: mode,
    status: blockers.length ? 'fail' : (report.status || 'unverified'),
    coverage: report.coverage || { pages: shots.length, images: shots.length, evidence: `generated=${shots.length}, reference=${refImgs.length}` },
    blockingIssues: blockers,
    issues: [...(report.issues || []), ...structural.filter((x) => x.severity !== 'blocker')],
    passedChecks: report.passedChecks || [],
    unverifiedChecks: [...(report.unverifiedChecks || []), ...(mode === 'export_fidelity' ? [] : ['export_fidelity：未检查（无 PPTX 渲染图）'])],
    repairOrder: report.repairOrder || blockers.map((x) => x.issueId || '').filter(Boolean),
    regressionScope: report.regressionScope || '',
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `audit-${mode}.json`), JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = { auditDeck, renderSlides, contentChecks, MODES };
