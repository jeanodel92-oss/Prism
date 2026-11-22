#!/usr/bin/env bash
# Build a signed Prism release for linux-x64, ready to serve from
# https://prism.odelserver.space.
#
# usage: fork/scripts/release.sh --out DIR [--fork-number N] [--maintenance P | --canary M [--unsigned]] [--key PATH]
#                               [--apk-key PATH] [--skip-build]
#
#   --out DIR             output directory, laid out like the site:
#                           DIR/install.sh
#                           DIR/releases/LATEST (LATEST-canary for a canary)
#                           DIR/releases/<version>/prism-<version>-linux-x64.tar.gz
#                           DIR/releases/<version>/NOTES.md
#                           DIR/releases/<version>/prism-<version>-android-arm64.apk (stable only)
#                           DIR/releases/android/prism-android-arm64.apk (the latest stable APK)
#                           DIR/releases/<version>/prism-{firefox,chromium}-<x.y.z>.zip (stable only)
#                           DIR/releases/<version>/prism_<v>-1_amd64.deb, prism-<v>-1.x86_64.rpm (stable only;
#                           <v> is the version with "+" for "-", fork/scripts/package-linux.sh)
#                           DIR/releases/<version>/prism-<version>-x86_64.AppImage (stable only;
#                           fork/scripts/package-appimage.sh)
#                           DIR/releases/LATEST-x86_64.AppImage.zsync (the latest stable AppImage, for
#                           AppImage managers; stable only)
#                           DIR/releases/<version>/SHA256SUMS (+ .minisig)
#   --fork-number N       version suffix, <upstream>-fork.N (default 1)
#   --maintenance P       a stable maintenance release of fork.N, <upstream>-fork.N.P: the P-th
#                         set of fixes for N. Same channel, notes and signature as a stable
#                         release; it sorts after N and its earlier maintenance releases,
#                         before N's canaries and N+1.
#   --canary M            a canary release, <upstream>-fork.N.canary.M: the M-th
#                         canary after stable N. Its notes are the [Unreleased] section
#                         of fork/CHANGELOG.md, its signed comment ends in " canary",
#                         and it is listed in LATEST-canary only, never in LATEST.
#                         Archive only: no Android app,
#                         and the committed model catalog. Signed with the canary key,
#                         PRISM_CANARY_PUBLIC_KEY in install.sh, which lives on the build
#                         server: the CI builds canaries with --unsigned.
#   --unsigned            a canary without its signature and without LATEST-canary: the
#                         CI's build, which the build server's signer signs and publishes
#   --key PATH            minisign secret key (default ~/.minisign/prism-release.key,
#                         ~/.minisign/prism-canary.key for a canary)
#   --apk-key PATH        the Android app's keystore (default ~/.android/prism-release.keystore), its password
#                         in PATH.pass; its certificate must be APK_CERT_SHA256 below
#   --skip-build          reuse the packages already built in this checkout (dist/)
#
# The archive holds the Node install of install-local.sh (Prism runs on Node)
# , the official Node binary pinned below, the window (gui/prism-gui and its
# icon, built by fork/gui/scripts/build.sh --package; owner's decision A3 of
# 2026-11-05: `prism --gui` opens it, the terminal stays the fallback without
# WebKitGTK), the desktop helpers
# , the phone server gui/prism-remote (fork/android/server, which
# the window's "Link a phone" starts), a relocatable `prism` launcher,
# install.sh (run by `prism update`), and the licenses (LICENSE: GPL-3.0-or-later; LICENSES/: their texts, pi's
# MIT notice and THIRD-PARTY-RUST.txt, the crates' of the Rust programs; Node's; the vendored plugins' under vendor/). NOTES.md is the "## [<version>]" section of
# fork/CHANGELOG.md, which must exist. Beside the archive, the Android app
# an arm64 APK built by fork/android/scripts/build.sh and signed with the app's own key, which
# Android requires for every update; a stable release also copies it to releases/android/, the fixed address the
# window and the phone link to. A stable release also carries the browser extension's store packages
# (package-browser-extension.mjs), which the build server sends to the stores. SHA256SUMS covers the archive, the APK,
# those packages and NOTES.md and is signed with minisign; its trusted comment is
# "prism <version>" ("prism <version> canary" for a canary), which install.sh
# checks. The key must match the public key embedded in install.sh.
#
# Runs `npm run check` first and builds nothing if it fails or changes a file; packs
# nothing if `npm audit` flags a dependency of the built install (moderate or above).
#
# Needs Node, npm dependencies installed (npm ci --ignore-scripts), minisign, curl, xz, and for the window
# Rust (cargo) and the WebKitGTK 4.1 development files (or PRISM_GUI_SYSROOT, see fork/gui/scripts/build.sh),
# and for the desktop helpers what fork/desktop-helper/build.sh lists (gcc, wayland-scanner, development files), and for
# the Android app what fork/android/scripts/build.sh lists (Android SDK and NDK, tauri-cli) plus the SDK's build-tools,
# and cargo-about for the Rust programs' licences (fork/scripts/rust-notices/generate.sh).
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
# Official Node build bundled in the archive. The hash comes from SHASUMS256.txt of
# the release, whose signature was checked against nodejs/release-keys.
NODE_VERSION=v22.22.2
NODE_SHA256=88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a
NODE_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/prism-release"
# The Android app's signing certificate (SHA-256 of its DER form), created on the maintainer's PC on 2026-11-13. Android
# refuses an update signed with another key: a release signed with any other one would strand every installed phone.
APK_CERT_SHA256=5b06af0901f896678f5be2b7defca243ce67aa4194122df6b3661c6ed0b4accb

