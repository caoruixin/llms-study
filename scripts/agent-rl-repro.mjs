/** Agent RL UI regression. Runs real browser controls, with no external model calls.
 * node scripts/agent-rl-repro.mjs [--engine=chromium|webkit] [--base=http://localhost:5173]
 */
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const option = (key, fallback) => process.argv.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const base = option('base', 'http://localhost:5173')
const selected = option('engine', 'both')
const engines = selected === 'both' ? { chromium, webkit } : { [selected]: { chromium, webkit }[selected] }
const output = join(root, 'output/playwright/agent-rl')
await mkdir(output, { recursive: true })
let server
try {
  await fetch(base, { signal: AbortSignal.timeout(1500) })
} catch {
  server = spawn('npm', ['run', 'dev', '--', '--port', String(new URL(base).port || 5173)], {
    cwd: root,
    stdio: 'ignore',
  })
  let ready = false
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(base, { signal: AbortSignal.timeout(500) })
      ready = true
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }
  if (!ready) {
    server.kill()
    throw new Error('Dev server did not become ready')
  }
}
try {
  for (const [name, engine] of Object.entries(engines)) {
    assert(engine, `Unknown browser engine ${name}`)
    const browser = await engine.launch({ headless: true })
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
      const errors = []
      const modelRequests = []
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('request', (request) => {
        if (/\/api\/(moonshot|zhipu|deepseek|openai-compat)/.test(request.url())) modelRequests.push(request.url())
      })
      // Guest auth is unrelated to the simulator and is the only expected API request.
      await page.route('**/api/app/auth/me', (route) =>
        route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthenticated"}' }),
      )
      await page.goto(`${base}/#/agent-rl`)
      await page.waitForLoadState('networkidle')
      assert((await page.locator('body').innerText()).includes('Agent 如何从反馈中学会？'))
      const tab = (name) => page.getByRole('tab', { name, exact: true }).click()
      const button = (name) => page.getByRole('button', { name, exact: true })
      const screenshot = async (label) => {
        await page.evaluate(() => window.scrollTo(0, 0))
        await page.screenshot({ path: join(output, `${name}-${label}.png`) })
      }
      const run = async () => {
        await button('自动运行').click()
        await button('训练已完成').waitFor({ timeout: 60000 })
      }
      await screenshot('desktop-map')
      await tab('跟着训练一次')
      for (const phase of ['采样轨迹', '计算奖励', '估计优势', '更新参数', '保存快照', '同步并验证'])
        await button(`下一步：${phase}`).click()
      assert((await page.locator('body').innerText()).includes('实验进度 1 / 40'))
      await button('自动运行').click()
      await button('暂停训练').waitFor()
      await button('暂停训练').click()
      const progress = await page.getByText(/^实验进度 /).textContent()
      await page.waitForTimeout(350)
      assert.equal(await page.getByText(/^实验进度 /).textContent(), progress, 'pause must stop progression')
      await run()
      await screenshot('desktop-trained')
      await page.getByRole('heading', { name: '打开一条轨迹，看清一次决策' }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(output, `${name}-trajectory.png`) })
      await tab('算法与奖励')
      await button('保留本次结果到对照表').click()
      assert(
        (await page.locator('body').innerText()).includes('reinforce') ||
          (await page.locator('body').innerText()).includes('REINFORCE'),
      )
      await tab('评估与升级')
      await button('运行冻结测试集').click()
      await button('运行模拟灰度 / A/B').click()
      assert.equal(await button('发布候选版本').isEnabled(), true)
      await button('发布候选版本').click()
      await page.getByText('当前生产版本 v40', { exact: true }).waitFor()
      await page.getByRole('button', { name: '回滚到上一生产版本 v0', exact: true }).click()
      await page.getByText('当前生产版本 v0', { exact: true }).waitFor()
      await screenshot('evaluation')
      await tab('服务与成本')
      await button('只采购 Rollout').click()
      await button('专用 GPU 时间').click()
      assert((await page.locator('body').innerText()).includes('GPU 数 × 用户填写的运行小时'))
      await page.getByLabel('推演额外使用 LLM Judge 的费用').check()
      await page.getByLabel('每次 Judge 输入 Token', { exact: true }).fill('900')
      await screenshot('provider')
      // Every algorithm is reachable and runs its own numeric path.
      for (const algorithm of ['PPO', 'GRPO']) {
        await tab('算法与奖励')
        await button(algorithm).click()
        await page.getByLabel('训练轮数', { exact: true }).fill('2')
        await button('用当前配置开始跟练 →').click()
        await run()
        assert((await page.locator('body').innerText()).includes('实验进度 2 / 2'))
      }
      await tab('算法与奖励')
      await page.getByRole('button', { name: /^03 · 奖励没有区分度/ }).click()
      await tab('算法与奖励')
      await page.getByLabel('训练轮数', { exact: true }).fill('2')
      await button('用当前配置开始跟练 →').click()
      await run()
      assert((await page.getByText('当前动作 Advantage', { exact: true }).locator('..').innerText()).includes('0.000'))
      await tab('算法与奖励')
      await page.getByRole('button', { name: /^06 · 权重没有同步/ }).click()
      await run()
      await button('同步采样器到 v1').click()
      assert.equal(await button('同步采样器到 v1').count(), 0)
      // App navigation preserves the in-memory experiment.
      await page.getByRole('link', { name: '回看 Agent 架构 ↗' }).click()
      await page.getByRole('link', { name: /进入 Agent RL 模拟器/ }).click()
      assert((await page.locator('body').innerText()).includes('实验进度 1 / 1'))
      await page.setViewportSize({ width: 390, height: 844 })
      for (const view of ['全流程地图', '跟着训练一次', '算法与奖励', '评估与升级', '服务与成本']) {
        await tab(view)
        await page.waitForTimeout(80)
        const dimensions = await page.evaluate(() => ({
          width: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
        }))
        assert(
          dimensions.scroll <= dimensions.width + 1,
          `${name}/${view}: document overflow ${JSON.stringify(dimensions)}`,
        )
      }
      await tab('全流程地图')
      await screenshot('mobile-map')
      await page.getByRole('tab', { name: '全流程地图', exact: true }).focus()
      await page.keyboard.press('ArrowRight')
      assert.equal(
        await page.getByRole('tab', { name: '跟着训练一次', exact: true }).getAttribute('aria-selected'),
        'true',
      )
      await screenshot('mobile-training')
      await tab('全流程地图')
      await button('不需要，可靠的规则也可以提供奖励').click()
      await page.reload()
      await page.waitForLoadState('networkidle')
      assert((await page.locator('body').innerText()).includes('1 / 6 概念掌握'))
      assert((await page.locator('body').innerText()).includes('0 / 1 轮完成'))
      await tab('跟着训练一次')
      assert((await page.locator('body').innerText()).includes('自定义实验'))
      assert.deepEqual(errors, [], `${name} must not throw runtime errors`)
      assert.deepEqual(modelRequests, [], 'simulator must not call a model provider')
      console.log(
        `[agent-rl] ${name}: training / pause / algorithms / test / canary / rollback / pricing / navigation / 390px / persistence PASS`,
      )
    } finally {
      await browser.close()
    }
  }
} finally {
  server?.kill()
}
