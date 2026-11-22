#!/usr/bin/env bash
# Acceptance check for the deb and rpm packages of a stable release, built by fork/scripts/release.sh
# (fork/scripts/package-linux.sh): in Fedora 44, Debian 13 and Ubuntu 24.04 containers,
#   1. install with dnf or apt, which pulls bubblewrap and WebKitGTK; /usr/bin/prism and the package's marker;
#   2. `prism --version` as a user; `prism update` and `prism update --rollback` refuse and name the package manager;
#   3. upgrade to a newer package (this release repacked as <version>.99) and downgrade back;
#   4. removal: /opt/prism and /usr/bin/prism gone, the user's ~/.prism kept.
# Not covered: AppArmor on a real Ubuntu (a container shares the host's kernel and its security modules), the window.
#
# usage: fork/tools/test-packages.sh <release-out-dir>
#
# Needs podman and what package-linux.sh needs. Pulls the three images on first use.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
[[ $# -eq 1 ]] || {
	echo "usage: test-packages.sh <release-out-dir>" >&2
	exit 2
}
rel="$(cd "$1" && pwd)"
version="$(head -n1 "$rel/releases/LATEST")"
pkg_version="${version//-/+}"
newer="$version.99"
newer_pkg="${newer//-/+}"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir "$work/pkgs" "$work/repack"
cp "$rel/releases/$version/prism_${pkg_version}-1_amd64.deb" "$rel/releases/$version/prism-${pkg_version}-1.x86_64.rpm" "$work/pkgs/"
# The newer release: the same tree under a newer name, packed and packaged as release.sh does.
tar -xzf "$rel/releases/$version/prism-$version-linux-x64.tar.gz" -C "$work/repack"
mv "$work/repack/prism-$version-linux-x64" "$work/repack/prism-$newer-linux-x64"
tar -C "$work/repack" -czf "$work/prism-$newer-linux-x64.tar.gz" "prism-$newer-linux-x64"
rm -rf "$work/repack"
"$ROOT/fork/scripts/package-linux.sh" "$work/prism-$newer-linux-x64.tar.gz" "$work/pkgs" >/dev/null 2>&1

cat >"$work/inside.sh" <<'EOF'
#!/bin/sh
# Inside the container, as root: $1 deb|rpm, $2 the release's package version, $3 the newer one, $4 the version.
set -eu
kind=$1 v=$2 nv=$3 version=$4
fail() { echo "FAIL: $*"; exit 1; }
if [ "$kind" = deb ]; then
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq >/dev/null
	install() { apt-get install -y -qq --allow-downgrades "/pkgs/prism_$1-1_amd64.deb" >/dev/null; }
	installed() { dpkg-query -W -f '${Version}' prism; }
	remove() { apt-get remove -y -qq prism >/dev/null; }
	manager=apt
else
	install() { dnf install -y -q "/pkgs/prism-$1-1.x86_64.rpm" >/dev/null 2>&1 || dnf upgrade -y -q "/pkgs/prism-$1-1.x86_64.rpm" >/dev/null 2>&1 || dnf downgrade -y -q "/pkgs/prism-$1-1.x86_64.rpm" >/dev/null; }
	installed() { rpm -q --qf '%{VERSION}-%{RELEASE}' prism; }
	remove() { dnf remove -y -q prism >/dev/null; }
	manager=dnf
	# The Fedora image has no su.
	command -v su >/dev/null || dnf install -y -q util-linux >/dev/null
fi
install "$v"
[ "$(installed)" = "$v-1" ] || fail "installed $(installed), not $v-1"
command -v bwrap >/dev/null || fail "bubblewrap was not pulled in"
[ "$(readlink /usr/bin/prism)" = /opt/prism/prism ] || fail "/usr/bin/prism does not point to /opt/prism/prism"
[ "$(cat /opt/prism/.prism-package)" = "$manager" ] || fail "the marker does not name $manager"
echo "ok: installed $v-1 with its dependencies"
useradd -m tester
su tester -c 'mkdir -p ~/.prism/agent && echo kept > ~/.prism/agent/probe'
[ "$(su tester -c 'prism --version' 2>&1)" = "$version" ] || fail "prism --version: $(su tester -c 'prism --version' 2>&1)"
for args in update "update --rollback" "update --check"; do
	if out=$(su tester -c "prism $args" 2>&1); then fail "prism $args succeeded: $out"; fi
	case $out in *"installed by $manager"*) ;; *) fail "prism $args: $out" ;; esac
done
echo "ok: prism runs; prism update names $manager and installs nothing"
install "$nv"
[ "$(installed)" = "$nv-1" ] || fail "upgrade: installed $(installed)"
install "$v"
[ "$(installed)" = "$v-1" ] || fail "downgrade: installed $(installed)"
echo "ok: upgrade to $nv and back"
remove
[ ! -e /opt/prism ] || fail "/opt/prism left: $(ls -A /opt/prism | head -3)"
[ ! -e /usr/bin/prism ] && [ ! -L /usr/bin/prism ] || fail "/usr/bin/prism left"
[ "$(cat /home/tester/.prism/agent/probe)" = kept ] || fail "~/.prism was touched"
echo "ok: removed, ~/.prism kept"
EOF

status=0
for spec in "registry.fedoraproject.org/fedora:44 rpm" "docker.io/library/debian:trixie-slim deb" "docker.io/library/ubuntu:24.04 deb"; do
	read -r image kind <<<"$spec"
	echo "== $image"
	podman run --rm --memory 3g -v "$work/pkgs:/pkgs:ro,Z" -v "$work/inside.sh:/inside.sh:ro,Z" "$image" \
		sh /inside.sh "$kind" "$pkg_version" "$newer_pkg" "$version" || status=1
done
[[ $status -eq 0 ]] && echo "all package checks passed" || echo "FAIL: see above" >&2
exit $status
