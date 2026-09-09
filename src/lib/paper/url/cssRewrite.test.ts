import { describe, expect, it } from 'vitest'
import {
  CSS_ASSET_SCHEME,
  absolutizeCssUrls,
  collectCssRefs,
  escapeCssForMarkup,
  hydrateCssTokens,
  inlineImports,
  rewriteDeclarationValues,
  substituteCssAssets,
} from './cssRewrite'

const BASE = 'https://site.example/assets/css/main.css'

describe('collectCssRefs', () => {
  it('收集 url() 的相对/绝对/引号/无引号写法并解析成绝对 URL', () => {
    const css = [
      '.a{background:url(../img/a.png)}',
      ".b{background:url('b.png')}",
      '.c{background:url( "https://cdn.example/c.png" )}',
      '.d{background:url(/root.png)}',
    ].join('\n')
    expect(collectCssRefs(css, BASE).map((r) => r.abs)).toEqual([
      'https://site.example/assets/img/a.png',
      'https://site.example/assets/css/b.png',
      'https://cdn.example/c.png',
      'https://site.example/root.png',
    ])
  })

  it('跳过 data:/blob:/#frag/pc-asset:/about: 与非 http(s)', () => {
    const css = [
      '.a{background:url(data:image/svg+xml;utf8,<svg xmlns="x"/>)}',
      '.b{background:url(blob:https://site.example/1234)}',
      '.c{filter:url(#soft-shadow)}',
      `.d{background:url("${CSS_ASSET_SCHEME}abc")}`,
      '.e{background:url(about:blank)}',
      '.f{background:url(chrome-extension://x/y.png)}',
    ].join('\n')
    expect(collectCssRefs(css, BASE)).toEqual([])
  })

  it('@font-face 的 src 标 isFont，同块其他 url() 与块外 url() 不标', () => {
    const css = [
      '@font-face{font-family:X;src:url(a.woff2) format("woff2"),url(b.ttf)}',
      '@media screen{@font-face{font-family:Y;src:url(c.woff2)}}',
      '.x{background:url(bg.png)}',
    ].join('\n')
    const refs = collectCssRefs(css, BASE)
    expect(refs.map((r) => [r.raw, r.isFont])).toEqual([
      ['a.woff2', true],
      ['b.ttf', true],
      ['c.woff2', true],
      ['bg.png', false],
    ])
  })

  it('选择器里被转义的引号不当字符串开头（Tailwind 任意值工具类）', () => {
    // `.bg-[url('…')]` 转义后满是 \' \" ——误判成字符串会一路吞到下一个引号，
    // 把其后整段样式表（@font-face、背景图）从扫描结果里抹掉。
    const css = [
      String.raw`.bg-\[url\(\'https\:\/\/cdn.example\/a\.png\'\)\]{background-image:url(https://cdn.example/a.png)}`,
      String.raw`.bg-\[url\(\"https\:\/\/cdn.example\/b\.png\"\)\]{background-image:url(https://cdn.example/b.png)}`,
      '@font-face{font-family:F;src:url(https://cdn.example/f.woff2) format("woff2")}',
      '.tail{background:url(tail.png)}',
    ].join('')
    expect(collectCssRefs(css, BASE).map((r) => [r.abs, r.isFont])).toEqual([
      ['https://cdn.example/a.png', false],
      ['https://cdn.example/b.png', false],
      ['https://cdn.example/f.woff2', true],
      ['https://site.example/assets/css/tail.png', false],
    ])
  })

  it('转义引号之后的相对 url() 仍被绝对化', () => {
    const css = String.raw`.bg-\[url\(\'x\'\)\]{color:red}.c{background:url(../img/rel.png)}`
    expect(absolutizeCssUrls(css, BASE)).toContain('https://site.example/assets/img/rel.png')
  })

  it('注释与字符串里的 url( 不算引用', () => {
    const css = [
      '/* 旧版写法：url(https://old.example/legacy.png) */',
      '.a{content:"url(https://string.example/x.png)"}',
      '.b{background:url(real.png)}',
    ].join('\n')
    expect(collectCssRefs(css, BASE).map((r) => r.abs)).toEqual(['https://site.example/assets/css/real.png'])
  })

  it('@import 的字符串与 url() 两种写法、带与不带媒体查询', () => {
    const css = [
      '@import "reset.css";',
      "@import url('theme.css') screen and (min-width: 600px);",
      '@import url(https://cdn.example/print.css) print;',
    ].join('\n')
    expect(collectCssRefs(css, BASE)).toEqual([
      { kind: 'import', raw: 'reset.css', abs: 'https://site.example/assets/css/reset.css', isFont: false },
      {
        kind: 'import',
        raw: 'theme.css',
        abs: 'https://site.example/assets/css/theme.css',
        media: 'screen and (min-width: 600px)',
        isFont: false,
      },
      { kind: 'import', raw: 'https://cdn.example/print.css', abs: 'https://cdn.example/print.css', media: 'print', isFont: false },
    ])
  })

  it('@import 的 layer / layer(name) / supports() 条件按规范顺序拆开，不混进媒体查询', () => {
    const css = [
      '@import url(a.css) layer(theme);',
      '@import "b.css" layer;',
      '@import url(c.css) supports(display: grid) screen and (min-width: 600px);',
      '@import url(d.css) layer(base.reset) supports((display:grid) and (gap:1px)) print;',
    ].join('\n')
    expect(collectCssRefs(css, BASE)).toEqual([
      { kind: 'import', raw: 'a.css', abs: 'https://site.example/assets/css/a.css', layer: 'theme', isFont: false },
      { kind: 'import', raw: 'b.css', abs: 'https://site.example/assets/css/b.css', layer: '', isFont: false },
      {
        kind: 'import',
        raw: 'c.css',
        abs: 'https://site.example/assets/css/c.css',
        media: 'screen and (min-width: 600px)',
        supports: 'display: grid',
        isFont: false,
      },
      {
        kind: 'import',
        raw: 'd.css',
        abs: 'https://site.example/assets/css/d.css',
        media: 'print',
        layer: 'base.reset',
        supports: '(display:grid) and (gap:1px)',
        isFont: false,
      },
    ])
  })

  it('url() 内的转义与括号不破坏扫描', () => {
    const css = String.raw`.a{background:url(a\(1\).png)}.b{background:url("q\"uote.png")}`
    expect(collectCssRefs(css, BASE).map((r) => r.raw)).toEqual(['a(1).png', 'q"uote.png'])
  })
})

