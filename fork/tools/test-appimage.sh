#!/usr/bin/env bash
# Acceptance check for the AppImage of a stable release (built by fork/scripts/release.sh with fork/scripts/package-appimage.sh)
# in Fedora 44, Debian 13 and Ubuntu 24.04
# containers, with /dev/fuse and without libfuse2,
#   1. `--version` through the FUSE mount, as a user;
#   2. `prism update` and `prism update --rollback` refuse and send to the downloads page;
#   3. without WebKitGTK: `prism --gui` says the window cannot open and that Prism opens in the terminal;
#   4. with WebKitGTK, under Xvfb and a D-Bus session: `prism --gui` opens the window, and 15 s later its engine runs,
#      started again from the AppImage file (PRISM_LAUNCHER), and the first mount is still there.
#   5. first, on the host: the update information AppImage managers read (Gear Lever, AppImageUpdate), and the
#      .zsync it names (releases/LATEST-x86_64.AppImage.zsync).
# A capture of the window is left in <release-out-dir>/appimage-<distro>.xwd for a look.
# Not covered: a real desktop (Wayland, GPU), desktop integration tools themselves (appimaged, Gear Lever).
#
# usage: fork/tools/test-appimage.sh <release-out-dir>
#
# Needs podman and /dev/fuse. Pulls the three images on first use.
set -euo pipefail

[[ $# -eq 1 ]] || {
	echo "usage: test-appimage.sh <release-out-dir>" >&2
	exit 2
}
rel="$(cd "$1" && pwd)"
version="$(head -n1 "$rel/releases/LATEST")"
image_file="$rel/releases/$version/prism-$version-x86_64.AppImage"
[[ -f "$image_file" ]] || {
	echo "FAIL: no $image_file" >&2
	exit 1
}

# Updates by AppImage managers, read as Gear Lever reads them (readelf on .upd_info, then the .zsync's URL and SHA-1
# headers): the embedded address is the fixed pointer, which names this AppImage and its SHA-1.
fail() { echo "FAIL: $*" >&2; exit 1; }
pointer="https://prism.odelserver.space/releases/LATEST-x86_64.AppImage.zsync"
embedded="$(readelf --string-dump=.upd_info --wide "$image_file" | sed -n 's/^ *\[ *[0-9]*\] *//p')"
[[ "$embedded" == "zsync|$pointer" ]] || fail "update information: '$embedded'"
zsync="$rel/releases/LATEST-x86_64.AppImage.zsync"
[[ -f "$zsync" ]] || fail "no $zsync"
header="$(sed '/^$/q' "$zsync")"
[[ "$(sed -n 's/^URL: //p' <<<"$header")" == "$version/prism-$version-x86_64.AppImage" ]] ||
	fail "the .zsync names another file: $(grep '^URL:' <<<"$header")"
[[ "$(sed -n 's/^SHA-1: //p' <<<"$header")" == "$(sha1sum "$image_file" | cut -d' ' -f1)" ]] ||
	fail "the .zsync's SHA-1 is not this AppImage's"
echo "ok: update information for AppImage managers ($pointer, naming this AppImage and its SHA-1)"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
cat >"$work/inside.sh" <<'EOF'
#!/bin/bash
# Inside the container, as root: $1 dnf|apt, $2 the version.
set -eu
kind=$1 version=$2
fail() { echo "FAIL: $*"; exit 1; }
if [ "$kind" = apt ]; then
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq >/dev/null
	add() { apt-get install -y -qq --no-install-recommends "$@" >/dev/null; }
	add fuse3 procps xvfb xauth dbus x11-apps fonts-dejavu-core
	webkit=libwebkit2gtk-4.1-0
else
	add() { dnf install -y -q "$@" >/dev/null 2>&1; }
	add fuse3 procps-ng util-linux xorg-x11-server-Xvfb dbus-daemon dbus-tools xwd dejavu-sans-fonts
	webkit=webkit2gtk4.1
fi
! ls /usr/lib*/libfuse.so.2 /usr/lib/x86_64-linux-gnu/libfuse.so.2 >/dev/null 2>&1 || fail "libfuse2 is installed"
useradd -m tester
install -m 755 /image/p.AppImage /home/tester/p.AppImage
mkdir -p /home/tester/proj && chown -R tester /home/tester
as() { su tester -c "cd ~/proj && $1" 2>&1; }

[ "$(as '~/p.AppImage --version')" = "$version" ] || fail "--version: $(as '~/p.AppImage --version')"
echo "ok: --version through FUSE, without libfuse2"
for args in update "update --rollback"; do
	if out=$(as "~/p.AppImage $args"); then fail "prism $args succeeded: $out"; fi
	case $out in *"is an AppImage"*"/downloads/"*) ;; *) fail "prism $args: $out" ;; esac
done
echo "ok: prism update sends to the downloads page"

# Xvfb in its own subshell: one left in the background would hold the output that $(…) waits for.
xvfb() { as "(Xvfb :7 -screen 0 1280x800x24 >/dev/null 2>&1 &); sleep 2; export DISPLAY=:7 XDG_RUNTIME_DIR=/tmp/xdg; mkdir -p -m 700 /tmp/xdg; $1"; }
out=$(xvfb 'timeout 60 ~/p.AppImage --gui </dev/null' || true)
case $out in *"Prism opens in the terminal"*) ;; *) fail "--gui without WebKitGTK: $out" ;; esac
echo "ok: without WebKitGTK, --gui falls back to the terminal"

add $webkit
pkill Xvfb || true
xvfb 'dbus-run-session -- sh -c "(~/p.AppImage --gui >~/gui.out 2>&1 &) ; sleep 15
	ps -eo args >~/ps.txt; grep -c \" /tmp/.mount_p.AppI\" /proc/mounts >~/mounts.txt; xwd -root -silent >/tmp/shot.xwd"' >/dev/null || true
[ "$(cat /home/tester/mounts.txt)" -ge 2 ] || fail "the window's mount is gone: $(cat /home/tester/ps.txt)"
grep -q "/tmp/.mount_p.AppI[^/]*/usr/lib/prism/gui/prism-gui" /home/tester/ps.txt || fail "no window: $(cat /home/tester/gui.out)"
# The engine: a second runtime, started from the file, not from the first mount.
[ "$(grep -c '^/home/tester/p.AppImage' /home/tester/ps.txt)" -ge 2 ] || fail "the engine was not started from the AppImage: $(cat /home/tester/ps.txt)"
echo "ok: the window opens, its engine runs from the AppImage file, the mounts stay"
cp /tmp/shot.xwd /out/shot.xwd
EOF

status=0
for spec in "registry.fedoraproject.org/fedora:44 dnf fedora" "docker.io/library/debian:trixie-slim apt debian" \
	"docker.io/library/ubuntu:24.04 apt ubuntu"; do
	read -r image kind distro <<<"$spec"
	echo "== $image"
	mkdir -p "$work/out-$distro"
	podman run --rm --memory 3g --device /dev/fuse --cap-add SYS_ADMIN -v "$image_file:/image/p.AppImage:ro,Z" \
		-v "$work/inside.sh:/inside.sh:ro,Z" -v "$work/out-$distro:/out:Z" "$image" \
		bash /inside.sh "$kind" "$version" || status=1
	[[ ! -f "$work/out-$distro/shot.xwd" ]] || cp "$work/out-$distro/shot.xwd" "$rel/appimage-$distro.xwd"
done
[[ $status -eq 0 ]] && echo "all AppImage checks passed" || echo "FAIL: see above" >&2
exit $status
