#!/usr/bin/env bash
# fork: writes the licences and copyright notices of the third-party crates in
# the Rust programs Prism ships (the window, the phone server, the Android app), which their MIT, Apache and BSD
# licences require with every copy. fork/scripts/release.sh runs it before building them: the file goes into the
# window's interface, hence into the window and the APK, and into the release archive's LICENSES/.
# Needs cargo-about 0.9 (cargo install cargo-about --locked --features cli).
#   fork/scripts/rust-notices/generate.sh OUT
set -euo pipefail
out=${1:?usage: generate.sh OUT}
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
command -v cargo-about >/dev/null || {
	echo "rust-notices: cargo-about is missing: cargo install cargo-about --locked --features cli" >&2
	exit 1
}
tmp="$(mktemp)"
trap 'rm -f "$tmp" "$tmp.part"' EXIT
{
	echo "Prism: third-party licences of its Rust programs"
	echo
	echo "Prism's own code is under GPL-3.0-or-later (LICENSE). The crates below keep their own licences."
	for entry in "fork/gui/src-tauri:the window (prism-gui)" "fork/android/server:the phone server (prism-remote)" \
		"fork/android/src-tauri:the Android app"; do
		manifest="$root/${entry%%:*}/Cargo.toml"
		echo
		echo "################################################################################"
		echo "Crates in ${entry#*:}"
		echo "################################################################################"
		echo
		cargo about generate --locked -c "$here/about.toml" -m "$manifest" -o "$tmp.part" "$here/notices.hbs"
		cat "$tmp.part"
	done
} >"$tmp"
mv "$tmp" "$out"