describe('absolutizeCssUrls', () => {
  it('改写相对目标，保留引号风格与其余文本', () => {
    const css = `.a{background:url(../img/a.png) no-repeat}.b{background:url('b.png')}.c{background:url("https://cdn.example/c.png")}`
    expect(absolutizeCssUrls(css, BASE)).toBe(
      `.a{background:url(https://site.example/assets/img/a.png) no-repeat}` +
        `.b{background:url('https://site.example/assets/css/b.png')}` +
        `.c{background:url("https://cdn.example/c.png")}`,
    )
  })

  it('data:/#frag/blob:/pc-asset: 原样不动', () => {
    const css = `.a{background:url(data:image/png;base64,iVBOR)}.b{filter:url(#f)}.c{background:url(blob:https://x/1)}.d{background:url("${CSS_ASSET_SCHEME}id1")}`
    expect(absolutizeCssUrls(css, BASE)).toBe(css)
  })

  it('@import 与 @font-face src 一并绝对化', () => {
    const css = '@import url(reset.css) screen;\n@font-face{src:url(f.woff2)}'
    expect(absolutizeCssUrls(css, BASE)).toBe(
      '@import url(https://site.example/assets/css/reset.css) screen;\n' +
        '@font-face{src:url(https://site.example/assets/css/f.woff2)}',
    )
  })

  it('带引号目标里的空格与转义引号写回后仍能被再次扫描出来', () => {
    const out = absolutizeCssUrls(String.raw`.a{background:url("a b.png")}.b{background:url('it\'s.png')}`, BASE)
    expect(out).toBe(
      String.raw`.a{background:url("https://site.example/assets/css/a%20b.png")}` +
        String.raw`.b{background:url('https://site.example/assets/css/it\'s.png')}`,
    )
    expect(collectCssRefs(out, BASE).map((r) => r.abs)).toEqual([
      'https://site.example/assets/css/a%20b.png',
      "https://site.example/assets/css/it's.png",
    ])
  })
})

