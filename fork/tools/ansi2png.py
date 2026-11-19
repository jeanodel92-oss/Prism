#!/usr/bin/env python3
"""Render a tmux `capture-pane -e -p` dump to PNG via headless Chrome (test tooling only)."""
import html
import unicodedata
import os
import re
import subprocess
import sys

PALETTE16 = [
    "#000000", "#cc0403", "#19cb00", "#cecb00", "#0d73cc", "#cb1ed1", "#0dcdcd", "#dddddd",
    "#767676", "#f2201f", "#23fd00", "#fffd00", "#1a8fff", "#fd28ff", "#14ffff", "#ffffff",
]


def c256(n):
    if n < 16:
        return PALETTE16[n]
    if n < 232:
        n -= 16
        r, g, b = n // 36, (n // 6) % 6, n % 6
        conv = lambda v: 0 if v == 0 else 55 + v * 40
        return "#%02x%02x%02x" % (conv(r), conv(g), conv(b))
    v = 8 + (n - 232) * 10
    return "#%02x%02x%02x" % (v, v, v)


SGR = re.compile(r"\x1b\[([0-9;:]*)m")
OTHER = re.compile(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[\[\(][0-9;?]*[A-Za-ln-z]")


def parse_line(line, st):
    out = []
    pos = 0
    line = OTHER.sub("", line)
    for m in SGR.finditer(line):
        if m.start() > pos:
            out.append((dict(st), line[pos:m.start()]))
        params = [p for p in re.split(r"[;:]", m.group(1))] if m.group(1) else ["0"]
        i = 0
        while i < len(params):
            p = int(params[i] or 0)
            if p == 0:
                st.clear()
            elif p == 1:
                st["b"] = True
            elif p == 2:
                st["dim"] = True
            elif p == 3:
                st["i"] = True
            elif p == 4:
                st["u"] = True
            elif p == 7:
                st["rev"] = True
            elif p == 9:
                st["s"] = True
            elif p == 22:
                st.pop("b", None); st.pop("dim", None)
            elif p == 23:
                st.pop("i", None)
            elif p == 24:
                st.pop("u", None)
            elif p == 27:
                st.pop("rev", None)
            elif p == 29:
                st.pop("s", None)
            elif 30 <= p <= 37:
                st["fg"] = PALETTE16[p - 30]
            elif 90 <= p <= 97:
                st["fg"] = PALETTE16[p - 90 + 8]
            elif 40 <= p <= 47:
                st["bg"] = PALETTE16[p - 40]
            elif 100 <= p <= 107:
                st["bg"] = PALETTE16[p - 100 + 8]
            elif p == 39:
                st.pop("fg", None)
            elif p == 49:
                st.pop("bg", None)
            elif p in (38, 48):
                key = "fg" if p == 38 else "bg"
                mode = int(params[i + 1] or 0) if i + 1 < len(params) else 0
                if mode == 2:
                    r, g, b = (int(x or 0) for x in params[i + 2:i + 5])
                    st[key] = "#%02x%02x%02x" % (r, g, b)
                    i += 4
                elif mode == 5:
                    st[key] = c256(int(params[i + 2] or 0))
                    i += 2
            i += 1
        pos = m.end()
    if pos < len(line):
        out.append((dict(st), line[pos:]))
    return out


# Terminal default colours; ANSI2PNG_BG/ANSI2PNG_FG emulate a light terminal.
DEFAULT_BG = os.environ.get("ANSI2PNG_BG", "#000000")
DEFAULT_FG = os.environ.get("ANSI2PNG_FG", "#dddddd")


def span(st, text):
    fg = st.get("fg", DEFAULT_FG)
    bg = st.get("bg")
    if st.get("rev"):
        fg, bg = (bg or DEFAULT_BG), fg
    css = [f"color:{fg}"]
    if bg:
        css.append(f"background:{bg}")
    if st.get("b"):
        css.append("font-weight:bold")
    if st.get("i"):
        css.append("font-style:italic")
    if st.get("dim"):
        css.append("opacity:.55")
    deco = []
    if st.get("u"):
        deco.append("underline")
    if st.get("s"):
        deco.append("line-through")
    if deco:
        css.append("text-decoration:" + " ".join(deco))
    return f'<span style="{";".join(css)}">{cells(text)}</span>'


def cells(text):
    """Pin each glyph to the terminal grid: bold faces and fallback fonts draw some
    glyphs wider or narrower than one cell, which shifts the rest of the row (a real
    terminal keeps the grid)."""
    out = []
    for ch in text:
        if ch == " ":
            out.append(ch)
            continue
        w = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        out.append(f'<span class="c" style="width:{w}ch">{html.escape(ch)}</span>')
    return "".join(out)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    cols = int(sys.argv[3]) if len(sys.argv) > 3 else 140
    raw = open(src, encoding="utf-8", errors="replace").read().rstrip("\n").split("\n")
    st = {}
    rows = []
    for line in raw:
        rows.append("".join(span(s, t) for s, t in parse_line(line, st)))
    font = os.environ.get("ANSI2PNG_FONT", "FantasqueSansM Nerd Font Mono")
    doc = f"""<!doctype html><html><head><meta charset="utf-8"><style>
body{{margin:0;background:{DEFAULT_BG};}}
pre{{margin:0;padding:14px 16px;font-family:'{font}',monospace;font-size:15px;line-height:19px;color:{DEFAULT_FG};white-space:pre;}}
.l{{height:19px;overflow:hidden}}
.l span{{display:inline-block;height:19px;vertical-align:top;white-space:pre}}
.l span.c{{text-align:center}}
</style></head><body><pre>{''.join(f'<div class="l">{r}</div>' for r in rows)}</pre></body></html>"""
    dst = os.path.abspath(dst)
    htmlpath = dst + ".html"
    open(htmlpath, "w", encoding="utf-8").write(doc)
    width = int(cols * 8.0) + 40
    height = max(620, len(rows) * 19 + 30)
    chrome = os.environ.get("CHROME") or find_chrome()
    subprocess.run(
        [chrome, "--headless", "--disable-gpu", "--hide-scrollbars", f"--window-size={width},{height}",
         f"--screenshot={dst}", "file://" + htmlpath],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def find_chrome():
    """chrome-headless-shell from `npx playwright install chromium-headless-shell`, else a system Chrome."""
    import glob
    import shutil
    hits = sorted(glob.glob(os.path.expanduser(
        "~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell")))
    if hits:
        return hits[-1]
    for name in ("chrome-headless-shell", "chromium", "chromium-browser", "google-chrome"):
        path = shutil.which(name)
        if path:
            return path
    sys.exit("ansi2png: no Chrome found (set CHROME=/path/to/chrome)")


if __name__ == "__main__":
    main()
