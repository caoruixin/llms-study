# PLAN: 微信公众号文章 URL 导入支持（论文陪读）

> 状态：已批准，交付中。交付方式：专职子代理（server: sonnet5 / client: fable）+ 验证代理（opus5）。

## Context

用户在论文陪读的 URL 导入中粘贴 `https://mp.weixin.qq.com/s/PY3KJuUyhPdwvCQGOlRvHg` 失败（报「页面依赖脚本渲染，无法抓取正文」），但浏览器直接打开正常。

**已验证的根因**（curl 实测 + 代码追踪）：
1. **主因**：后端代理 `server/src/lib/fetchRaw.ts:109-113` 以诚实的 bot UA（`llm-pro.cn paper-copilot/1.0`）出站，微信直接 302 → `mp/wappoc_appmsgcaptcha` 人机验证页（约 18KB JS 壳，纯文本仅 ~39 字符），在 `src/lib/paper/url/extractArticle.ts:203` 的 200 字符门槛处抛错。换 Chrome UA 实测同一抓取返回 200 + ~3.4MB 真实正文。
2. **次因 A**：微信正文 `#js_content` 自带 `style="visibility:hidden"`（靠 JS 显示），Readability v0.6.0 的 `_isProbablyVisible` 会整体丢弃正文；fallback 又找不到 `main/article/[role=main]`。
3. **次因 B**：公众号排版把文字嵌在 `<section>` 里；`sanitizeArticleHtml` 会 unwrap `<section>`（且无分隔符直接拼接文本），`extractBlocks`（`normalizeDocx.ts:13` 的 BLOCK_TAGS）只收 p/h1-6/ul/ol/table/pre/blockquote/figure，散落文本会被整段丢弃 → 即使抓到正文也可能得到空/残缺文档。
4. 图片链路已就绪：`data-src` 懒加载兜底、https-only、`referrerPolicy="no-referrer"` + 代理重试按钮（BlockReader.tsx），mmbiz.qpic.cn 图片无需改动。

## 改动方案

### Step 1 — 出站头改为浏览器形态（server，可独立先行）
文件：`server/src/lib/fetchRaw.ts:103-113`
- `user-agent` 改为通用 Chrome UA：`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36`
- 新增 `'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'`
- `accept` / `accept-encoding: identity` 不动；**保持零 cookie/referer/authorization**，并更新注释：通用 UA 不携带任何用户身份，与「绝不替用户出示身份」原则不冲突（原则针对的是身份凭证）。
- 全局生效而非按域名分表：bot UA 在 Cloudflare 类站点同样触发反爬，按域名分表徒增配置面。
- 同步更新 `server/test/fetchUrl.test.ts:228` 的 UA 断言，并加 accept-language 断言。

### Step 2 — 微信风控识别（client 侧，新纯函数模块）
新文件：`src/lib/paper/url/weixin.ts`
```ts
export const WEIXIN_BLOCKED_MESSAGE = '微信风控拦截（触发访问验证），请稍后重试或降低导入频率'
export function isWeixinArticleUrl(url: string): boolean  // hostname === 'mp.weixin.qq.com'
export function isWeixinCaptchaUrl(url: string): boolean  // 微信域 && pathname 含 'wappoc_appmsgcaptcha'
```
在 `extractArticle()`（`extractArticle.ts:179`）入口先判 `isWeixinCaptchaUrl(input.finalUrl)` → 抛 `WEIXIN_BLOCKED_MESSAGE`。选 client 侧的理由：`x-fetch-final-url` 已把跳转后 URL 带回（`fetchUrlApi.ts`），server 侧要新增共享 ApiErrorCode + 客户端映射才不被 `ERROR_MESSAGES` 掩盖，改动面更大；且 fetch-url 路由定位是站点无关薄代理。
- `urlImport.ts:191-195` 已有 per-URL catch → 错误自然进入对话框逐条展示，无需再接线。