describe('inlineImports', () => {
  it('抓到的替换成正文，带媒体查询的包一层 @media', () => {
    const css = absolutizeCssUrls('@import "a.css";\n@import url(b.css) print;\n.z{color:red}', BASE)
    const out = inlineImports(css, (abs) =>
      abs.endsWith('a.css') ? '.a{color:blue}' : abs.endsWith('b.css') ? '.b{color:green}' : null,
    )
    expect(out).toBe('.a{color:blue}\n@media print {\n.b{color:green}\n}\n.z{color:red}')
  })

  it('抓不到的保留原样（绝对形式的 @import）', () => {
    const css = absolutizeCssUrls('@import url(fonts.css);\n.z{color:red}', 'https://fonts.example/x.css')
    expect(inlineImports(css, () => null)).toBe('@import url(https://fonts.example/fonts.css);\n.z{color:red}')
  })

  it('深度由调用方控制：对解析回来的文本再调一次即可拉平第二层', () => {
    const sheets: Record<string, string> = {
      'https://site.example/assets/css/a.css': '@import "deep.css";\n.a{color:blue}',
      'https://site.example/assets/css/deep.css': '.deep{color:black}',
    }
    const level1 = inlineImports(absolutizeCssUrls('@import "a.css";', BASE), (abs) =>
      abs in sheets ? absolutizeCssUrls(sheets[abs], abs) : null,
    )
    expect(level1).toContain('@import "https://site.example/assets/css/deep.css"')
    const level2 = inlineImports(level1, (abs) => (abs in sheets ? sheets[abs] : null))
    expect(level2).toBe('.deep{color:black}\n.a{color:blue}')
  })

  it('只动 @import，不碰普通 url()', () => {
    const css = '.a{background:url(https://x.example/a.png)}'
    expect(inlineImports(css, () => 'REPLACED')).toBe(css)
  })

  it('layer(name) 包成 @layer name {…}，匿名 layer 包成 @layer {…}', () => {
    const css = absolutizeCssUrls('@import url(a.css) layer(theme);\n@import "b.css" layer;', BASE)
    const out = inlineImports(css, (abs) => (abs.endsWith('a.css') ? '.a{color:blue}' : '.b{color:green}'))
    expect(out).toBe('@layer theme {\n.a{color:blue}\n}\n@layer {\n.b{color:green}\n}')
  })

  it('supports() + 媒体查询：@supports 在外、@media 在内；三者齐时 @layer 最外', () => {
    const css = absolutizeCssUrls(
      '@import url(c.css) supports(display:grid) screen;\n@import url(d.css) layer(base) supports((display:grid) and (gap:1px)) print;',
      BASE,
    )
    const out = inlineImports(css, (abs) => (abs.endsWith('c.css') ? '.c{display:grid}' : '.d{gap:1px}'))
    expect(out).toBe(
      '@supports (display:grid) {\n@media screen {\n.c{display:grid}\n}\n}\n' +
        '@layer base {\n@supports ((display:grid) and (gap:1px)) {\n@media print {\n.d{gap:1px}\n}\n}\n}',
    )
  })

  it('抓不到的 @import 连同 layer/supports/媒体条件原样保留', () => {
    const css = absolutizeCssUrls('@import url(x.css) layer(theme) supports(display:grid) print;\n.z{color:red}', BASE)
    expect(inlineImports(css, () => null)).toBe(
      '@import url(https://site.example/assets/css/x.css) layer(theme) supports(display:grid) print;\n.z{color:red}',
    )
  })
})

