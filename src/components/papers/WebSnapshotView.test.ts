import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import WebSnapshotView from './WebSnapshotView'
import { encodeWebSnapshot } from '../../lib/paper/url/webSnapshot'

/**
 * 安全护栏（node 环境，renderToStaticMarkup——effect 不跑，blob/iframe 都不会被触碰）：
 * 网页原貌 iframe 的 sandbox 必须**恰好**是 allow-same-origin。同源沙箱一旦再加 allow-scripts，
 * 页面脚本就能摘掉自己的沙箱——这是整个原貌视图的安全底线，任何人改动都要先撞到这里。
 */

const fixtureBytes = () =>
  encodeWebSnapshot({
    header: {
      url: 'https://a.com',
      finalUrl: 'https://a.com/final',
      title: 'A',
      capture: { mode: 'static', katex: false, viewportWidth: 1280, agentVersion: 1 },
      html: '<html><head></head><body><p data-pc-block="0">hi</p></body></html>',
      blocks: [{ index: 0, kind: 'paragraph', text: 'hi', anchor: { kind: 'html', blockIndex: 0 } }],
      stats: { assetBytes: 0, skipped: [] },
    },
    assets: [],
  }).bytes

const noop = () => undefined

function render(bytes: ArrayBuffer): string {
  return renderToStaticMarkup(
    createElement(WebSnapshotView as never, { bytes, blocks: [], containerRef: { current: null }, onVisibleBlock: noop }),
  )
}

describe('WebSnapshotView 安全护栏', () => {
  it('iframe sandbox 恰为 allow-same-origin，referrerpolicy=no-referrer，不内滚', () => {
    const html = render(fixtureBytes())
    const sandbox = html.match(/sandbox="([^"]*)"/)
    expect(sandbox?.[1]).toBe('allow-same-origin')
    expect(html).not.toContain('allow-scripts')
    // React 18 按 camelCase 输出 referrerPolicy；HTML 属性名不分大小写，按不分大小写断言
    expect(html).toMatch(/referrerpolicy="no-referrer"/i)
    expect(html).toContain('scrolling="no"')
    expect(html).toContain('title="网页原貌"')
    // srcdoc 由 effect 里的 blob 水合后才赋值：首次渲染不带 srcdoc（不会在 SSR/首帧就加载站点内容）
    expect(html).not.toContain('srcdoc=')
  })

  it('损坏的快照字节：渲染错误框而不是 iframe，不抛错', () => {
    const html = render(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer)
    expect(html).not.toContain('<iframe')
    expect(html).toContain('无法解析')
  })
})

/**
 * 接线护栏（源码级，沿 captureAgent.test.ts 断言函数体字面量的先例）：「当前块」观察器建在父窗口、
 * root 是隐式的顶层视口，rootMargin 必须由阅读窗格的实时几何换算（currentBlockRootMargin → bandMargin）。
 * 写死成 `-8px 0px -75% 0px` 量的是浏览器视口的上 1/4：窗口一矮带子就落到窗格之外，当前块冻住，
 * 译文窗口不再跟着滚动走（屏幕上的骨架永远等不到译文）。node 环境没有布局，effect 也不跑，
 * 真实行为由 .e2e-qa-fixtures/diag-translate-window.mjs 在浏览器里验；这里只防那句字面量被改回来。
 */