say() { printf 'release: %s\n' "$*"; }
die() {
	printf 'release: %s\n' "$*" >&2
	exit 1
}

out=""
fork_number=1
canary=""
maintenance=""
key=""
no_sign=""
apk_key="$HOME/.android/prism-release.keystore"
install_args=()
skip_build=""
while [[ $# -gt 0 ]]; do
	case $1 in
	--out)
		out=${2:?--out needs a value}
		shift
		;;
	--fork-number)
		fork_number=${2:?--fork-number needs a value}
		shift
		;;
	--canary)
		canary=${2:?--canary needs a value}
		shift
		;;
	--maintenance)
		maintenance=${2:?--maintenance needs a value}
		shift
		;;
	--key)
		key=${2:?--key needs a value}
		shift
		;;
	--unsigned) no_sign=1 ;;
	--apk-key)
		apk_key=${2:?--apk-key needs a value}
		shift
		;;
	--skip-build)
		install_args+=("$1")
		skip_build=1
		;;
	-h | --help)
		sed -n '2,63p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*) die "unknown option: $1 (see --help)" ;;
	esac
	shift
done
[[ -n "$out" ]] || die "--out is required (see --help)"
[[ "$fork_number" =~ ^[1-9][0-9]*$ ]] || die "fork number must be a positive integer, got '$fork_number'"
[[ -z "$canary" || "$canary" =~ ^[1-9][0-9]*$ ]] || die "canary number must be a positive integer, got '$canary'"
[[ -z "$maintenance" || "$maintenance" =~ ^[1-9][0-9]*$ ]] ||
	die "maintenance number must be a positive integer, got '$maintenance'"
[[ -z "$maintenance" || -z "$canary" ]] || die "--maintenance and --canary do not combine: a maintenance release is stable"
[[ -z "$no_sign" || -n "$canary" ]] || die "--unsigned is for a canary: a stable release is signed here"
for tool in curl xz sha256sum $([[ -n "$no_sign" ]] || echo minisign) $([[ -n "$canary" ]] || echo unzip unshare); do
	command -v "$tool" >/dev/null || die "$tool is required"
done
if [[ -n "$canary" ]]; then
	key=${key:-$HOME/.minisign/prism-canary.key}
	key_variable=PRISM_CANARY_PUBLIC_KEY
