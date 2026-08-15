/**
 * WebKit / Chromium 的原版 PDF 渲染回归脚本(常驻仓库)。
 *
 * 背景:iOS Safari(WebCore)上 pdf.js 逐页渲染失败,桌面 Chrome 正常。Playwright WebKit
 * 与 iOS Safari 同内核,可在本机进入「改 → 验」闭环,不依赖真机往返。
 *
 * 做什么:
 *   1. 确保 dev server(默认 5173,没起就自己拉一个);
 *   2. 打开 /#/papers,经 page.evaluate 动态 import ingest.ts 把 fixtures PDF 种入游客库
 *      (绕过登录上传闸,与既往 Chrome 浏览器验证同一先例);
 *   3. 390×844 视口下断言列表卡片:标题块独占整行、按钮组折到第二行(移动端布局回归);
 *   4. 进工作台原版 PDF 模式,收集全部 [pdf] console 与 pageerror(渲染失败时的真实
 *      Error.stack 是根因定位的唯一依据),断言首屏页 canvas 非空白。
 *
 * 用法:
 *   node scripts/webkit-pdf-repro.mjs                  # webkit + chromium 对照各跑一遍
 *   node scripts/webkit-pdf-repro.mjs --engine=webkit  # 只跑 webkit
 *   node scripts/webkit-pdf-repro.mjs --base=http://localhost:5173 --fixture=vllm-paged-attention.pdf
 *
 * 退出码:0 = 所有引擎全部断言通过;1 = 任一断言失败(console 里有完整报错留档)。
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const ENGINES = arg('engine', 'both') === 'both' ? ['webkit', 'chromium'] : [arg('engine', 'both')]
const BASE = arg('base', 'http://localhost:5173')
const FIXTURE = arg('fixture', 'attention-is-all-you-need.pdf')
/** 首屏应渲染成功的页数(range 兜底 {1,1} + rootMargin 预渲染,首屏至少 1-2 页) */
const CHECK_PAGES = 2
/** 空白 canvas 的 toDataURL 长度量级为 1-3KB;渲染出正文的页至少几十 KB */
const BLANK_DATAURL_THRESHOLD = 10_000
const RENDER_TIMEOUT_MS = 45_000

