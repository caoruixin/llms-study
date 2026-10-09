#!/usr/bin/env bash
# 生成导出 PDF 用的中文字体子集 src/assets/fonts/NotoSerifSC-sub.ttf。
#
# 用法:
#   scripts/build-cjk-font.sh [--level1] <源 TTF> [输出 TTF]
#     源 TTF   Google Fonts 的 TrueType 变量字体(glyf 轮廓,不能是 CFF/OTF):
#              https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf
#              (超预算时退路:ofl/notosanssc/NotoSansSC[wght].ttf)
#     输出     默认 src/assets/fonts/NotoSerifSC-sub.ttf
#     --level1 汉字只留 GB2312 一级(3755 字)而非全部 6763 字,第二退路
#
# 依赖:PATH 里有 fonttools(`fonttools`、`pyftsubset`)+ brotli,例如
#   python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli
#   PATH=/tmp/ft/bin:$PATH scripts/build-cjk-font.sh <源 TTF>
#
# 幂等:同一份源文件重复运行产物字节一致;临时文件在 mktemp 目录里,退出即清。
# 步骤:实例化 wght=400 → 按码点清单子集化(去 hinting 与全部布局表,使 cmap 与字形 1:1,
# pdf-lib/fontkit 的子集化与宽度计算才不会被 GSUB/GPOS 干扰)→ glyf 条目 4 字节补齐。
set -euo pipefail

cd "$(dirname "$0")/.."

LEVEL1=()
if [[ "${1:-}" == "--level1" ]]; then LEVEL1=(--level1); shift; fi
SRC="${1:?用法: scripts/build-cjk-font.sh [--level1] <源 TTF> [输出 TTF]}"
OUT="${2:-src/assets/fonts/NotoSerifSC-sub.ttf}"

[[ -f "$SRC" ]] || { echo "FATAL: 找不到源字体 $SRC" >&2; exit 1; }
for bin in fonttools pyftsubset python3; do
  command -v "$bin" >/dev/null || { echo "FATAL: PATH 里没有 $bin(见脚本头部依赖说明)" >&2; exit 1; }
done
python3 -I -c 'import fontTools' 2>/dev/null || { echo "FATAL: python3 没装 fonttools(应与 PATH 里的 fonttools 同一个环境)" >&2; exit 1; }

# 固定 head.modified,保证重复运行字节一致(fonttools 认 SOURCE_DATE_EPOCH;默认取源字体入库日期)
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1724068995}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 1) 码点清单(-I:忽略当前目录与环境,只跑脚本本身)
python3 -I scripts/cjk-font-unicodes.py ${LEVEL1[@]+"${LEVEL1[@]}"} > "$TMP/unicodes.txt"

# 2) 变量字体 → wght=400 静态实例(源文件 wght 轴 200–900,默认 200,必须显式取 400)
#    --update-name-table:否则 PostScript 名仍是 NotoSerifSC-ExtraLight,会写进 PDF 的 /BaseFont
fonttools varLib.instancer "$SRC" wght=400 --update-name-table -o "$TMP/instance.ttf"

# 3) 子集化
mkdir -p "$(dirname "$OUT")"
pyftsubset "$TMP/instance.ttf" \
  --output-file="$OUT" \
  --unicodes-file="$TMP/unicodes.txt" \
  --no-hinting \
  --layout-features='' \
  --drop-tables+=GSUB,GPOS,vhea,vmtx,VORG,BASE,JSTF,DSIG,meta,STAT \
  --notdef-outline \
  --recalc-bounds

# 4) glyf 条目补齐到 4 字节对齐。pyftsubset 默认不补(padding=1),产物里字形长度多为奇数;
#    而 pdf-lib 的 fontkit 子集化是「按 loca 原样搬字形字节 + 写短格式 loca(偏移/2)」,
#    奇数长度会让偏移错位 → 嵌入字体里大量字形轮廓残缺/缺失(pdf.js 取文本仍正常,肉眼才看得出)。
#    cjkFont.spike.test.ts 会校验嵌入字形轮廓,别删这一步。
python3 -I - "$OUT" <<'PY'
import sys
from fontTools.ttLib import TTFont
f = TTFont(sys.argv[1])
f['glyf'].padding = 4
f.save(sys.argv[1])
PY

# 5) 报告
GLYPHS=$(python3 -I - "$OUT" <<'PY'
import sys
from fontTools.ttLib import TTFont
print(len(TTFont(sys.argv[1]).getGlyphOrder()))
PY
)
RAW=$(wc -c < "$OUT" | tr -d ' ')
GZ=$(gzip -9 -n -c "$OUT" | wc -c | tr -d ' ')
echo "输出:$OUT"
echo "字形数:$GLYPHS"
echo "原始:$RAW 字节($(awk -v n="$RAW" 'BEGIN{printf "%.2f", n/1048576}') MB)"
echo "gzip -9:$GZ 字节($(awk -v n="$GZ" 'BEGIN{printf "%.2f", n/1048576}') MB),预算 ≤ 2.5 MB"
if (( GZ > 2621440 )); then
  echo "WARN: 超出 2.5 MB gz 预算,按 A.2 退路:Noto Sans SC → --level1" >&2
fi