else
	key=${key:-$HOME/.minisign/prism-release.key}
	key_variable=PRISM_PUBLIC_KEY
fi
[[ -n "$no_sign" || -f "$key" ]] || die "signing key not found: $key"
if [[ -z "$canary" ]]; then
	[[ -f "$apk_key" && -f "$apk_key.pass" ]] || die "the Android app's keystore or its password file is missing: $apk_key(.pass)"
	android_tools="$(ls -d "${ANDROID_HOME:-$HOME/Android/sdk}"/build-tools/* 2>/dev/null | sort -V | tail -1)"
	[[ -x "$android_tools/apksigner" && -x "$android_tools/zipalign" ]] || die "the Android SDK's build-tools (apksigner, zipalign) are required"
fi
command -v cargo >/dev/null || die "cargo is required"
command -v cargo-about >/dev/null || die "cargo-about is required: cargo install cargo-about --locked --features cli"

# The build machine's paths stay out of the binaries: rustc and C compilers write source paths (the cargo registry's,
# this checkout's) into them, and those name the user who built the release.
# Later prefixes win in rustc, so the broadest comes first. The check before packing (no_build_paths) enforces it.
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=/build --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$ROOT=/prism"
for flags in CFLAGS CXXFLAGS; do
	export "$flags=${!flags:-} -ffile-prefix-map=$HOME=/build -ffile-prefix-map=$cargo_home=/cargo -ffile-prefix-map=$ROOT=/prism"
done
# Fails when a file under $1 (the archive's tree, or an APK's entries) contains the build machine's home or user name.
no_build_paths() {
	local where="$1" user found
	user="$(id -un)"
	if [[ -d "$where" ]]; then
		found="$(grep -r -l -a -F -e "$HOME" -e "/home/$user" "$where" || true)"
	else
		found="$(unzip -Z1 "$where" | while IFS= read -r entry; do
			# Not grep -q: its early exit would fail unzip on SIGPIPE, and pipefail would hide the match.
			unzip -p "$where" "$entry" | grep -a -F -e "$HOME" -e "/home/$user" >/dev/null && printf '%s\n' "$entry"
		done || true)"
	fi
	[[ -z "$found" ]] || die "$(basename "$where") contains the build machine's home ($HOME): $(head -n 5 <<<"$found" | tr '\n' ' ')"
}

# Release notes: the version's section of fork/CHANGELOG.md, heading included,
# up to the next version heading, without trailing blank lines. A canary takes the
# [Unreleased] section, under its own heading.
upstream_version="$(node -p 'require(process.argv[1]).version' "$ROOT/packages/coding-agent/package.json")"
version="${upstream_version%-fork.*}-fork.$fork_number${maintenance:+.$maintenance}${canary:+.canary.$canary}"
section() {
	awk -v h="## [$1]" '
		index($0, h) == 1 && (length($0) == length(h) || substr($0, length(h) + 1, 1) == " ") { on = 1 }
		on && /^## \[/ && index($0, h) != 1 { exit }
		on { print }
	' "$ROOT/fork/CHANGELOG.md"
}
if [[ -n "$canary" ]]; then
	unreleased="$(section Unreleased | tail -n +2)"
	[[ -n "${unreleased//[[:space:]]/}" ]] || die "fork/CHANGELOG.md has nothing under [Unreleased] for this canary"
	notes="$(printf '## [%s] - %s (canary)\n%s' "$version" "$(date +%Y-%m-%d)" "$unreleased")"
	comment="prism $version canary"
	latest_file=LATEST-canary
else
	notes="$(section "$version")"
	[[ -n "$notes" ]] || die "fork/CHANGELOG.md has no '## [$version]' section: move the [Unreleased] entries under it first"
	comment="prism $version"
	latest_file=LATEST
	# The Android app's versionCode must grow with each update: N.p after N, N+1 after every N.p. f-droid.org reads it
	# from fork/android/version-code at the version's public tag to build updates on its own (f-droid.org plan), so
	# the release commit holds it.
	version_code=$((fork_number * 10000 + ${maintenance:-0}))
	[[ "$(cat "$ROOT/fork/android/version-code" 2>/dev/null)" == "$version_code" ]] ||
		die "fork/android/version-code must hold $version_code, the versionCode of $version: write it in the release commit"
