#!/usr/bin/env bash
# builds the canary release of a green commit of `dev`, in the CI of the build server, and leaves it
# unsigned in OUTBOX, where a signer that alone holds the canary key signs and publishes it.
#
# Version: <upstream>-fork.N.canary.M, N the stable release the commit descends from (its tag prism-v<upstream>-fork.N)
# and M the number of commits since that tag, so canaries of later commits sort after. Nothing is built when
# fork/CHANGELOG.md has nothing under [Unreleased]: a canary's notes are that section.
#
# usage: fork/scripts/ci-canary.sh OUTBOX
set -euo pipefail

outbox=${1:?usage: ci-canary.sh OUTBOX}
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
say() { printf 'ci-canary: %s\n' "$*"; }
die() {
	printf 'ci-canary: %s\n' "$*" >&2
	exit 1
}

# The nearest stable tag, maintenance releases included, gives N; M counts from fork.N.
nearest="$(git -C "$ROOT" describe --tags --abbrev=0 --match 'prism-v*-fork.*' --exclude '*canary*' HEAD 2>/dev/null)" ||
	die "no stable tag prism-v*-fork.* in this checkout's history: fetch the tags (fetch-depth: 0)"
[[ "$nearest" =~ ^prism-v(.+)-fork\.([1-9][0-9]*)(\.[0-9]+)?$ ]] || die "unexpected tag $nearest"
upstream=${BASH_REMATCH[1]}
fork_number=${BASH_REMATCH[2]}
stable_tag="prism-v$upstream-fork.$fork_number"
canary="$(git -C "$ROOT" rev-list --count "$stable_tag..HEAD")"
[[ "$canary" -gt 0 ]] || {
	say "HEAD is $stable_tag itself: no canary"
	exit 0
}
# The upstream part is the package's, as release.sh names it.
package_version="$(node -p 'require(process.argv[1]).version' "$ROOT/packages/coding-agent/package.json")"
version="${package_version%-fork.*}-fork.$fork_number.canary.$canary"

if ! awk '/^## \[Unreleased\]/ { on = 1; next } on && /^## \[/ { exit } on && NF { found = 1 } END { exit !found }' \
	"$ROOT/fork/CHANGELOG.md"; then
	say "fork/CHANGELOG.md has nothing under [Unreleased]: no canary for $version"
	exit 0
fi
[[ ! -e "$outbox/$version" ]] || die "$outbox/$version is already waiting for the signer"

out="$(mktemp -d "${TMPDIR:-/tmp}/prism-canary.XXXXXX")"
trap 'rm -rf -- "$out"' EXIT
say "building $version ($(git -C "$ROOT" rev-parse --short HEAD))"
"$ROOT/fork/scripts/release.sh" --out "$out" --fork-number "$fork_number" --canary "$canary" --unsigned
[[ -d "$out/releases/$version" ]] || die "release.sh did not build $version: $(ls "$out/releases")"

# The signer takes a folder once it has its final name.
rm -rf -- "$outbox/$version.part"
cp -R -- "$out/releases/$version" "$outbox/$version.part"
mv -T -- "$outbox/$version.part" "$outbox/$version"
say "$version is in $outbox for the signer"
