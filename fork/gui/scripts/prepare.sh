#!/usr/bin/env bash
# Copies what the window needs but this repository does not own into gitignored folders:
# - marked 18.0.11 (lib/marked.esm.js), for the Markdown lexer, and pi-tui's fuzzy matcher (packages/tui/src/fuzzy.ts,
#   its types stripped by Node, which needs 22.13 or later): neither from node_modules, so that the phone app builds
#   from a fresh checkout without the repo's npm install; marked is the version
#   packages/tui pins, checked below;
# - mermaid 12.2.0 (dist/mermaid.min.js and its MIT licence), for the conversation's diagrams: the npm
#   tarball, checked against the registry's integrity below, downloaded once into the cache
#   (XDG_CACHE_HOME/prism-gui). Not a dependency of the repo: only the window uses it;
# - KaTeX 0.19.1 (dist/katex.min.js, dist/katex.min.css, its woff2 fonts and its MIT licence), for the math in the
#   conversation: the npm tarball, cached and checked as mermaid's. The stylesheet is trimmed to
#   the woff2 fonts, which the window's WebKit reads (it would fetch only those anyway);
# - the optical scene of the Prism site (optics.js and two stills) from its copy versioned in fork/gui/site
#
#   ;
# The window icon is versioned, no longer
# drawn here: ImageMagick and rsvg-convert render its edges differently (0.6 % RMSE), and Tauri builds the icon into
# the phone app, whose APK then depended on which tool the machine had. After changing
# icon.svg, draw it again with Fedora's ImageMagick (librsvg inside; Debian's cannot draw its gradient mask), without
# its dates:
#   magick -background none -density 1024 fork/gui/icon.svg -resize 512x512 -strip PNG32:fork/gui/src-tauri/icons/icon.png
set -euo pipefail

GUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$GUI/../.." && pwd)"
SITE="$GUI/site"

mkdir -p "$GUI/ui/vendor" "$GUI/ui/site" "$GUI/src-tauri/icons"

cache="${XDG_CACHE_HOME:-$HOME/.cache}/prism-gui"

MARKED_VERSION=18.0.11
MARKED_SHA256=cef55476c7551e73e1a89118fa69fee9f7eef9960e9c774ad266e22ee966b994 # sha512-HnslJfsZkRPBDJRH… on the registry
pinned="$(sed -n 's/^[[:space:]]*"marked": "\(.*\)",\{0,1\}$/\1/p' "$ROOT/packages/tui/package.json")"
if [[ "$pinned" != "$MARKED_VERSION" ]]; then
	echo "prepare: packages/tui pins marked $pinned, this script $MARKED_VERSION; update MARKED_VERSION and MARKED_SHA256" >&2
	exit 1
fi
tarball="$cache/marked-$MARKED_VERSION.tgz"
if [[ ! -f "$tarball" ]] || ! echo "$MARKED_SHA256  $tarball" | sha256sum -c --status; then
	mkdir -p "$cache"
	curl -fsSL "https://registry.npmjs.org/marked/-/marked-$MARKED_VERSION.tgz" -o "$tarball.part"
	if ! echo "$MARKED_SHA256  $tarball.part" | sha256sum -c --status; then
		rm -f "$tarball.part"
		echo "prepare: marked $MARKED_VERSION does not match its checksum; nothing copied" >&2
		exit 1
	fi
	mv "$tarball.part" "$tarball"
fi
tar -xzf "$tarball" -O package/lib/marked.esm.js >"$GUI/ui/vendor/marked.esm.js"
node --disable-warning=ExperimentalWarning -e 'const { stripTypeScriptTypes } = require("node:module"); const fs = require("node:fs");
	fs.writeFileSync(process.argv[2], stripTypeScriptTypes(fs.readFileSync(process.argv[1], "utf8")));' \
	"$ROOT/packages/tui/src/fuzzy.ts" "$GUI/ui/vendor/fuzzy.js"

MERMAID_VERSION=12.2.0
MERMAID_SHA256=071914164d0f6d53e5c26a10a220230d4ae8d37ed0f2263fbf072266f0af3a0a # sha512-w7nr/SFrLO7B… on the registry
tarball="$cache/mermaid-$MERMAID_VERSION.tgz"
if [[ ! -f "$tarball" ]] || ! echo "$MERMAID_SHA256  $tarball" | sha256sum -c --status; then
	mkdir -p "$cache"
	curl -fsSL "https://registry.npmjs.org/mermaid/-/mermaid-$MERMAID_VERSION.tgz" -o "$tarball.part"
	if ! echo "$MERMAID_SHA256  $tarball.part" | sha256sum -c --status; then
		rm -f "$tarball.part"
		echo "prepare: mermaid $MERMAID_VERSION does not match its checksum; nothing copied" >&2
		exit 1
	fi
	mv "$tarball.part" "$tarball"
fi
tar -xzf "$tarball" -O package/dist/mermaid.min.js >"$GUI/ui/vendor/mermaid.min.js"
tar -xzf "$tarball" -O package/LICENSE >"$GUI/ui/vendor/mermaid.LICENSE"

KATEX_VERSION=0.19.1
KATEX_SHA256=24da5a599eb2fcede2e270b99a6ff48bca816beecc95feeb84e8cccbd1bb34fd # sha512-jG8uKntjSEcm… on the registry
tarball="$cache/katex-$KATEX_VERSION.tgz"
if [[ ! -f "$tarball" ]] || ! echo "$KATEX_SHA256  $tarball" | sha256sum -c --status; then
	mkdir -p "$cache"
	curl -fsSL "https://registry.npmjs.org/katex/-/katex-$KATEX_VERSION.tgz" -o "$tarball.part"
	if ! echo "$KATEX_SHA256  $tarball.part" | sha256sum -c --status; then
		rm -f "$tarball.part"
		echo "prepare: katex $KATEX_VERSION does not match its checksum; nothing copied" >&2
		exit 1
	fi
	mv "$tarball.part" "$tarball"
fi
katex="$GUI/ui/vendor/katex"
rm -rf "$katex"
mkdir -p "$katex/fonts"
tar -xzf "$tarball" -O package/dist/katex.min.js >"$katex/katex.min.js"
tar -xzf "$tarball" -O package/LICENSE >"$GUI/ui/vendor/katex.LICENSE"
tar -xzf "$tarball" -C "$katex/fonts" --strip-components=3 --wildcards 'package/dist/fonts/*.woff2'
# Each font as `src:url(fonts/X.woff2) format("woff2"),url(fonts/X.woff) format("woff"),url(fonts/X.ttf) format(…)`:
# only the first stays. Checked: no other format is left, and every font named is there.
tar -xzf "$tarball" -O package/dist/katex.min.css |
	sed -E 's/,url\(fonts\/[A-Za-z0-9_-]+\.woff\) format\("woff"\),url\(fonts\/[A-Za-z0-9_-]+\.ttf\) format\("truetype"\)//g' >"$katex/katex.min.css"
if grep -qE '\.(woff|ttf)\)' "$katex/katex.min.css"; then
	echo "prepare: katex.min.css still names fonts other than woff2; its format changed" >&2
	exit 1
fi
for font in $(grep -oE 'fonts/[A-Za-z0-9_-]+\.woff2' "$katex/katex.min.css" | sort -u); do
	[[ -f "$katex/$font" ]] || { echo "prepare: katex.min.css names $font, not in the tarball" >&2; exit 1; }
done

cp "$SITE/optics.js" "$SITE/still-1.webp" "$SITE/still-4.webp" "$GUI/ui/site/"