fi

# Refuse a key that install.sh would reject: each channel has its own.
work="$(mktemp -d "${TMPDIR:-/tmp}/prism-release.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
if [[ -z "$no_sign" ]]; then
	minisign -R -s "$key" -p "$work/key.pub" >/dev/null
	embedded="$(sed -n "s/^$key_variable=//p" "$ROOT/fork/scripts/install.sh")"
	[[ "$(tail -n 1 "$work/key.pub")" == "$embedded" ]] ||
		die "$key does not match $key_variable, the public key embedded in fork/scripts/install.sh"
fi

# `npm run check` runs here, not through a Git hook that may not be installed. The build
# packs the working tree, so the check must pass on it without changing it: biome's
# --write fixes would ship code that no commit holds.
# The working tree's content as a hash: tracked changes and untracked files.
tree_state() {
	(
		cd "$ROOT"
		git diff HEAD --binary
		git ls-files --others --exclude-standard -z | xargs -0 -r sha256sum --
	) | sha256sum
}
# The built-in model catalog is the fallback offline and before the first pi.dev refresh; a release ships a fresh
# one (no more weekly commits). Like the check below, it must not ship uncommitted.
# A canary ships the committed one: it is built from each green commit, which the catalog must not block.
if [[ -z "$canary" ]]; then
	say "refreshing the built-in model catalog"
	before="$(tree_state)"
	(cd "$ROOT" && npm run generate:models) >"$work/catalog.log" 2>&1 ||
		die "the model catalog was not refreshed, nothing built: $(tail -n 20 "$work/catalog.log")"
	# Each run stamps a new generatedAt; when nothing else changed, keep the committed manifest.
	manifest="packages/ai/src/providers/data/.manifest.json"
	if git -C "$ROOT" diff --quiet -- "$manifest" ||
		(cd "$ROOT" && git show "HEAD:$manifest" | node -e '
			const fs = require("node:fs");
			const [committed, current] = [fs.readFileSync(0, "utf8"), fs.readFileSync(process.argv[1], "utf8")].map((text) => {
				const { generatedAt, ...rest } = JSON.parse(text);
				return JSON.stringify(rest);
			});
			process.exit(committed === current ? 0 : 1);
		' "$manifest"); then
		git -C "$ROOT" checkout HEAD -- "$manifest"
	fi
	[[ "$(tree_state)" == "$before" ]] ||
		die "the model catalog changed: run ./test.sh, commit packages/ai/src/providers/data and models.generated.ts, then build again"
fi

say "running npm run check"
before="$(tree_state)"
(cd "$ROOT" && npm run check) >"$work/check.log" 2>&1 ||
	die "npm run check failed, nothing built: $(tail -n 20 "$work/check.log")"
[[ "$(tree_state)" == "$before" ]] ||
	die "npm run check changed files, nothing built: commit them, then build again"
checked="$(git -C "$ROOT" rev-parse --short HEAD)"
[[ -z "$(git -C "$ROOT" status --porcelain)" ]] || checked="$checked with uncommitted changes"

say "building the Node install"
PRISM_INSTALL_DIR="$work/install" PRISM_BIN_DIR="$work/bin" \
	"$ROOT/fork/scripts/install-local.sh" --runtime node --fork-number "$fork_number" ${maintenance:+--maintenance "$maintenance"} \
	${canary:+--canary "$canary"} "${install_args[@]}" >/dev/null
package_dir="$work/install/node_modules/@earendil-works/pi-coding-agent"
[[ "$(node -p 'require(process.argv[1]).version' "$package_dir/package.json")" == "$version" ]] ||
	die "the build is not version $version"
# The shipped tree is the install lock's (node-install.mjs checks it); audit it as built anyway.
say "auditing the shipped dependencies"
(cd "$work/install" && npm audit --package-lock-only --omit=dev --audit-level=moderate) >"$work/audit.log" 2>&1 ||
	die "npm audit flags the shipped dependencies, nothing packed: $(tail -n 30 "$work/audit.log")"
name="prism-$version-linux-x64"

node_archive="$NODE_CACHE/node-$NODE_VERSION-linux-x64.tar.xz"
if [[ ! -f "$node_archive" ]] || [[ "$(sha256sum "$node_archive" | cut -d' ' -f1)" != "$NODE_SHA256" ]]; then
	say "downloading node $NODE_VERSION"
	mkdir -p "$NODE_CACHE"
	curl -fsSL --proto '=https' -o "$node_archive.part" \
		"https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
	mv "$node_archive.part" "$node_archive"
fi
[[ "$(sha256sum "$node_archive" | cut -d' ' -f1)" == "$NODE_SHA256" ]] || die "$node_archive: checksum mismatch"

root="$work/$name"
mv "$work/install" "$root"
mkdir -p "$root/node/bin"
tar -xJf "$node_archive" -C "$work" "node-$NODE_VERSION-linux-x64/bin/node" "node-$NODE_VERSION-linux-x64/LICENSE"
mv "$work/node-$NODE_VERSION-linux-x64/bin/node" "$root/node/bin/node"
mv "$work/node-$NODE_VERSION-linux-x64/LICENSE" "$root/node/LICENSE"
cp "$ROOT/LICENSE" "$root/LICENSE"
cp -r "$ROOT/LICENSES" "$root/LICENSES"
# `prism update` runs this copy, so the key it trusts comes with the release.
cp "$ROOT/fork/scripts/install.sh" "$root/install.sh"
# Relocatable: the launcher finds Node and the package next to its real path. PRISM_LAUNCHER is the path it was
# run by (the ~/.local/bin link), which the window and the applications-menu entry use: it survives updates.
cat >"$root/prism" <<'EOF'
#!/bin/sh
dir=$(dirname "$(readlink -f "$0")")
case $0 in /*) PRISM_LAUNCHER=$0 ;; *) PRISM_LAUNCHER=$(pwd)/$0 ;; esac
export PRISM_LAUNCHER
exec "$dir/node/bin/node" "$dir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"
EOF
chmod +x "$root/prism"
[[ "$("$root/prism" --version)" == "$version" ]] || die "the packed prism does not report version $version"

# The third-party licences of the window, the phone server and the Android app: in the window's interface, so built
# into the window and the APK, and in the archive.
say "writing the Rust programs' licences"
# Ignored by Git: a fresh checkout (the CI's) has no vendor folder until the window's prepare.sh runs.
mkdir -p "$ROOT/fork/gui/ui/vendor"
"$ROOT/fork/scripts/rust-notices/generate.sh" "$ROOT/fork/gui/ui/vendor/THIRD-PARTY-RUST.txt" >"$work/rust-notices.log" 2>&1 ||
	die "the Rust programs' licences were not written: $(tail -n 30 "$work/rust-notices.log")"
cp "$ROOT/fork/gui/ui/vendor/THIRD-PARTY-RUST.txt" "$root/LICENSES/THIRD-PARTY-RUST.txt"

gui_binary="$ROOT/fork/gui/src-tauri/target-package/release/prism-gui"
if [[ -z "$skip_build" || ! -x "$gui_binary" ]]; then
	say "building the window"
	"$ROOT/fork/gui/scripts/build.sh" --package >"$work/gui-build.log" 2>&1 ||
		die "the window did not build: $(tail -n 30 "$work/gui-build.log")"
fi
mkdir -p "$root/gui"
install -m 0755 "$gui_binary" "$root/gui/prism-gui"
install -m 0644 "$ROOT/fork/gui/src-tauri/icons/icon.png" "$root/gui/prism.png"

say "building the desktop helpers"
"$ROOT/fork/desktop-helper/build.sh" "$work/desktop-helper" >"$work/desktop-helper-build.log" 2>&1 ||
	die "the desktop helpers did not build: $(tail -n 30 "$work/desktop-helper-build.log")"
mkdir -p "$root/desktop"
install -m 0755 "$work/desktop-helper/prism-desktop-helper" "$root/desktop/prism-desktop-helper"
install -m 0755 "$work/desktop-helper/prism-portal-helper" "$root/desktop/prism-portal-helper"

say "building the phone server"
(cd "$ROOT/fork/android/server" && cargo build --release --locked) >"$work/remote-build.log" 2>&1 ||
	die "the phone server did not build: $(tail -n 30 "$work/remote-build.log")"
install -m 0755 "$ROOT/fork/android/server/target/release/prism-remote" "$root/gui/prism-remote"

release_dir="$out/releases/$version"
mkdir -p "$release_dir"

# The Android app, with stable releases only: a canary is the Linux archive alone.
apk=""
if [[ -z "$canary" ]]; then
	apk="prism-$version-android-arm64.apk"
	say "building the Android app ($version, versionCode $version_code)"
	# Built as f-droid.org builds it, so that its build of this commit is this APK, unsigned: from the public
	# repository's tree, which the export rewrites (comments of the window's HTML, CSS and JS, which the APK embeds as
	# they are), and by the same script as the recipe. Hence from HEAD as committed.
	[[ -z "$(git -C "$ROOT" status --porcelain)" ]] ||
		die "the Android app is built from the public export of HEAD: commit or remove the uncommitted changes first"
	node "$ROOT/fork/scripts/public-export.mjs" --out "$work/public" --author "Prism <prism@odelserver.space>" --ref HEAD \
		>"$work/public-export.log" 2>&1 || die "the public export failed: $(tail -n 20 "$work/public-export.log")"
	# The public commit pushed after the tag must hold this very tree, or f-droid.org builds another APK.
	public_tree="$(git -C "$work/public" rev-parse 'HEAD^{tree}')"
	unsigned="$("$work/public/fork/android/scripts/build-release.sh" "$version" "$version_code" 2>"$work/android-build.log" | tail -n 1)" ||
		die "the Android app did not build: $(tail -n 30 "$work/android-build.log")"
	"$android_tools/zipalign" -f -p 4 "$unsigned" "$work/aligned.apk"
	# --alignment-preserved: apksigner otherwise lays the ZIP out again, and f-droid.org, which copies this signature
	# onto its own build of the tag (apksigcopier), finds digests that no longer match.
	"$android_tools/apksigner" sign --v4-signing-enabled false --alignment-preserved --ks "$apk_key" --ks-pass "file:$apk_key.pass" --ks-key-alias prism \
		--out "$release_dir/$apk" "$work/aligned.apk" 2>"$work/apksigner.log" ||
		die "the Android app could not be signed: $(tail -n 5 "$work/apksigner.log")"
	# Every signer's certificate ("Signer #1", "V3.0 Signer"… depending on the build-tools): one, the app's.
	certificate="$("$android_tools/apksigner" verify --print-certs "$release_dir/$apk" 2>/dev/null |
		sed -n 's/^.*[Ss]igner[^:]*:\{0,1\} certificate SHA-256 digest: //p' | sort -u | tr '\n' ' ' | sed 's/ $//')"
	[[ "$certificate" == "$APK_CERT_SHA256" ]] ||
		die "the Android app is signed by '$certificate', not the app's key $APK_CERT_SHA256"
fi

# The browser extension's store packages, with stable releases only: a publisher on the site's server sends a version
# newer than the one each store has, once SHA256SUMS is signed.
extension_packages=()
if [[ -z "$canary" ]]; then
	say "packing the browser extension for the stores"
	node "$ROOT/fork/scripts/package-browser-extension.mjs" "$release_dir" >"$work/extension-package.log" 2>&1 ||
		die "the browser extension's packages were not built: $(tail -n 30 "$work/extension-package.log")"
	extension_version="$(node -p 'require(process.argv[1]).version' "$ROOT/packages/coding-agent/browser-extension/manifest.json")"
	extension_packages=("prism-firefox-$extension_version.zip" "prism-chromium-$extension_version.zip")
fi

say "checking that no build path is left in the release"
no_build_paths "$root"
[[ -z "$apk" ]] || no_build_paths "$release_dir/$apk"

say "packing $name.tar.gz"
tar --sort=name --owner=0 --group=0 --numeric-owner -C "$work" -czf "$release_dir/$name.tar.gz" "$name"
# The deb and rpm packages, stable releases only: the archive
# repacked as is, covered by SHA256SUMS like the rest.
linux_packages=()
if [[ -z "$canary" ]]; then
	say "packing the deb and rpm packages"
	mapfile -t linux_packages < <("$ROOT/fork/scripts/package-linux.sh" "$release_dir/$name.tar.gz" "$release_dir" 2>"$work/package-linux.log" |
		xargs -r -n1 basename) || true
	[[ ${#linux_packages[@]} -eq 2 ]] || die "the deb and rpm packages were not built: $(tail -n 30 "$work/package-linux.log")"
fi
# The AppImage (the light one, the window on the host's WebKitGTK), stable releases
# only, from the same archive.
appimage=""
if [[ -z "$canary" ]]; then
	say "packing the AppImage"
	appimage="$("$ROOT/fork/scripts/package-appimage.sh" "$release_dir/$name.tar.gz" "$release_dir" 2>"$work/package-appimage.log" |
		xargs -r -n1 basename)" || true
	[[ "$appimage" == "prism-$version-x86_64.AppImage" ]] ||
		die "the AppImage was not built: $(tail -n 30 "$work/package-appimage.log")"
fi
printf '%s\n' "$notes" >"$release_dir/NOTES.md"
(cd "$release_dir" && sha256sum "$name.tar.gz" ${apk:+"$apk"} "${extension_packages[@]}" "${linux_packages[@]}" ${appimage:+"$appimage"} NOTES.md >SHA256SUMS)
if [[ -n "$no_sign" ]]; then
	say "canary $version in $release_dir, unsigned: $(du -h "$release_dir/$name.tar.gz" | cut -f1)"
	say "the build server's signer signs it and lists it in LATEST-canary"
	exit 0
fi
minisign -S -s "$key" -m "$release_dir/SHA256SUMS" -t "$comment" >/dev/null
printf '%s\n' "$version" >"$out/releases/$latest_file"
if [[ -z "$canary" ]]; then
	# The fixed address of the latest stable APK, and the installer the site serves: a canary changes neither.
	mkdir -p "$out/releases/android"
	cp "$release_dir/$apk" "$out/releases/android/prism-android-arm64.apk"
	# Where AppImage managers look for an update (the address the AppImage embeds): a pointer, like LATEST.
	mv "$release_dir/$appimage.zsync" "$out/releases/LATEST-x86_64.AppImage.zsync"
	cp "$ROOT/fork/scripts/install.sh" "$out/install.sh"
	# The installer's own signature: a user can check install.sh with the release key published in the public
	# repository before running it, independently of the site.
	minisign -S -s "$key" -m "$out/install.sh" -t "prism install.sh $version" >/dev/null
fi

say "release $version in $out ($(du -h "$release_dir/$name.tar.gz" | cut -f1)${apk:+, APK $(du -h "$release_dir/$apk" | cut -f1)})"
say "npm run check passed on $checked; ./test.sh and fork/tools/test-release.sh are still to run"
say "publish: copy $out/ over the site's folder (rsync -rt)"
[[ -n "$canary" ]] || say "then tag: git tag -a prism-v$version -F $release_dir/NOTES.md && git push origin prism-v$version"
[[ -n "$canary" ]] || say "the public commit of this version must have the tree $public_tree (the APK's)"