### Step 3 — 微信抽取钩子（绕过 Readability）
文件：`src/lib/paper/url/extractArticle.ts`，插在 `preprocess(...)`（:181，先跑保证 data-src 图片被提升）与 Readability 块（:187）之间：
```ts
if (isWeixinArticleUrl(input.finalUrl)) {
  const root = doc.querySelector('#js_content')
  if (!root) throw new Error(WEIXIN_BLOCKED_MESSAGE)  // 200 状态的降级壳页
  contentHtml = root.innerHTML
  title = doc.querySelector('#activity-name')?.textContent?.trim() ?? ''
}
// 原 Readability 块改为 if (!contentHtml && isProbablyReaderable(doc)) { ... }
```
- 绕过而非预处理后再喂 Readability：`visibility:hidden` 会让它整体丢正文；sanitize 仍在后面兜底，且 `ARTICLE_ALLOWED_ATTR` 本就不含 style，无需手动剥样式。
- 末尾 200 字符门槛（:203-205）处：若 `isWeixinArticleUrl(finalUrl)` 则改抛 `WEIXIN_BLOCKED_MESSAGE`（覆盖被限流后返回的残缺 stub），不再误报「页面依赖脚本渲染」。

### Step 4 — 通用「散落文本包段」pass（修次因 B）
新文件：`src/lib/paper/url/paragraphize.ts`
- `paragraphizeHtml(html): string`：DOMParser 解析后，对 body 及所有 div/section/blockquote 后代，把「连续的文本节点/非块级元素 run」（有非空白文本的）就地包进 `<p>`；纯空白 run 不动。BLOCKISH 集合：p/h1-6/ul/ol/table/pre/blockquote/figure/div/section/hr。
- 调用点：`extractArticle()` 中 sanitize 之前——`sanitizeArticleHtml(paragraphizeHtml(contentHtml))`（:201）。
- **必须在 sanitize 前**：DOMPurify unwrap `<section>` 时无分隔符拼接，段落边界一旦丢失不可恢复（中文尤甚）。
- 只作用于 URL 导入选中的正文，Readability 输出本就是 `<p>` 结构 → arxiv 路径近似 no-op；`extractBlocks`/`normalizeDocx.ts`/`normalizeHtml.ts` 零改动 → DOCX 导入链路结构上不受影响。
- 已知限制（v1 接受）：同一 section 内 `<br>` 分行会合成一段。

### 测试
- 新增 `src/lib/paper/url/weixin.test.ts`（node env）：captcha URL 正例、正常文章 URL 负例、非微信域负例、非法字符串负例。
- 新增 `src/lib/paper/url/paragraphize.test.ts`（`// @vitest-environment happy-dom`，仿 `sanitize.test.ts`）：section 内裸文本包段、混合容器只包散落 run 且保序、嵌套 section、纯空白不动、行内 run 合为一段、已干净的 p/heading HTML 原样通过（arxiv 形态守护）。
- 更新 `server/test/fetchUrl.test.ts` UA 断言。

## 关键文件
- `server/src/lib/fetchRaw.ts`（改 UA + accept-language + 注释）
- `server/test/fetchUrl.test.ts`（UA 断言）
- `src/lib/paper/url/extractArticle.ts`（微信钩子 + 错误改写 + paragraphize 接入）
- `src/lib/paper/url/weixin.ts`（新）+ `weixin.test.ts`（新）
- `src/lib/paper/url/paragraphize.ts`（新）+ `paragraphize.test.ts`（新）

## 风险
- UA 改浏览器形态后部分站点返回完整页 → 体积变大，20MB 上限与限流（5/10s、并发 1）已覆盖。
- 微信按 IP 限流很凶（生产在新加坡 ECS）：连续导入几条后即使 Chrome UA 也会吃验证页 → 用户看到明确的「微信风控拦截…」提示即可，**不做服务端重试**（会加剧限流）。
- 微信非文章页（无 `#js_content`）会得到风控提示——略不精确但可行动、场景罕见。

## 验证
1. 单测：根目录 `npm test`（新增两个测试 + 既有 normalize/sanitize/urlImport 全绿）；`cd server && npm test`。
2. `npm run typecheck`（root + server）。
3. 本地 E2E：起 server（:8787）+ vite（用 `http://localhost:5173`，vite 只听 [::1]）→ 登录 → 论文陪读 → URL 导入粘贴目标微信链接 → 期望：标题取自 `#activity-name`、正文成段（非空、非整段拼接）、mmbiz 图片正常渲染（失败时代理重试按钮可用）。
4. 风控路径：连续多次导入微信链接直至被限 → 对话框显示「微信风控拦截…」而非「页面依赖脚本渲染」。
5. 回归：导入一条 arxiv HTML URL，块结构与改前一致；DOCX 导入冒烟一次。
