#!/usr/bin/env bash
# Build a signed release of the browser extension alone, for the stores, ahead of the Prism release that ships it
#. Each store reviews a version for up to days, and
# Prism stays compatible with the previous version of the extension meanwhile.
#
# usage: fork/scripts/release-extension.sh --out DIR [--key PATH]
#
#   --out DIR    output directory, laid out like the site:
#                  DIR/releases/extension/LATEST
#                  DIR/releases/extension/<x.y.z>/prism-{firefox,chromium}-<x.y.z>.zip
#                  DIR/releases/extension/<x.y.z>/SHA256SUMS (+ .minisig)
#   --key PATH   minisign secret key (default ~/.minisign/prism-release.key): the release key, which install.sh
#                trusts as PRISM_PUBLIC_KEY.
#
# <x.y.z> is the version of packages/coding-agent/browser-extension/manifest.json. SHA256SUMS is signed with the
# trusted comment "prism-extension <x.y.z>": the build server's extension publisher sends a version newer than the
# last one sent to each store, and a stable release's SHA256SUMS ("prism <version>") cannot pass for this one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
die() {
	echo "release-extension: $*" >&2
	exit 1
}

out=""
key=""
while [[ $# -gt 0 ]]; do
	case $1 in
	--out)
		out=${2:?--out needs a value}
		shift
		;;
	--key)
		key=${2:?--key needs a value}
		shift
		;;
	*) die "unknown argument: $1" ;;
	esac
	shift
done
[[ -n "$out" ]] || die "--out DIR is required"
key=${key:-$HOME/.minisign/prism-release.key}
for tool in minisign sha256sum node git; do
	command -v "$tool" >/dev/null || die "$tool is required"
done
[[ -f "$key" ]] || die "signing key not found: $key"

source_dir="$ROOT/packages/coding-agent/browser-extension"
# The packages are built from the working tree: it must hold what a commit holds.
[[ -z "$(git -C "$ROOT" status --porcelain -- "$source_dir")" ]] ||
	die "the extension has uncommitted changes: commit them first"
version="$(node -p 'require(process.argv[1]).version' "$source_dir/manifest.json")"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the manifest's version is not x.y.z: $version"

work="$(mktemp -d "${TMPDIR:-/tmp}/prism-release-extension.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
# Refuse a key that install.sh would reject.
minisign -R -s "$key" -p "$work/key.pub" >/dev/null
embedded="$(sed -n 's/^PRISM_PUBLIC_KEY=//p' "$ROOT/fork/scripts/install.sh")"
[[ "$(tail -n 1 "$work/key.pub")" == "$embedded" ]] ||
	die "$key does not match PRISM_PUBLIC_KEY, the public key embedded in fork/scripts/install.sh"

dir="$out/releases/extension/$version"
[[ ! -e "$dir" ]] || die "$dir exists already: a version is released once"
mkdir -p "$work/release"
node "$ROOT/fork/scripts/package-browser-extension.mjs" "$work/release" >"$work/package.log" 2>&1 ||
	die "packaging failed: $(cat "$work/package.log")"
for store in firefox chromium; do
	[[ -f "$work/release/prism-$store-$version.zip" ]] || die "prism-$store-$version.zip was not built"
done
(cd "$work/release" && sha256sum "prism-firefox-$version.zip" "prism-chromium-$version.zip" >SHA256SUMS)
minisign -S -s "$key" -m "$work/release/SHA256SUMS" -t "prism-extension $version" >/dev/null
minisign -V -p "$work/key.pub" -m "$work/release/SHA256SUMS" >/dev/null || die "the signature does not verify"

mkdir -p "$(dirname "$dir")"
mv "$work/release" "$dir"
printf '%s\n' "$version" >"$out/releases/extension/LATEST"
echo "$dir"
