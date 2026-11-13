# 卷王PPT (KingPPT)

**独立的 PPT 生成程序**：内置多供应商 LLM，在网页里一步步定大纲、挑模板、实时预览、就地编辑，导出**可编辑的 .pptx**。别人熬夜做的，没你十分钟做的好。

> **SVG-as-IR**：每页幻灯片 = 一整张 `<svg viewBox="0 0 1280 720">`，它是唯一中间表示。程序按所选主题的设计令牌逐页生成 SVG，浏览器内联预览、`src/svg-to-pptx.js` 编译为原生可编辑的 PowerPoint 形状——二者消费同一份被 sanitize 的 SVG，从机制上保证**预览 == 导出**（无需 Chrome、无栅格化）。

## 快速开始

```bash
npm install
node bin/cli.js serve        # 启动服务 + 开浏览器（默认 http://localhost:3210）
```

浏览器打开后：

1. 点左侧栏底部的 **模型设置**，添加一个 OpenAI 兼容供应商（Kimi / MiniMax / 本地 Ollama / 自定义中转站…），填 baseURL + API Key，绑定「文本」默认模型。
2. 点左侧栏的 **新建演示文稿**，在聊天输入框写主题，再按提示完成大纲、模板和出片。

> 改动了 `web/` 前端源码后，需 `npm run build` 重新生成 `public/`（运行时用的是预打包产物）。Node ≥ 18（用到全局 `fetch`）。

## 聊天式创作流程

左侧栏按对话/任务显示历史。点击“新建”只创建空白工作区；发送第一条提示词时才建立历史任务。同一任务后续的大纲修改、出片和页面编辑都会更新到这条记录，可重命名、重新打开并继续编辑。

```
输入主题 → 对话式检查大纲 → 选择模板 → 实时预览与编辑 → 导出 PPTX
```

1. **内容大纲**：在聊天输入框写主题（可添加 pdf/docx/md/txt/图片素材作参考）→ 生成结构化 Markdown 大纲 → 在大纲中**划词批注**、攒一批提交改稿 → 满意后**定稿**。
2. **选择模板**：浏览可选主题风格，上传模板会在**预览弹层**显示原始 PPT 的封面、章节、内容和结束代表页；没有原始文件时才显示生成样例 →「用此模板生成」。
3. **幻灯片**：服务端以后台任务按【定稿大纲 + 所选主题】逐页生成 SVG，页面逐张实时冒出；可离开或刷新页面，任务仍会继续，重新打开后可恢复进度。失败时会保留已完成页并显示错误。可点文字**就地编辑**、对某页提意见**AI 重画**或直接**重画本页**。最后「导出 PPTX」，在 PowerPoint / WPS 里继续编辑。

## HTTP 接口一览

| 方法 & 路径 | 用途 |
| --- | --- |
| `GET /api/templates` | 列出可选主题 `{id, name, source, palette}` |
| `GET /api/templates/:id/spec` | 某主题的创作规格：设计令牌 + 4 张角色原型 SVG + 创作规则 + 参考画像摘要 |
| `GET /api/templates/:id/preview` | 主题整册预览（上传模板还原原件页 / 预设主题样例页） |
| `POST /api/templates/extract` · `POST /api/templates` | 上传 .pptx 提取为可复用主题 |
| `GET /api/providers` · `POST /api/instances*` · `POST /api/active` | 多供应商 × 多模型 × 能力绑定的配置读写 |
| `POST /api/generate/outline` | 生成 / 按批注改稿内容大纲（→ SSE `doc`） |
| `POST /api/generate/deck` | 快速创建后台整册生成任务（202，逐页结果经 SSE `slide`） |
| `GET /api/generate/deck/status` | 查询当前任务状态、进度、失败原因或服务重启中断状态 |
| `POST /api/generate/slide` | 单页重生成 `{index, feedback?}` |
| `POST /api/new` | 创建空白对话工作区，不新增历史任务 |
| `GET /api/history/:id/messages` | 读取该对话任务的提示词与修改意见 |
| `PATCH /api/history/:id` | 修改历史对话任务的显示标题 |
| `POST /api/deck/slide` | 就地编辑落库 `{index, svg}` |
| `GET /api/deck` · `GET /api/doc` | 演示态 / 大纲快照（刷新/重连恢复） |
| `GET /api/deck/style-score` | 当前整册风格评分（配色、字体、角色几何、图片槽位、正文一致性） |
| `GET /api/stream` | SSE：推 `deck` / `slide` / `doc` / `generation` / `history` 事件 |
| `POST /api/export` | 导出当前演示态为 .pptx |