describe('rewriteDeclarationValues', () => {
  const up = (v: string): string => v.toUpperCase()

  it('只改声明值：选择器、属性名、at 语句、字符串、注释、url() 一律原样', () => {
    const css = [
      '@import url(x.css) screen;',
      '@charset "utf-8";',
      '/* top: 1vh */',
      '.min-h-\\[100dvh\\]:hover, a[href="x"]{min-height:100dvh;content:"abc";background:url(data:image/png;base64,abc/def=)}',
    ].join('\n')
    expect(rewriteDeclarationValues(css, up)).toBe(
      [
        '@import url(x.css) screen;',
        '@charset "utf-8";',
        '/* top: 1vh */',
        '.min-h-\\[100dvh\\]:hover, a[href="x"]{min-height:100DVH;content:"abc";background:url(data:image/png;base64,abc/def=)}',
      ].join('\n'),
    )
  })

  it('嵌套块（@media / @supports / @layer / CSS nesting）里的声明照改，前置不动', () => {
    const css = '@media screen and (min-height:10vh){@supports (a:b){@layer x{.a{h:1vh;&:hover{w:2vh}}}}}'
    expect(rewriteDeclarationValues(css, up)).toBe(
      '@media screen and (min-height:10vh){@supports (a:b){@layer x{.a{h:1VH;&:hover{w:2VH}}}}}',
    )
  })

  it('裸声明列表（style 属性）与不带分号收尾的最后一条声明', () => {
    expect(rewriteDeclarationValues('height:1vh; color: red', up)).toBe('height:1VH; color: RED')
    expect(rewriteDeclarationValues('a{h:1vh}', up)).toBe('a{h:1VH}')
  })

  it('值里夹着字符串/url 时只改字符串与 url 之外的部分', () => {
    const css = ".a{background:url('a b.png') no-repeat 1vh, url(c.png) 2vh;font:1vh 'x y'}"
    expect(rewriteDeclarationValues(css, up)).toBe(
      ".a{background:url('a b.png') NO-REPEAT 1VH, url(c.png) 2VH;font:1VH 'x y'}",
    )
  })
})

describe('substituteCssAssets / hydrateCssTokens', () => {
  it('占位替换与水合往返', () => {
    const css = `.a{background:url("https://x.example/a.png")}.b{background:url(https://x.example/b.png)}`
    const ids: Record<string, string> = { 'https://x.example/a.png': 'id-a', 'https://x.example/b.png': 'id-b' }
    const tokenized = substituteCssAssets(css, (abs) => ids[abs] ?? null)
    expect(tokenized).toBe(`.a{background:url("${CSS_ASSET_SCHEME}id-a")}.b{background:url(${CSS_ASSET_SCHEME}id-b)}`)
    const blobs: Record<string, string> = { 'id-a': 'blob:https://app/1', 'id-b': 'blob:https://app/2' }
    expect(hydrateCssTokens(tokenized, (id) => blobs[id] ?? null)).toBe(
      `.a{background:url("blob:https://app/1")}.b{background:url(blob:https://app/2)}`,
    )
  })

  it('没固化成资源的 URL 保持远程地址', () => {
    const css = '.a{background:url(https://x.example/miss.png)}'
    expect(substituteCssAssets(css, () => null)).toBe(css)
  })

  it('水合时 urlFor 返回 null 则原样保留占位（不退化成 url("")）', () => {
    const css = `.a{background:url("${CSS_ASSET_SCHEME}gone")}`
    expect(hydrateCssTokens(css, () => null)).toBe(css)
  })
})

describe('escapeCssForMarkup', () => {
  it('把 < 写成 \\3c 并保留 content:"<" 的语义', () => {
    const out = escapeCssForMarkup('.a::before{content:"<"}')
    expect(out).toBe('.a::before{content:"\\3c "}')
    expect(out).not.toMatch(/</)
  })

  it('中和 </style>', () => {
    const out = escapeCssForMarkup('.a{content:"</style><script>alert(1)</script>"}')
    expect(out).not.toContain('</style>')
    expect(out).not.toContain('<script')
    expect(out).toContain('\\3c /style>')
  })

  it('data: URI 里的裸 < 也转义（DOMPurify 的探测不区分上下文）', () => {
    const out = escapeCssForMarkup(".a{background:url('data:image/svg+xml;utf8,<svg xmlns=\"x\"/>')}")
    expect(out).not.toMatch(/</)
    expect(out).toContain('utf8,\\3c svg')
  })

  it('已写成 \\< 的归一为 \\3c，不留裸 <', () => {
    expect(escapeCssForMarkup('.a{content:"\\<"}')).toBe('.a{content:"\\3c "}')
    // 偶数个反斜杠：最后一个反斜杠自身被转义，< 是裸的
    expect(escapeCssForMarkup('.a{content:"\\\\<"}')).toBe('.a{content:"\\\\\\3c "}')
  })

  it('不含 < 的样式表原样返回', () => {
    const css = '.a{color:red}\n@media print{.b{display:none}}'
    expect(escapeCssForMarkup(css)).toBe(css)
  })
})
