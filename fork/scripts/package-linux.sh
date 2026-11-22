#!/usr/bin/env bash
# Repack a Prism release archive as a deb and an rpm, with nFPM.
#
# usage: fork/scripts/package-linux.sh ARCHIVE OUT_DIR
#
#   ARCHIVE   prism-<version>-linux-x64.tar.gz, as fork/scripts/release.sh packs it
#   OUT_DIR   where prism_<pkg version>-1_amd64.deb and prism-<pkg version>-1.x86_64.rpm are written
#
# Both packages hold the archive's tree as is under /opt/prism, a /usr/bin/prism link, and the marker that makes
# Prism leave its updates to apt or dnf (fork/packaging/nfpm.yaml). The package version is the release's with "+"
# for "-": a "-" would split the deb version and is not allowed in an rpm one,
# and with "+" both dpkg and rpm sort fork.12 < fork.12.1 < fork.13. Canaries are not packaged.
#
# Needs curl, tar, sha256sum and unshare (util-linux) with unprivileged user namespaces.
#
# nFPM is downloaded once into the release cache and checked against the hash below, taken from the checksums.txt
# of its GitHub release.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
NFPM_VERSION=2.48.0
NFPM_SHA256=6d7f9a28b2f397934403950fcbba83f598b08d02edbe79a0815b3b4897341750
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/prism-release"

die() {
	echo "package-linux: $*" >&2
	exit 1
}

[[ $# -eq 2 ]] || die "usage: package-linux.sh ARCHIVE OUT_DIR"
archive="$1"
out="$2"
[[ -f "$archive" ]] || die "$archive: no such file"
name="$(basename "$archive" .tar.gz)"
[[ "$name" =~ ^prism-(.+)-linux-x64$ ]] || die "$archive: not a prism-<version>-linux-x64.tar.gz"
version="${BASH_REMATCH[1]}"
[[ "$version" != *.canary.* ]] || die "$version: canaries are not packaged"
[[ "$version" =~ ^[0-9][0-9A-Za-z.-]*$ ]] || die "$version: unexpected version"
pkg_version="${version//-/+}"

nfpm_archive="$CACHE/nfpm_${NFPM_VERSION}_Linux_x86_64.tar.gz"
if [[ ! -f "$nfpm_archive" ]] || [[ "$(sha256sum "$nfpm_archive" | cut -d' ' -f1)" != "$NFPM_SHA256" ]]; then
	echo "package-linux: downloading nFPM $NFPM_VERSION" >&2
	mkdir -p "$CACHE"
	curl -fsSL --proto '=https' -o "$nfpm_archive.part" \
		"https://github.com/goreleaser/nfpm/releases/download/v$NFPM_VERSION/nfpm_${NFPM_VERSION}_Linux_x86_64.tar.gz"
	mv "$nfpm_archive.part" "$nfpm_archive"
fi
[[ "$(sha256sum "$nfpm_archive" | cut -d' ' -f1)" == "$NFPM_SHA256" ]] || die "$nfpm_archive: checksum mismatch"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
tar -xzf "$nfpm_archive" -C "$work" nfpm
tar -xzf "$archive" -C "$work"
[[ -x "$work/$name/prism" ]] || die "$archive: no prism launcher at its root"
mv "$work/$name" "$work/tree"
cp -r "$ROOT/fork/packaging/markers" "$work/markers"

mkdir -p "$out"
out="$(cd "$out" && pwd)"
# An rpm records the host that built it: build under a neutral name rather than the build machine's (public site
# audit, SP-05: nothing that names the machine or its user ships).
for packager in deb rpm; do
	(cd "$work" && PRISM_PKG_VERSION="$pkg_version" unshare --user --map-root-user --uts sh -c \
		'hostname prism-build && exec ./nfpm package --config "$1" --packager "$2" --target "$3/"' \
		sh "$ROOT/fork/packaging/nfpm.yaml" "$packager" "$out") >&2
done
ls "$out"/prism_"$pkg_version"-1_amd64.deb "$out"/prism-"$pkg_version"-1.x86_64.rpm