// ---------------------------------------------------------------------------
// dev server:优先复用已起的;没有就自己拉,结束时收掉
// ---------------------------------------------------------------------------
async function ensureDevServer() {
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(2000) })
    console.log(`[repro] 复用已运行的 dev server: ${BASE}`)
    return null
  } catch {
    /* 没起,下面自己拉 */
  }
  console.log('[repro] 启动 npm run dev …')
  const child = spawn('npm', ['run', 'dev'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.stdout.on('data', () => {})
  child.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`))
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await fetch(BASE, { signal: AbortSignal.timeout(1000) })
      console.log('[repro] dev server 就绪')
      return child
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  child.kill()
  throw new Error('dev server 30s 内未就绪')
}

// ---------------------------------------------------------------------------
// 单引擎跑一轮:种论文 → 列表布局断言 → 工作台渲染断言
// ---------------------------------------------------------------------------
async function runEngine(playwright, engineName, pdfB64, fixtureName) {
  const failures = []
  const pdfLogs = []
  let browser = null
  let page = null
  try {
    browser = await playwright[engineName].launch()
    // iPhone 尺寸:同时覆盖「390 视口列表卡片布局」与移动端渲染路径;DPR=2 与真机一致
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
    page = await context.newPage()
  } catch (e) {
    failures.push(`浏览器启动失败: ${e instanceof Error ? e.message : String(e)}`)
    await browser?.close().catch(() => {})
    return { engine: engineName, failures, pdfLogs }
  }

  page.on('console', (msg) => {
    void (async () => {
      // console.error('[pdf] …', e) 的第二个参数是 Error 对象:必须在页面里展开 stack,
      // 默认序列化只会得到 "JSHandle@error",丢掉根因
      const parts = await Promise.all(
        msg.args().map((a) =>
          a
            .evaluate((v) => (v instanceof Error ? `${v.name}: ${v.message}\n${v.stack ?? ''}` : String(v)))
            .catch(() => '<unserializable>'),
        ),
      )
      const text = parts.length ? parts.join(' ') : msg.text()
      if (text.includes('[pdf]') || msg.type() === 'error') {
        pdfLogs.push(`[console.${msg.type()}] ${text}`)
        console.log(`[${engineName}] ${text}`)
      }
    })()
  })
  page.on('pageerror', (err) => {
    pdfLogs.push(`[pageerror] ${err.stack ?? err.message}`)
    console.log(`[${engineName}] pageerror: ${err.stack ?? err.message}`)
  })

  try {
    await page.goto(`${BASE}/#/papers`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("论文陪读")', { timeout: 15_000 })

    // --- 种论文(游客库;fresh context 每次都是全新 IndexedDB) ---
    // evaluate 没有内建超时:worker 卡死时 promise 永不落地,这里兜一个 120s 硬超时。
    // Vite 冷启动首次发现新依赖会整页 reload(Execution context was destroyed),重试一次即暖机。
    const seedOnce = () => Promise.race([
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('种论文超时(120s):pdf.js 解析可能在该内核挂起')), 120_000),
      ),
      page.evaluate(
      async ({ b64, name }) => {
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const [{ importPaper }, { getRepos }, { sha256Hex }, { parsePdfBytes }] = await Promise.all([
          import('/src/lib/paper/ingest.ts'),
          import('/src/lib/paper/repo/repos.ts'),
          import('/src/lib/paper/validate.ts'),
          import('/src/lib/paper/parsePdf.ts'),
        ])
        const outcome = await importPaper(
          { name, size: bytes.byteLength, type: 'application/pdf', bytes: bytes.buffer },
          { repo: getRepos().paper, hash: sha256Hex, parse: (input) => parsePdfBytes(input.bytes) },
        )
        if (outcome.kind === 'duplicate') return outcome.existing.id
        if (outcome.kind === 'ready') return outcome.paper.id
        throw new Error(`importPaper failed: ${JSON.stringify(outcome.failure)}`)
      },
      { b64: pdfB64, name: fixtureName },
    )])
    let paperId
    try {
      paperId = await seedOnce()
    } catch (e) {
      if (!String(e).includes('Execution context was destroyed')) throw e
      console.log(`[${engineName}] Vite 冷启动 reload,重试种论文`)
      await page.waitForSelector('h1:has-text("论文陪读")', { timeout: 15_000 })
      paperId = await seedOnce()
    }
    console.log(`[${engineName}] 已种入论文 ${paperId}`)

    // --- 列表卡片布局断言(390 视口):标题块独占整行,按钮组折到第二行 ---
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('li h2', { timeout: 15_000 })
    const layout = await page.evaluate(() => {
      const li = document.querySelector('ul li')
      if (!li) return null
      const title = li.querySelector('h2')
      const buttons = [...li.querySelectorAll('button')]
      if (!title || !buttons.length) return null
      const titleBox = title.closest('div.min-w-0')?.getBoundingClientRect()
      const cardBox = li.getBoundingClientRect()
      const firstBtnBox = buttons[0].getBoundingClientRect()
      return {
        titleWidth: titleBox?.width ?? 0,
        cardWidth: cardBox.width,
        // 按钮组在标题块下方 = 已折行
        buttonBelowTitle: titleBox ? firstBtnBox.top >= titleBox.bottom - 1 : false,
        buttonHeight: firstBtnBox.height,
      }
    })
    if (!layout) {
      failures.push('列表卡片:未找到卡片 DOM')
    } else {
      // 标题块应占卡片内容区 ≥85%(basis-full);修复前被按钮组挤到极窄
      if (layout.titleWidth < layout.cardWidth * 0.85) {
        failures.push(`列表卡片:标题块仅 ${Math.round(layout.titleWidth)}px / 卡片 ${Math.round(layout.cardWidth)}px,未独占整行`)
      }
      if (!layout.buttonBelowTitle) failures.push('列表卡片:按钮组未折到标题下方')
      if (layout.buttonHeight < 43) failures.push(`列表卡片:按钮触控高度 ${layout.buttonHeight}px < 44px`)
    }

    // --- 工作台原版 PDF 渲染断言 ---
    await page.goto(`${BASE}/#/papers/${paperId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-page="1"]', { timeout: 20_000 })

    // 等到首屏页「渲染完成(canvas 有位图 + 无覆盖层)」或「显式失败」,谁先到算谁
    const settle = await page
      .waitForFunction(
        (n) => {
          const holders = [...document.querySelectorAll('[data-page]')].slice(0, n)
          if (!holders.length) return false
          const states = holders.map((h) => {
            const canvas = h.querySelector('canvas')
            const failed = !!h.querySelector('button') // 失败态才有重试按钮
            // 占位层与失败层都是 absolute 覆盖层;两者都不在 + canvas 有位图 = 渲染完成
            const done = !!canvas && canvas.width > 0 && !h.querySelector('div.absolute') && !failed
            return failed ? 'failed' : done ? 'done' : 'pending'
          })
          return states.every((s) => s !== 'pending') ? states : false
        },
        CHECK_PAGES,
        { timeout: RENDER_TIMEOUT_MS },
      )
      .then((h) => h.jsonValue())
      .catch(() => null)

    if (!settle) {
      failures.push(`PDF:前 ${CHECK_PAGES} 页 ${RENDER_TIMEOUT_MS / 1000}s 内未达到终态(卡在占位符)`)
    } else {
      const failedPages = settle.filter((s) => s === 'failed').length
      if (failedPages) failures.push(`PDF:前 ${CHECK_PAGES} 页中 ${failedPages} 页渲染失败`)
    }

    // 非空白断言:空白页 toDataURL 只有 1-3KB
    const pixels = await page.evaluate((n) => {
      return [...document.querySelectorAll('[data-page]')].slice(0, n).map((h) => {
        const canvas = h.querySelector('canvas')
        if (!canvas || !canvas.width) return { width: 0, dataLen: 0 }
        try {
          return { width: canvas.width, dataLen: canvas.toDataURL('image/png').length }
        } catch {
          return { width: canvas.width, dataLen: -1 }
        }
      })
    }, CHECK_PAGES)
    pixels.forEach((p, i) => {
      if (p.dataLen >= 0 && p.dataLen < BLANK_DATAURL_THRESHOLD) {
        failures.push(`PDF:第 ${i + 1} 页 canvas 空白(width=${p.width}, dataURL=${p.dataLen}B)`)
      }
    })
    console.log(`[${engineName}] canvas 采样: ${JSON.stringify(pixels)}`)
  } catch (e) {
    failures.push(`脚本异常: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  } finally {
    await browser.close()
  }
  return { engine: engineName, failures, pdfLogs }
}

// ---------------------------------------------------------------------------
const pdfB64 = (await readFile(join(root, 'scripts/paper-eval/fixtures', FIXTURE))).toString('base64')
const devChild = await ensureDevServer()

let exitCode = 0
try {
  const { webkit, chromium } = await import('playwright')
  const playwright = { webkit, chromium }
  for (const engine of ENGINES) {
    console.log(`\n===== ${engine} =====`)
    const result = await runEngine(playwright, engine, pdfB64, FIXTURE)
    if (result.failures.length) {
      exitCode = 1
      console.log(`\n[${engine}] ❌ ${result.failures.length} 项断言失败:`)
      for (const f of result.failures) console.log(`  - ${f}`)
    } else {
      console.log(`\n[${engine}] ✅ 全部断言通过`)
    }
  }
} finally {
  if (devChild) {
    // detached 起的进程组要整组收掉,不然 vite 的 esbuild 子进程会泄漏
    try {
      process.kill(-devChild.pid, 'SIGTERM')
    } catch {
      devChild.kill('SIGTERM')
    }
  }
}
process.exit(exitCode)
