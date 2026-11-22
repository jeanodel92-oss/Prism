#!/usr/bin/env bash
# The phone app's release APK, unsigned, as fork/scripts/release.sh and the f-droid.org recipe both build it: the same
# steps in both places, so f-droid.org's build of a tag is bit for bit the APK the release signs
# .
#
# usage: fork/android/scripts/build-release.sh VERSION VERSION_CODE
#   prints the unsigned APK's path on its last line.
#
# Needs what scripts/build.sh and fork/scripts/rust-notices/generate.sh need (Android SDK and NDK, Rust 1.97.1 with
# the aarch64-linux-android target, tauri-cli 2.12.4, cargo-about 0.9, Node 22.13 or later).
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$APP/../.." && pwd)"
[[ $# -eq 2 ]] || {
	echo "usage: build-release.sh VERSION VERSION_CODE" >&2
	exit 2
}
version=$1
version_code=$2

# The Rust version of the f-droid.org recipe: another rustc builds another libprism_mobile_lib.so, and f-droid.org
# would no longer find this APK in its build. An installed toolchain of that name is used even
# when the default is another; otherwise the active rustc must be that version.
RUST_VERSION=1.97.1
if command -v rustup >/dev/null && rustup run "$RUST_VERSION" rustc --version >/dev/null 2>&1; then
	export RUSTUP_TOOLCHAIN="$RUST_VERSION"
fi
rust="$(rustc --version | cut -d ' ' -f 2)"
[[ "$rust" == "$RUST_VERSION" ]] || {
	echo "build-release: rustc $rust, the f-droid.org recipe builds with $RUST_VERSION;" \
		"install it: rustup toolchain install $RUST_VERSION --profile minimal --target aarch64-linux-android" >&2
	exit 1
}

# The Rust crates' licences, in the window's interface that the app serves.
mkdir -p "$ROOT/fork/gui/ui/vendor"
"$ROOT/fork/scripts/rust-notices/generate.sh" "$ROOT/fork/gui/ui/vendor/THIRD-PARTY-RUST.txt"

# The build machine's paths stay out of the binaries: rustc and C compilers write source paths (the cargo registry's,
# this checkout's) into them, and those name the user who built it. Later
# prefixes win in rustc, so the broadest comes first. Set here, not added to the caller's flags: any other flag would
# change the APK.
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$HOME=/build --remap-path-prefix=$cargo_home=/cargo --remap-path-prefix=$ROOT=/prism"
for flags in CFLAGS CXXFLAGS; do
	export "$flags=-ffile-prefix-map=$HOME=/build -ffile-prefix-map=$cargo_home=/cargo -ffile-prefix-map=$ROOT=/prism"
done

config="$(mktemp)"
trap 'rm -f -- "$config"' EXIT
printf '{"version":"%s","bundle":{"android":{"versionCode":%s}}}\n' "$version" "$version_code" >"$config"
"$APP/scripts/build.sh" --config "$config" >&2
apk="$APP/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk"
[[ -f "$apk" ]] || {
	echo "build-release: no $apk" >&2
	exit 1
}
echo "$apk"
