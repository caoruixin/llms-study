# iOS WebKit PDF 渲染失败根因修复 + 重试 UX + 列表卡片布局

## Context

真机复验(iPhone,App 内置浏览器)确认新版已生效,且上一轮的"错误可见化"起了作用:原来的静默空白现在显形为**每一页都报「本页渲染失败 · 点按重试」**——即 pdf.js v6 的 `page.render()` 在 iOS WebKit 上逐页抛错(桌面 Chrome 完全正常,同一 PDF、同一代码)。这是引擎级兼容性问题,root cause 未知,必须先复现拿到真实报错。伴随两个 UX 问题:重试按钮"没效果"(实际是重试后立刻再次失败,零视觉反馈,且用户看不到具体错误);列表卡片在手机上标题被不换行的按钮组挤成一条缝、元数据逐词竖排。

诊断依据(已完成的只读排查):
- 页卡尺寸正确、47 页可枚举、目录/进度/文本视图全部正常 → `getDocument`+`getPage(1)` 成功,worker 活着,`Promise.withResolvers` 守卫未触发(iOS ≥ 17.4);失败精确定位在 PdfPage effect 的 `doc.getPage(n)`→`page.render()` 段(PdfViewer.tsx:74-122,`[pdf] 第 N 页渲染失败` 路径)。
- 已排除:canvas 尺寸(≤2.7MB/页,远低于 iOS 384MB 总限)、`render({canvas})` 参数形态(v6 唯一形态,Chrome 已验证)。
- 待验证嫌疑(按优先级):① 未配置 `standardFontDataUrl`/`cMapUrl`(全仓零命中,pdf.js 缺失时按浏览器走不同 fallback);② WebKit 的 OffscreenCanvas/worker 图像解码路径(getDocument 有 `isOffscreenCanvasSupported` 开关);③ WebKit canvas 特性差异(pdf.js 内有 `FeatureTest.isCanvasFilterSupported` 等分支)。
- 相关已知问题池:[pdf.js #9570](https://github.com/mozilla/pdf.js/issues/9570)、[#9176](https://github.com/mozilla/pdf.js/issues/9176)、[react-pdf #1601 canvas 内存](https://github.com/wojtekmaj/react-pdf/issues/1601)——均为旧版线索,不作定论,以复现报错为准。

## 工作流 1:WebKit 复现 → 根因修复(核心)

**关键手段:Playwright WebKit(与 iOS Safari 同为 WebCore 内核)在本机复现**,进入"改→验"闭环,不依赖真机往返。

1. 装工具:`npm i -D playwright` + `npx playwright install webkit`(devDependency;chromium 一并装作对照)。
2. 写复现脚本 `scripts/webkit-pdf-repro.mjs`(常驻仓库,今后 WebKit 回归都用它):
   - 启动 dev server(或复用已起的);launch webkit → goto `http://localhost:5173/#/papers`;
   - 种论文:node 侧读 `scripts/paper-eval/` fixtures PDF → base64 传入 `page.evaluate`,动态 `import('/src/lib/paper/ingest.ts')` 调 `importPaper` 种入游客库(绕过登录上传闸,先例:上一轮 Chrome 验证同法);
   - 进工作台原版 PDF 模式,收集全部 console(重点 `[pdf]` 前缀),等待后截图 + 断言:`rendered` 页数、canvas 像素非空白(`toDataURL` 长度阈值或 getImageData 抽样);
   - 同脚本跑 chromium 作对照组。
3. **拿到 WebKit 真实报错后对症修复**,预案(按嫌疑序):
   - 字体/cMap 类报错 → `getDocument` 补 `standardFontDataUrl` + `cMapUrl` + `cMapPacked: true`;资产用 `vite-plugin-static-copy` 把 `pdfjs-dist/{standard_fonts,cmaps}` 拷进产物(插件挂载包在 `paperEnabled` 条件里,flag-off 产物零 pdf 资产,循 paperCopilotOffPlugin 约定);
   - OffscreenCanvas/worker 解码类报错 → `getDocument` 传 `isOffscreenCanvasSupported: false`(或按报错精确定位的开关);
   - canvas 内存/特性类报错 → WebKit 下调 `MAX_DPR`、或按报错调整;
   - 若为其他未预料错误 → 按报错检索 pdf.js v6 issue 与源码分支,小步修复,始终在同一脚本里验证。
4. 验收:WebKit 复现脚本从"逐页报错"变为"首屏页 canvas 非空白 + `[pdf]` 零错误";chromium 对照组不回归。

## 工作流 2:重试 UX 与错误可诊断性(`src/components/papers/PdfViewer.tsx`)

即使根因修好也要做(下次再遇引擎差异时,远程一轮就能定位):
1. 重试反馈:点按后先显示「重试中…」(effect 重跑期间 renderError 已被幂等清掉,占位符阶段文案区分);连续失败 ≥2 次后,失败徽标下追加实际错误信息(`e.message` 截断)+「可切换文本视图阅读」提示。
2. viewer 级错误条:首个页渲染失败时,在页列表顶部显示一条可关闭的细提示「PDF 渲染引擎报错:<message>」——真机用户截图即可远程定位,不再需要 console。

## 工作流 3:列表卡片移动端布局(`src/pages/papers/PapersPage.tsx`)

卡片内层 `flex flex-wrap justify-between` 中:标题块 `min-w-0 flex-1` 会被压缩到近零而不触发换行。修复:标题块改 `min-w-0 basis-full md:basis-auto md:flex-1`(手机独占整行,按钮组自动折到第二行,元数据行恢复横排);按钮组内按钮补 `min-h-11 md:min-h-0` 触控热区。md+ 逐字还原现状(桌面零变化)。

## 验证

- `npm run typecheck` + `npx vitest run` 全量零回归;flag-on/flag-off 双构建(flag-off 产物 grep 无 standard_fonts/cmaps 泄漏,若采用了资产方案)。
- **WebKit 闭环**:`scripts/webkit-pdf-repro.mjs` 修复前捕获报错留档 → 修复后 WebKit 渲染成功断言 + chromium 对照;390 视口下顺带断言列表卡片标题占满整行、按钮在第二行。
- 发版 `scripts/deploy.sh --web` → 请用户真机复验(若仍失败,新的 viewer 级错误条会显示具体报错,截图即可继续定位)。
