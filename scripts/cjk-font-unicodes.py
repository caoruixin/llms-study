#!/usr/bin/env python3
"""输出中文字体子集的码点清单,供 pyftsubset --unicodes-file= 使用。

每行一个 `U+XXXX` 或 `U+XXXX-YYYY`(pyftsubset 原生格式);连续码点已合并成区间。
用法:
  python3 scripts/cjk-font-unicodes.py            # 全部 GB2312 汉字(6763)
  python3 scripts/cjk-font-unicodes.py --level1   # 仅 GB2312 一级汉字(3755,行 16–55)
  python3 scripts/cjk-font-unicodes.py --count    # 只打印总码点数(stderr 同样会给出)

范围依据 PLAN-export-pdf-copilot-compose.md A.2:
  拉丁/符号块 + 3000-303F(CJK 标点)+ FF00-FFEF(全角形式)+ GB2312 汉字。
  25A0-25FF 含 □(U+25A1),导出时缺字统一回退成它。
"""
import sys

# 固定块(闭区间)
BLOCKS = [
    (0x0020, 0x007E),  # ASCII 可打印
    (0x00A0, 0x00FF),  # Latin-1 补充
    (0x0370, 0x03FF),  # 希腊(论文公式里常见 α β γ…)
    (0x2000, 0x206F),  # 常用标点:“ ” ‘ ’ — … 等
    (0x2070, 0x209F),  # 上下标
    (0x2190, 0x21FF),  # 箭头
    (0x2200, 0x22FF),  # 数学运算符
    (0x25A0, 0x25FF),  # 几何图形(含 □ 缺字占位)
    (0x3000, 0x303F),  # CJK 标点:、。《》「」 等
    (0xFF00, 0xFFEF),  # 全角形式:，；：？！（） 等
]


def gb2312_hanzi(level1_only: bool):
    """4E00-9FFF 内可用 GB2312 编码的汉字。一级 = 区 16–55(首字节 0xB0–0xD7)。"""
    out = []
    for cp in range(0x4E00, 0xA000):
        try:
            b = chr(cp).encode('gb2312')
        except UnicodeEncodeError:
            continue
        if len(b) != 2:
            continue
        if level1_only and b[0] > 0xD7:
            continue
        out.append(cp)
    return out


def merge(cps):
    """排序去重后合并为 (lo, hi) 区间。"""
    cps = sorted(set(cps))
    ranges = []
    for cp in cps:
        if ranges and cp == ranges[-1][1] + 1:
            ranges[-1][1] = cp
        else:
            ranges.append([cp, cp])
    return ranges


def main(argv):
    level1 = '--level1' in argv
    cps = []
    for lo, hi in BLOCKS:
        cps.extend(range(lo, hi + 1))
    hanzi = gb2312_hanzi(level1)
    expected = 3755 if level1 else 6763
    if len(hanzi) != expected:
        sys.exit(f'GB2312 汉字数 {len(hanzi)} != {expected},Python 的 gb2312 codec 异常')
    cps.extend(hanzi)
    ranges = merge(cps)
    total = sum(hi - lo + 1 for lo, hi in ranges)
    if '--count' in argv:
        print(total)
        return
    for lo, hi in ranges:
        print(f'U+{lo:04X}' if lo == hi else f'U+{lo:04X}-{hi:04X}')
    print(f'码点总数 {total}(其中 GB2312 汉字 {len(hanzi)})', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1:])