describe('WebSnapshotView「当前块」观察带护栏', () => {
  const src = readFileSync(new URL('./WebSnapshotView.tsx', import.meta.url), 'utf8')

  it('观察带按阅读窗格换算，并用专属内缩量', () => {
    expect(src).toMatch(/currentBlockRootMargin\(/)
    expect(src).toMatch(/SNAPSHOT_BAND_INSET,\s*\)/)
    expect(src).toMatch(/rootMargin:\s*bandMargin\b/)
  })

  it('任何观察器都不写相对视口的百分比 rootMargin', () => {
    expect(src).not.toMatch(/rootMargin:\s*[`'"][^`'"]*%/)
  })
})

/**
 * 滚动锚定与 iframe 高度护栏（源码级，同上）：原生 scroll anchoring 看不进 iframe，视口上方的译文一挂，正在读的内容
 * 就被整体推走（实测第 200 块「原文 → 对照」下移 6569px、当前块退到 154）；根元素的 scrollHeight 不小于 iframe 视口高，
 * 拿它当高度 iframe 就只增不减（「对照 → 原文」后底部 13107px 空白）。
 *
 * 分工：怎么判定（锚点规则、理想值累计、塌缩重对齐、A 的时序、平滑跳转的起计时与接管、滚动来源与暂缓、高度两段式与耦合）全是
 * snapshotDom.ts 里的纯函数，由 snapshotDom.test.ts 按数值和时序单测；真实几何由浏览器脚本验。这里只防**接线**被拆掉：
 * 组件确实经过这些纯函数、改 DOM 的地方确实包着锚定。名字只钉计划里点名的 applyLangState / syncHeight / scrollMainTo
 * 和被单测覆盖的纯函数，包裹函数、记录变量换个名字不该挂。
 */
describe('WebSnapshotView 滚动锚定护栏', () => {
  const src = readFileSync(new URL('./WebSnapshotView.tsx', import.meta.url), 'utf8')

  /** `s[open]` 是 `(`：按括号配平截出参数表（不含两端括号）。只用在不含字符串括号的简单表达式上 */
  const argsFrom = (s: string, open: number): string => {
    let depth = 0
    for (let i = open; i < s.length; i++) {
      if (s[i] === '(') depth++
      else if (s[i] === ')' && --depth === 0) return s.slice(open + 1, i)
    }
    throw new Error(`括号不配平：${s.slice(open, open + 80)}`)
  }

  /** `s[open]` 是 `{`：按花括号配平截出块体（不含两端花括号）。只用在不含模板字符串的简单函数体上 */
  const blockFrom = (s: string, open: number): string => {
    let depth = 0
    for (let i = open; i < s.length; i++) {
      if (s[i] === '{') depth++
      else if (s[i] === '}' && --depth === 0) return s.slice(open + 1, i)
    }
    throw new Error(`花括号不配平：${s.slice(open, open + 80)}`)
  }

  /** `const name = useCallback(…)` 的函数体（useCallback 的参数表）与第一个形参名 */
  const callbackOf = (name: string): { body: string; param: string | undefined } => {
    const def = src.match(new RegExp(String.raw`const ${name} = useCallback\(`))
    expect(def, `找不到 ${name} 的定义`).not.toBeNull()
    const body = argsFrom(src, def!.index! + def![0].length - 1)
    return { body, param: body.match(/^\s*\(\s*(\w+)\s*:/)?.[1] }
  }

  it('applyLangState 的每个调用处都在锚定包裹的回调里；锚定本体把回调交给 runAnchoredMutation（时序由它的单测钉住）', () => {
    const calls = [...src.matchAll(/\bapplyLangState\(/g)]
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      // 往回找最近一个「名字带 anchor 的函数 + 箭头回调」，它的参数表必须把这次调用包在里面
      const wraps = [...src.slice(0, call.index).matchAll(/\b(\w*[Aa]nchor\w*)\(\s*\(\)\s*=>/g)]
      const wrap = wraps[wraps.length - 1]
      expect(wrap, 'applyLangState 没有经过锚定包裹').toBeDefined()
      const open = wrap!.index! + wrap![1]!.length
      expect(open + argsFrom(src, open).length).toBeGreaterThan(call.index!)

      // 入口可以只做「要不要暂缓」的判定，把回调原样交给本体去锚定：自己不调用回调时跟一层
      let fn = callbackOf(wrap![1]!)
      expect(fn.param).toBeDefined()
      const callsParam = (f: typeof fn): boolean => new RegExp(String.raw`\b${f.param}\(\)`).test(f.body)
      if (!callsParam(fn)) {
        const delegate = fn.body.match(new RegExp(String.raw`\b(\w+)\(\s*${fn.param}\s*\)`))?.[1]
        expect(delegate, `${wrap![1]} 既不调用回调也没有交给别的函数`).toBeDefined()
        fn = callbackOf(delegate!)
        expect(fn.param).toBeDefined()
      }
      // 本体：回调交给 runAnchoredMutation——「补偿待处理的外部重排 → 现量锚点 → 改 DOM → 同步高度 → 补偿」这个顺序
      // 不再靠源码里的先后去猜，由 snapshotDom.test.ts 按调用顺序和一维模型单测
      const run = fn.body.match(/\brunAnchoredMutation(?:<[^>]*>)?\(/)
      expect(run, '锚定本体没有经过 runAnchoredMutation').not.toBeNull()
      expect(argsFrom(fn.body, run!.index! + run![0].length - 1)).toMatch(new RegExp(String.raw`\b${fn.param}\b`))
    }
  })

  it('A 现量锚点之前先按共享记录补偿外部重排，而且与 B 的 RO 回调共用同一个帮手', () => {
    // 回归（验收 C22 / 全应用 WebKit「中文」带缓存重开 2/94 次）：续读对齐后字体换上、上方矮了 52px，那次重排的 RO 回调
    // 要等下一次渲染才来，挂译文的 A 先跑——一上来现量锚点，把已经偏了的位置当成既成事实，B 随后位移为 0 不补，块停在 −35.5px。
    // 「先补偿、再现量」的顺序在 runAnchoredMutation 里（有单测）；这里钉的是接到它 compensatePending 上的确实是那个帮手
    const run = src.match(/\brunAnchoredMutation(?:<[^>]*>)?\(/)
    expect(run).not.toBeNull()
    const helper = argsFrom(src, run!.index! + run![0].length - 1).match(/\bcompensatePending:\s*(\w+)/)?.[1]
    expect(helper, 'compensatePending 没有接到具名的帮手上').toBeDefined()
    // 帮手：按 sharedRecordVerdict 判定记录能不能用，先同步高度（外部重排可能让文档变高，没同步就写会被钳位）再按记录补偿
    const body = callbackOf(helper!).body
    const order = [/\bsharedRecordVerdict\(/, /\.syncHeight\(\)/, /\brestore\w*\(/].map((re) => body.search(re))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // B：iframe 的 ResizeObserver 回调走的是同一个帮手（两条路径口径一致，随后到来的 B 位移为 0，不会重复补）
    const cb = src.match(/\bnew RO\((\w+)\)/)?.[1]
    expect(cb, '找不到 iframe 的 ResizeObserver 回调').toBeDefined()
    const def = src.match(new RegExp(String.raw`const ${cb} = \(\) => \{`))
    expect(def, `找不到 ${cb} 的定义`).not.toBeNull()
    expect(blockFrom(src, def!.index! + def![0].length - 1)).toMatch(new RegExp(String.raw`\b${helper}\(`))
  })

  it('滚动停稳重新记录共享锚点之前，也先走同一个帮手把待处理的外部重排补掉', () => {
    // 回归（全应用 WebKit 字体冷加载的重开）：B 补偿写入 scrollTop → 150ms 后「停稳」重新记录，字体恰好这时换上——
    // 直接现量把那 15px 当成既成事实吸收，随后到来的 B 位移为 0，块停在 +31.5px。凡是重新记录共享锚点之前都要先补。
    // 这里钉了 settleScroll 这个名字（停稳的处理函数）：改名时把这条一起改
    const run = src.match(/\brunAnchoredMutation(?:<[^>]*>)?\(/)
    expect(run).not.toBeNull()
    const helper = argsFrom(src, run!.index! + run![0].length - 1).match(/\bcompensatePending:\s*(\w+)/)?.[1]
    expect(helper).toBeDefined()
    const { body } = callbackOf('settleScroll')
    const pre = body.search(new RegExp(String.raw`\b${helper}\(\)`))
    expect(pre, '停稳时没有先按共享记录补偿').toBeGreaterThanOrEqual(0)
    // 补偿之后才是「不带对齐目标」的那次重新记录（平滑跳转结束走另一支，按它瞄准的位置记，不需要先补）
    expect(body.slice(pre)).toMatch(/\b\w*[Aa]nchor\w*\.current\s*=\s*capture\w*\(\)/)
  })

  it('判定都经过被单测覆盖的纯函数（内联回组件里，单测就管不到它了）', () => {
    const wired = [
      'inheritIdealScrollTop', // 理想 scrollTop：新记录继承
      'resolveIdealScrollTop', // 理想 scrollTop：写入后取整 / 钳位
      'anchorRestoreTarget', // 补偿写多少（含塌缩重对齐）
      'smoothStartsInPlace', // 平滑跳转发起时要不要起静止计时
      'trackSmoothProgress', // 平滑跳转中用户是否已接管
      'classifyScroll', // 滚动来源
      'shouldHoldMutation', // 原生滚动中暂缓改 DOM
      'syncFrameHeight', // 高度两段式 + 视口耦合
      'sharedRecordVerdict', // 共享记录还能不能拿来补偿
      'runAnchoredMutation', // A 的时序：先补偿待处理的外部重排，再现量锚点
    ]
    // 允许带类型实参的调用（`fn<T>(…)`）
    for (const name of wired) expect(src, name).toMatch(new RegExp(String.raw`\b${name}(?:<[^>]*>)?\(`))
  })

  it('iframe 高度不再无条件取根元素的 scrollHeight：Math.max 里只许出现 body 的 scrollHeight', () => {
    for (const m of src.matchAll(/\bMath\.max\(/g)) {
      const args = argsFrom(src, m.index! + m[0].length - 1)
      const receivers = [...args.matchAll(/(\w+)\??\.scrollHeight\b/g)].map((r) => r[1])
      expect(receivers.filter((r) => r !== 'body'), `Math.max(${args})`).toEqual([])
    }
  })

  it('瞬时写 scrollTop 只有一个入口（它负责记下「这是自己写的」）：滚轮转发桥、补偿、复位都不直接赋值', () => {
    // 漏记一处，那次写入引起的 scroll 事件就会被当成用户的原生滚动，随后的译文落地被无故暂缓（Chromium 滚轮中落地本该加法叠加）
    const direct = [...src.matchAll(/\.scrollTop\s*[-+]?=(?!=)\s*/g)]
    expect(direct.length).toBeGreaterThan(0)
    // 第一处赋值所在的 useCallback 就是入口：函数体里既有这句赋值，也把读回值记进了某个 ref
    const helper = [...src.slice(0, direct[0]!.index).matchAll(/const (\w+) = useCallback\(/g)].pop()?.[1]
    expect(helper).toBeDefined()
    expect(callbackOf(helper!).body).toMatch(/\.scrollTop\s*=(?!=)[\s\S]*?\w+\.current\s*=/)
    // 其余出现的只能是「把入口的返回值记进锚点记录」（`rec.scrollTop = 入口(…)`），不能再有别的直接赋值
    const stray = direct.slice(1).filter((m) => !src.slice(m.index! + m[0].length).startsWith(`${helper}(`))
    expect(stray.map((m) => src.slice(m.index! - 30, m.index! + 40))).toEqual([])
  })

  it('scrollMainTo 记下平滑跳转的目标（进行中有改动按它重新瞄准，不写 scrollTop 打断动画）', () => {
    const { body } = callbackOf('scrollMainTo')
    expect(body).toMatch(/\b\w*[Ss]mooth\w*\.current\s*=/)
    expect(body).toContain("'smooth'")
  })

  it('瞬时的程序化对齐（续读对齐）scrollTo 之后立即重新记录共享锚点，不等静止计时', () => {
    // 回归（验收 C10）：续读对齐 scrollToBlock(idx,'auto') 的 scroll 事件作废了记录，要等静止 150ms 才重记；
    // 字体换上、图片解码恰好落在这段空当里，B 拿不到记录不补偿，块被推走 240px 就停在那里。
    // 只钉形状：scrollTo 之后，在「不是 smooth」的分支里把共享记录（名字带 anchor 的 ref）换成现量（capture…）的锚点
    const { body } = callbackOf('scrollMainTo')
    const scrollAt = body.search(/\.scrollTo\(/)
    expect(scrollAt).toBeGreaterThanOrEqual(0)
    expect(body.slice(scrollAt)).toMatch(/(?:\belse\b|!==\s*'smooth')[\s\S]*?\b\w*[Aa]nchor\w*\.current\s*=\s*\w*capture\w*\(/)
  })

  it('加载提示叠在 iframe 上、不占流内高度：iframe 上方没有会随绑定消失的流内内容', () => {
    // 回归（验收 C23）：提示原先是排在 iframe 上方的 <p>（52px），「已绑定」那次提交时消失。续读对齐（两帧 rAF）抢在这次
    // 提交之前时，对齐完 iframe 又整体上移 52px——iframe 文档内部没变，锚定看不见；WebKit 没有原生 scroll anchoring，
    // 带缓存重开约 5% 停在 −35.5px。首次渲染（绑定之前）的标记里：提示必须是绝对定位，且与 iframe 同在一个相对定位的容器里
    const html = render(fixtureBytes())
    expect(html).toMatch(/<div class="relative"><p class="[^"]*\babsolute\b[^"]*">正在渲染网页原貌…<\/p><iframe\b/)
  })
})
