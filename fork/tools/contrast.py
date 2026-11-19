#!/usr/bin/env python3
"""WCAG contrast of every text cell in a tui-drive capture (.ans), worst first.

usage: fork/tools/contrast.py <capture.ans> <terminal-bg hex> [terminal-fg hex] [--max RATIO] [--top N]

Cells drawn with the terminal's default colours are measured against the given
terminal background and foreground (default foreground: dark text on a light
background, light text on a dark one). Box-drawing and block characters are
skipped: they are borders and pixel art, not text. The SGR state carries over
line ends, as `tmux capture-pane -e` only writes changes.

Prints one row per (foreground, background, faint) pair: the ratio, the number
of cells, and the first cell (line and character). Test tooling only.
"""
import argparse
import re
from collections import defaultdict

SKIP = set("▀▄▌▐▗▖▝▘█▏─│┌┐└┘├┤┬┴┼╭╮╰╯")
TOKEN = re.compile(r"\x1b\[([0-9;:]*)m|\x1b\][^\x07]*\x07|\x1b_[^\x07]*\x07|\x1b\[[0-9;?]*[A-Za-z]|(.)", re.S)


def hex_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def luminance(rgb):
    def channel(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4

    r, g, b = map(channel, rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    hi, lo = sorted((luminance(a), luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("capture")
    parser.add_argument("bg")
    parser.add_argument("fg", nargs="?")
    parser.add_argument("--max", type=float, default=99, help="only rows below this ratio")
    parser.add_argument("--top", type=int, default=20)
    args = parser.parse_args()
    term_bg = hex_rgb(args.bg)
    term_fg = hex_rgb(args.fg) if args.fg else ((28, 31, 43) if luminance(term_bg) > 0.5 else (220, 222, 230))

    rows = defaultdict(lambda: [0, "", 99.0])
    fg = bg = None
    faint = False
    for number, line in enumerate(open(args.capture, encoding="utf-8").read().split("\n")):
        for match in TOKEN.finditer(line):
            if match.group(1) is not None:
                params = [int(x) if x else 0 for x in re.split("[;:]", match.group(1))] or [0]
                i = 0
                while i < len(params):
                    p = params[i]
                    if p == 0:
                        fg = bg = None
                        faint = False
                    elif p == 2:
                        faint = True
                    elif p == 22:
                        faint = False
                    elif p == 39:
                        fg = None
                    elif p == 49:
                        bg = None
                    elif p in (38, 48) and i + 4 < len(params) and params[i + 1] == 2:
                        colour = tuple(params[i + 2 : i + 5])
                        if p == 38:
                            fg = colour
                        else:
                            bg = colour
                        i += 4
                    i += 1
            elif match.group(2):
                char = match.group(2)
                if not char.strip() or char in SKIP:
                    continue
                cell_fg, cell_bg = fg or term_fg, bg or term_bg
                key = (cell_fg, cell_bg, faint)
                row = rows[key]
                row[0] += 1
                row[1] = row[1] or f"L{number}:{char}"
                row[2] = min(row[2], ratio(cell_fg, cell_bg))

    result = sorted(rows.items(), key=lambda item: item[1][2])
    for (cell_fg, cell_bg, cell_faint), (count, first, value) in result[: args.top]:
        if value >= args.max:
            break
        hex_fg = "%02x%02x%02x" % cell_fg
        hex_bg = "%02x%02x%02x" % cell_bg
        print(f"{value:5.2f}  fg #{hex_fg}  bg #{hex_bg}  faint={cell_faint}  cells={count}  {first}")


if __name__ == "__main__":
    main()
