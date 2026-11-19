#!/usr/bin/env bash
# Builds the window: ./build.sh [--debug | --drive | --package]. Output: src-tauri/target/{release,debug}/prism-gui.
# --drive builds the test variant with the scripted driver into src-tauri/target-drive/release/.
# --package builds the release's window (fork/scripts/release.sh) into src-tauri/target-package/release/, apart
# from the build a developer runs.
#
# Linking needs the WebKitGTK 4.1 development files (Fedora: webkit2gtk4.1-devel; Debian/Ubuntu:
# libwebkit2gtk-4.1-dev). When they are not installed, this script downloads the Fedora -devel RPMs
# into a cache and links against them without installing anything (no root, the system is unchanged).
# The built binary needs only the runtime libraries (webkit2gtk4.1), present on a GNOME/KDE desktop.
set -euo pipefail

GUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE=release
[[ "${1:-}" == "--debug" ]] && PROFILE=debug
[[ "${1:-}" == "--drive" ]] && PROFILE=drive
[[ "${1:-}" == "--package" ]] && PROFILE=package

"$GUI/scripts/prepare.sh"

if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
	SYSROOT="${PRISM_GUI_SYSROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/prism-gui/webkit-devel}"
	if [[ ! -f "$SYSROOT/usr/lib64/pkgconfig/webkit2gtk-4.1.pc" ]]; then
		command -v dnf >/dev/null || {
			echo "build: install the WebKitGTK 4.1 development package (libwebkit2gtk-4.1-dev)" >&2
			exit 1
		}
		mkdir -p "$SYSROOT/rpms"
		(cd "$SYSROOT/rpms" && dnf download --arch x86_64 webkit2gtk4.1-devel javascriptcoregtk4.1-devel libsoup3-devel)
		for rpm in "$SYSROOT"/rpms/*.rpm; do (cd "$SYSROOT" && rpm2cpio "$rpm" | cpio -idm --quiet); done
		# The -devel symlinks are relative; point them at the installed runtime libraries.
		for link in "$SYSROOT"/usr/lib64/*.so; do
			ln -sfn "/usr/lib64/$(readlink "$link")" "$link"
		done
	fi
	export PKG_CONFIG_PATH="$SYSROOT/usr/lib64/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
	export RUSTFLAGS="${RUSTFLAGS:-} -L native=$SYSROOT/usr/lib64"
fi

cd "$GUI/src-tauri"
case "$PROFILE" in
	release) cargo build --release && echo "build: $GUI/src-tauri/target/release/prism-gui" ;;
	debug) cargo build && echo "build: $GUI/src-tauri/target/debug/prism-gui" ;;
	drive)
		cargo build --release --features drive --target-dir target-drive
		echo "build: $GUI/src-tauri/target-drive/release/prism-gui"
		;;
	package)
		# custom-protocol: Tauri's production mode (what `tauri build` turns on). Without it Tauri counts the build as
		# dev and embeds this crate's folder (config_parent), the build machine's home in a published binary (public
		# site audit SP-05). With no devUrl and no devCsp, nothing else of the window changes.
		cargo build --release --locked --target-dir target-package --features tauri/custom-protocol
		echo "build: $GUI/src-tauri/target-package/release/prism-gui"
		;;
esac
