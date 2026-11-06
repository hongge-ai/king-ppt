// 薄封装：保持旧接口不变（generate-outline.js 无需改动），内部走 llmprovider 多供应商层。
// 多供应商解析、适配器、baseURL 探测、连接/模型实测全在 llmprovider.js。
const provider = require('./llmprovider');

// 文本对话（chat 能力）
function chat(messages, opts = {}) {
  return provider.chat('chat', messages, opts);
}

// 多模态识图（vision 能力）：messages 的 content 支持
// [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }]
function chatVision(messages, opts = {}) {
  return provider.chat('vision', messages, opts);
}

// 图像生成：统一暴露给出片管线，返回供应商的 url 或 base64 结果。
function generateImage(prompt, opts = {}) {
  return provider.generateImage(prompt, opts);
}

// 从文本中定位 JSON 的候选切片。模型输出的形态不止一种：正常 JSON、JSON 之后跟着散文、
// JSON 被截断、JSON 里出现嵌套的同种括号。单一启发式都不够可靠，所以给出候选由调用方择优：
//   1) 首个开括号 → 末个闭括号（对完整输出最精确，不受内部括号配对影响）
//   2) 具名括号栈扫描（对「JSON 后面还有第二个代码块」这类情况更准）
function jsonCandidates(text) {
  const s = String(text || '').replace(/```(?:json|JSON)?/g, '');
  const start = s.search(/[[{]/);
  if (start === -1) return [];
  const out = [];
  for (const close of ['}', ']']) {
    const end = s.lastIndexOf(close);
    if (end > start) out.push(s.slice(start, end + 1));
  }
  // 具名括号栈：同时跟踪 { 与 [，闭合时类型不匹配就不算闭合（防止字符串外的杂散括号）
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const want = ch === '}' ? '{' : '[';
      if (stack[stack.length - 1] !== want) break; // 结构错乱，放弃该候选
      stack.pop();
      if (!stack.length) { out.push(s.slice(start, i + 1)); break; }
    }
  }
  return [...new Set(out)];
}

// 对常见的模型 JSON 缺陷做确定性修复：尾逗号、中文引号、行内裸换行/制表符、
// JSON 前后的围栏残留。修复失败仍抛出原始错误，不吞掉问题。
function repairJson(text) {
  let t = String(text || '')
    .replace(/^﻿/, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    // 字符串值内部的裸换行/制表符会让 JSON.parse 失败，转义掉
    .replace(/([^\\])\n(\s*[^\s])/g, '$1\\n$2')
    .replace(/\t/g, '\\t')
    // 尾逗号：,, 或 ,} 或 ,]
    .replace(/,(\s*[}\]])/g, '$1');

  // 冗余的根级闭合：模型常在写完若干顶层字段后多打一个 }，然后继续写 ",下一个字段"：
  //   {... ,"fingerprints":[...]},  "families":[...]}
  // 这个 } 会让 JSON 提前结束。判断依据：括号深度归零后，紧随的（跳过空白与逗号）
  // 是一个带引号的键名 —— 说明它本该属于同一个对象，删掉多出来的那一个。
  let depth = 0;
  let inS = false;
  let es = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inS) {
      if (es) es = false;
      else if (ch === '\\') es = true;
      else if (ch === '"') inS = false;
      continue;
    }
    if (ch === '"') { inS = true; continue; }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        const rest = t.slice(i + 1);
        // 之后的第一个有意义字符是逗号或引号 → 这是冗余闭合
        if (/^\s*[,]?\s*"/.test(rest)) {
          t = t.slice(0, i) + t.slice(i + 1);
          depth = 1; // 回到对象内部，继续扫描
          i -= 1;
        }
      }
    }
  }

  // 尾部被截断：补齐未闭合的字符串与括号
  let inStr = false;
  let esc = false;
  const stack = [];
  for (const ch of t) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) t += '"';
  while (stack.length) t += stack.pop() === '{' ? '}' : ']';
  return t;
}

// 从模型输出容错提取 JSON 对象/数组。
// 候选切片逐一尝试（原文 → 修复版），成功的取「顶层字段最多」的那个：模型输出被截断时，
// 早期切片能解析但缺字段，完整切片字段齐全——按完整度择优才不会把半个结果当成品。
function extractJson(text) {
  const cands = jsonCandidates(text);
  if (!cands.length) throw new Error('模型输出中未找到 JSON');
  const parsed = [];
  let lastErr = null;
  for (const c of cands) {
    for (const attempt of [c, repairJson(c)]) {
      try {
        const obj = JSON.parse(attempt);
        parsed.push(obj);
        break;
      } catch (e) { lastErr = e; }
    }
  }
  if (!parsed.length) {
    const err = new Error(`模型输出的 JSON 无法解析：${lastErr && lastErr.message}`);
    err.code = 'JSON_PARSE';
    err.raw = String(text || '');
    throw err;
  }
  const richness = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).length : Array.isArray(o) ? o.length : 0);
  return parsed.sort((a, b) => richness(b) - richness(a))[0];
}

// 从模型输出剥出 SVG（剥围栏/前言，截 <svg…</svg>）。normalize() 要求字符串以 <svg 起头。M2 用。
function extractSvg(text) {
  const s = String(text || '').replace(/```(?:svg|xml|html)?/gi, '');
  const start = s.search(/<svg[\s>]/i);
  if (start === -1) return '';
  const end = s.lastIndexOf('</svg>');
  if (end === -1 || end < start) return '';
  return s.slice(start, end + 6);
}

module.exports = { chat, chatVision, generateImage, extractJson, extractSvg };
