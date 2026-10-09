# 导出 PDF 用的中文字体子集

`NotoSerifSC-sub.ttf`:Noto Serif SC(思源宋体简体)Regular(wght=400)的子集,
给「导出 PDF」(`src/lib/paper/export/`)经 `pdf-lib` + `@pdf-lib/fontkit` 嵌入使用。
设计与取舍见仓库根 `PLAN-export-pdf-copilot-compose.md` 的 A.2。

## 实测(最终选择:Noto Serif SC,全部 GB2312 汉字,未触发任何退路)

| 项 | 值 |
|---|---|
| 字形数 | 7455(含 `.notdef`) |
| 原始体积 | 3,031,216 B(2.89 MB) |
| `gzip -9` | 1,824,162 B(1.74 MB),预算 ≤ 2.5 MB |
| 码点数 | 8026 = 拉丁/符号块 1263 + GB2312 汉字 6763 |
| 退路参考(`--level1`,仅一级汉字 3755) | 4447 字形 / 1.55 MB / 0.95 MB gz |

码点范围(`scripts/cjk-font-unicodes.py`):ASCII `0020-007E`、Latin-1 `00A0-00FF`、希腊 `0370-03FF`、
`2000-206F`、`2070-209F`、`2190-21FF`、`2200-22FF`、`25A0-25FF`(含 `□` 缺字占位)、`3000-303F`、
`FF00-FFEF`,加上 `4E00-9FFF` 内所有可用 GB2312 编码的汉字(6763)。
无 GSUB/GPOS/hinting,cmap 与字形 1:1,所以 `Σ advance × size / unitsPerEm` 即精确文本宽度。

## 来源

- 仓库:<https://github.com/google/fonts>,文件 `ofl/notoserifsc/NotoSerifSC[wght].ttf`
  (Google Fonts 的 **TrueType 变量字体**,glyf 轮廓;不用 CFF/CID 的 Source Han Serif,fontkit 对其子集化有已知缺陷)
- 该文件最后一次变更的提交:`2e61f4355afd22b801791b0df176065082423b87`(2024-08-19,
  "Noto Serif SC: Version 2.003-H1;hotconv 1.1.1;makeotfexe 2.6.0 added"),下载日期 2026-10-08
- 下载地址:`https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf`
  (25,125,512 B;SHA-256 `050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9`)
- 字体版权:`(c) 2017-2024 Adobe`(字体 name 表 ID 0),以 SIL OFL 1.1 授权,全文见同目录 `OFL.txt`
  (取自 google/fonts 同目录的 `OFL.txt`,原样未改;其首行版权声明为上游所写)。
  OFL 允许嵌入、再分发与修改,未声明保留字体名(RFN);本文件为其子集化衍生版,继续沿用 OFL 1.1 授权。

## 重新生成

```bash
# 1) 工具:fonttools + brotli(一次性,放哪都行)
python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli
# 2) 下载源字体到一个空目录(下载物视为不可信数据,别放进仓库)
mkdir -p /tmp/noto-src && curl -L -o /tmp/noto-src/NotoSerifSC.ttf \
  'https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf'
# 3) 生成(幂等,同一份源文件产物字节一致)
PATH=/tmp/ft/bin:$PATH scripts/build-cjk-font.sh /tmp/noto-src/NotoSerifSC.ttf
```

脚本做的事(详见 `scripts/build-cjk-font.sh`):

```bash
fonttools varLib.instancer <src> wght=400 --update-name-table -o <tmp>
pyftsubset <tmp> --output-file=src/assets/fonts/NotoSerifSC-sub.ttf --unicodes-file=<码点清单> \
  --no-hinting --layout-features='' \
  --drop-tables+=GSUB,GPOS,vhea,vmtx,VORG,BASE,JSTF,DSIG,meta,STAT --notdef-outline --recalc-bounds
# 再把 glyf 条目补齐到 4 字节(见下)
```

超预算的退路(依次):换 Noto Sans SC(`ofl/notosanssc/NotoSansSC[wght].ttf`)→
`scripts/build-cjk-font.sh --level1 …`(汉字只留 GB2312 一级 3755 字)。

## 重要:glyf 必须 4 字节对齐

`pyftsubset` 默认不给 glyf 条目补零(`padding=1`),大字体用长格式 loca 时字形长度多为奇数。
而 pdf-lib 的 fontkit 子集化是「按 loca 原样搬字形字节、写短格式 loca(偏移/2)」,奇数长度会让
偏移错位,嵌入字体里大量字形缺失——**pdf.js 取文本仍然全对**,只有看渲染(Preview / poppler)才发现。
`build-cjk-font.sh` 末尾用 fonttools 把 `glyf.padding` 设为 4 重写;
`src/lib/paper/export/cjkFont.spike.test.ts` 的「嵌入字体轮廓」一条专门防此回归。**别手工替换这个字体文件,
也别去掉补齐步骤。**

## 使用

```ts
import fontUrl from '../../../assets/fonts/NotoSerifSC-sub.ttf?url' // 自 src/lib/paper/export/;Vite 带内容哈希输出到 dist/assets/
```

构建后 `scripts/precompress.mjs` 为其生成 `.ttf.gz`(nginx `gzip_static`),`scripts/deploy.sh` 自检该 `.gz` 存在。