## CLI

```
king-ppt serve [--port=N] [--no-open]   前台启动服务 + 开浏览器（可后台运行）
king-ppt stop                           停止运行中的服务
king-ppt export <out.pptx>              导出当前演示态为 .pptx
```

生成大纲 / 选模板 / 编辑等均在浏览器里完成。CLI 经 `KING_PPT_HOME/server.json` 定位服务（或 `--port=N` / `KING_PPT_PORT`）。

## 验证

```bash
npm test
npm run build
```

## 模板系统

- 主题 = 一份 `theme.json` 令牌包：角色化色板（`primary`/`accent`/`text`/`bg`…）、字号档位（`display`/`pageTitle`/`body`…）、几何（圆角/细线/边距）、基调 tone。生成引擎只用这些令牌值作画，保证整册风格一致。
- **预设主题**：`warm-retro`（默认，纸感拼贴参考样式）、`classic-blue`（经典蓝）。位于 `templates/<id>/`。
- **上传主题**：网页里选一份 .pptx，自动提取主题色/字体/字号档位，并为封面、章节、正文、结尾建立去文字烘焙底图与实测槽位画像；存 `KING_PPT_HOME/templates/<id>/`（含 `source.pptx` 原件和 `template-profile.json`）。有画像的模板使用确定性槽位填充，避免正文页逐页漂移；无 Chrome 时自动退回令牌版式。
- **可重复评估**：`node scripts/benchmark-template-style.js <reference.pptx> <output-dir>` 会用“悯农”跑自由 SVG 基线与画像渲染迭代，输出分数、差值和 PPTX。

## 目录结构

```
bin/cli.js               # CLI：serve / stop / export
src/server.js            # HTTP 服务：模板 / 生成 / 编辑 / 供应商 / SSE / 导出 路由
src/relay.js             # 演示态存储（deck/doc）+ SSE 广播总线
src/generate-outline.js  # 大纲生成 / 批注改稿（LLM）
src/generate-deck.js     # 切页 + 按主题令牌逐页生成整页 SVG（LLM）
src/spec.js              # 主题令牌 → 创作规格（令牌文本 + 4 角色原型 + SVG 规则）
src/normalize.js         # 单页 SVG 归一（永不抛错，坏页回退空白并标记）
src/svg-sanitize.js      # SVG 清洗（预览==导出 的守门人）
src/svg-to-pptx.js       # SVG → 原生可编辑 pptx 形状
src/pptx.js / pptx-painter.js  # 导出装配
src/descriptor.js        # 主题加载与枚举
src/llm.js / llmprovider.js    # 多供应商 LLM 抽象层（OpenAI 兼容）
src/config.js / paths.js       # 配置存储 / 可移植数据根目录
src/materials.js / assets.js   # 参考素材 / 配图存储（落 KING_PPT_HOME）
src/extract.js / pptx-pages.js # 上传 .pptx → 主题草稿 / 原件页预览
templates/               # 预设主题（theme.json + assets/）
web/                     # Vite/React 前端源码（构建产物在 public/）
```

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `KING_PPT_HOME` | 否 | `~/.king-ppt` | 数据根目录（配置/配图/上传模板/素材/运行时文件） |
| `PORT` | 否 | `3210` | 服务端口 |
| `KING_PPT_PORT` | 否 | — | CLI 定位服务端口的覆盖项 |
| `OPENAI_API_KEY` | 否 | — | 未在设置面板配置时的 env 回退 Key（设置面板配置优先） |
| `OPENAI_BASE_URL` | 否 | `https://api.openai.com/v1` | env 回退的 OpenAI 兼容端点（缺 `/v1` 会自动探测补全） |
| `OPENAI_MODEL` | 否 | `gpt-4o-mini` | env 回退的模型名 |
