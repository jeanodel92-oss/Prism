#!/usr/bin/env bash
# Repack a Prism release archive as an AppImage: the light one, which uses the host's WebKitGTK for the window and
# opens in the terminal without it.
#
# usage: fork/scripts/package-appimage.sh ARCHIVE OUT_DIR
#
#   ARCHIVE   prism-<version>-linux-x64.tar.gz, as fork/scripts/release.sh packs it
#   OUT_DIR   where prism-<version>-x86_64.AppImage is written, with its .zsync
#
# AppImage managers (Gear Lever, AppImageUpdate) update it from the update information it embeds: the fixed address
# of a .zsync that release.sh publishes as releases/LATEST-x86_64.AppImage.zsync, and that names the latest stable
# AppImage (relative to releases/) and its SHA-1, which the manager compares with the installed file
# .
# The image holds the archive's tree as is under usr/lib/prism, with the marker that makes Prism send its updates to
# the downloads page (src/fork/self-update.ts): the file is read-only once mounted. Canaries are not packaged.
#
# Needs curl, tar and sha256sum; no FUSE (appimagetool runs extracted).
#
# appimagetool and the type 2 runtime (which needs no libfuse2 on the host) are downloaded once into the release
# cache and checked against the hashes below, taken from the files the trial of 2026-11-21 used.
set -euo pipefail

APPIMAGETOOL_VERSION=1.9.1
APPIMAGETOOL_SHA256=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
RUNTIME_VERSION=20251108
RUNTIME_SHA256=2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/prism-release"
UPDATE_INFORMATION="zsync|https://prism.odelserver.space/releases/LATEST-x86_64.AppImage.zsync"

die() {
	echo "package-appimage: $*" >&2
	exit 1
}

# fetch URL FILE SHA256: downloads URL into the cache as FILE unless a copy with that hash is there.
fetch() {
	local file="$CACHE/$2"
	if [[ ! -f "$file" ]] || [[ "$(sha256sum "$file" | cut -d' ' -f1)" != "$3" ]]; then
		echo "package-appimage: downloading $2" >&2
		mkdir -p "$CACHE"
		curl -fsSL --proto '=https' -o "$file.part" "$1"
		mv "$file.part" "$file"
	fi
	[[ "$(sha256sum "$file" | cut -d' ' -f1)" == "$3" ]] || die "$file: checksum mismatch"
}

[[ $# -eq 2 ]] || die "usage: package-appimage.sh ARCHIVE OUT_DIR"
archive="$1"
out="$2"
[[ -f "$archive" ]] || die "$archive: no such file"
name="$(basename "$archive" .tar.gz)"
[[ "$name" =~ ^prism-(.+)-linux-x64$ ]] || die "$archive: not a prism-<version>-linux-x64.tar.gz"
version="${BASH_REMATCH[1]}"
[[ "$version" != *.canary.* ]] || die "$version: canaries are not packaged"
[[ "$version" =~ ^[0-9][0-9A-Za-z.-]*$ ]] || die "$version: unexpected version"

tool="appimagetool-$APPIMAGETOOL_VERSION-x86_64.AppImage"
runtime="appimage-runtime-$RUNTIME_VERSION-x86_64"
fetch "https://github.com/AppImage/appimagetool/releases/download/$APPIMAGETOOL_VERSION/appimagetool-x86_64.AppImage" \
	"$tool" "$APPIMAGETOOL_SHA256"
fetch "https://github.com/AppImage/type2-runtime/releases/download/$RUNTIME_VERSION/runtime-x86_64" \
	"$runtime" "$RUNTIME_SHA256"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
app="$work/AppDir"
mkdir -p "$app/usr/lib"
tar -xzf "$archive" -C "$work"
[[ -x "$work/$name/prism" ]] || die "$archive: no prism launcher at its root"
[[ -f "$work/$name/gui/prism.png" ]] || die "$archive: no window icon (gui/prism.png)"
mv "$work/$name" "$app/usr/lib/prism"
printf 'appimage\n' >"$app/usr/lib/prism/.prism-package"
cp "$app/usr/lib/prism/gui/prism.png" "$app/prism.png"
ln -s prism.png "$app/.DirIcon"
# The entry desktop integration tools (appimaged, Gear Lever…) install; the same as Prism's own menu entry
# (menuEntry in src/fork/launch-interface.ts).
cat >"$app/prism.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Prism
Comment=AI coding agent
Exec=prism --gui
Icon=prism
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=prism-gui
EOF
# The runtime unmounts the image as soon as AppRun ends, and `prism --gui` returns once the window is up: AppRun stays
# while a program started from the image runs (seen in the trial: the window stayed at "Starting the engine…").
# PRISM_LAUNCHER is the AppImage file, not the mount, whose path changes at each start: the window, the browser's
# native host and the phone link start Prism again by it.
cat >"$app/AppRun" <<'EOF'
#!/bin/sh
APPDIR=${APPDIR:-$(dirname "$(readlink -f "$0")")}
export APPDIR
PRISM_LAUNCHER=${APPIMAGE:-$APPDIR/AppRun}
export PRISM_LAUNCHER
# Double-clicked in a file manager (no argument, no terminal): open the window, not a terminal interface nobody
# sees (audit REL-13).
if [ $# -eq 0 ] && ! [ -t 0 ] && ! [ -t 1 ]; then set -- --gui; fi
"$APPDIR/usr/lib/prism/node/bin/node" "$APPDIR/usr/lib/prism/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"
status=$?
while ls -l /proc/[0-9]*/exe 2>/dev/null | grep -qF " $APPDIR/"; do sleep 1; done
exit $status
EOF
chmod +x "$app/AppRun"

mkdir -p "$out"
out="$(cd "$out" && pwd)"
target="$out/prism-$version-x86_64.AppImage"
cp "$CACHE/$tool" "$work/appimagetool"
chmod +x "$work/appimagetool"
(cd "$work" && ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 ./appimagetool --appimage-extract-and-run \
	--runtime-file "$CACHE/$runtime" --no-appstream --updateinformation "$UPDATE_INFORMATION" \
	--file-url "$version/prism-$version-x86_64.AppImage" "$app" "$target") >&2 ||
	die "appimagetool failed"
# appimagetool writes the .zsync in its working directory.
mv "$work/$(basename "$target").zsync" "$target.zsync" 2>/dev/null || [[ -f "$target.zsync" ]] ||
	die "appimagetool wrote no $(basename "$target").zsync: $(ls "$work" | tr '\n' ' ')"
[[ "$(APPIMAGE_EXTRACT_AND_RUN=1 "$target" --version)" == "$version" ]] ||
	die "the AppImage does not report version $version"
echo "$target"
