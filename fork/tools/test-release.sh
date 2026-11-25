#!/usr/bin/env bash
# Acceptance check for a release built by fork/scripts/release.sh:
# installs it with `curl ... | sh` in a Debian container that has neither pi nor
# Prism, from a local HTTPS server that mimics https://prism.odelserver.space.
#
# usage: fork/tools/test-release.sh <release-out-dir>
#
# Checks, with openssl and then with minisign verifying the signature:
#   1. install, `prism --version`, a print-mode prompt answered by the fake provider;
#   2. reinstall over an existing install;
#   3. refused, nothing installed: an archive changed by one byte, SHA256SUMS
#      changed to match it, SHA256SUMS signed with another key, a valid signature
#      replayed for another version;
#   4. uninstall;
#   NOTES.md is the version's section of fork/RELEASE-NOTES.md and listed in SHA256SUMS
#, checked on the host, as the licences in the archive;
#   5. the update channel, on releases n and n+1 repacked from this one
#      with install.sh trusting a throwaway key: an install made by the first
#      installer (no versions/) replaced by this one, `prism update --check`, a tampered archive
#      and a tampered SHA256SUMS refused, an unreachable server reported, update
#      n -> n+1 printing its release notes, tampered notes refused, an older
#      LATEST refused, rollback and its undo; with the site down, check and update from
#      the mirror laid out as GitHub releases, a tampered archive there refused;
#   6. the release channels, on stable and canary releases repacked from this
#      one and signed with throwaway keys, one per channel: a stable installation ignores
#      LATEST-canary, refuses a canary listed in LATEST, a stable release signed
#      as canary (so does the installer from before the channels) and one signed with the canary
#      key; the switch to canary, its notes and warning; a canary signed as stable, and one signed
#      with the stable key, refused; canary
#      updates, rollback with its channel; the way back to an older stable release
#      keeping ~/.prism; a stable release newer than the last canary reaching canary;
#      a fresh install on the canary channel;
#   7. maintenance releases <upstream>-fork.N.P, on releases repacked from this one: fork.N
#      installed and updated by the installer published with it (its tag, when there is one);
#      N.1 offered, a maintenance release signed as canary, N's signature replayed for N.1 and
#      N.1 signed with an untrusted key refused; update to N.1 with its notes, rollback and
#      undo; N.1 -> N.2 -> N.10 and N.2 then refused as older; N.10 -> N+1; a canary
#      installation keeps N's newer canary over N.1.
# A canary build is installed with --channel canary
# in steps 1 to 4; steps 5 and 6 use stable versions derived from it.
# Needs podman, python3, openssl and minisign on the host. Builds the image
# localhost/prism-install-test (debian:bookworm-slim + curl, openssl) once.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
rel=${1:?usage: test-release.sh <release-out-dir>}
rel="$(cd "$rel" && pwd)"
# A canary build lists itself in LATEST-canary only.
if [[ -f "$rel/releases/LATEST" ]]; then
	version="$(cat "$rel/releases/LATEST")"
	channel=stable
	list=LATEST
else
	version="$(cat "$rel/releases/LATEST-canary")"
	channel=canary
	list=LATEST-canary
fi
archive="prism-$version-linux-x64.tar.gz"
image=localhost/prism-install-test
port=18443

work="$(mktemp -d "${TMPDIR:-/tmp}/prism-release-test.XXXXXX")"
server_pid=""
cleanup() {
	[[ -n "$server_pid" ]] && kill "$server_pid" 2>/dev/null
	rm -rf -- "$work"
}
trap cleanup EXIT

# Release notes: read the changelog section here independently of release.sh.
# A canary's are the [Unreleased] section under its own "(canary)" heading.
python3 - "$ROOT/fork/RELEASE-NOTES.md" "$rel/releases/$version/NOTES.md" "$version" "$channel" <<'EOF'
import re, sys
changelog, notes, version, channel = open(sys.argv[1]).read(), open(sys.argv[2]).read(), sys.argv[3], sys.argv[4]
section = version if channel == "stable" else "Unreleased"
match = re.search(r"^## \[" + re.escape(section) + r"\](?: .*)?\n(?:(?!## \[).*\n?)*", changelog, re.M)
expected = match and match.group(0).rstrip("\n") + "\n"
if match and channel == "canary":
    heading = notes.partition("\n")[0]
    if not re.fullmatch(r"## \[" + re.escape(version) + r"\] - \d{4}-\d{2}-\d{2} \(canary\)", heading):
        sys.exit("FAIL: the canary notes heading is " + heading)
    expected = heading + "\n" + expected.partition("\n")[2]
if not match or expected != notes:
    sys.exit("FAIL: NOTES.md is not the '## [" + section + "]' section of fork/RELEASE-NOTES.md")
EOF
grep -q ' NOTES.md$' "$rel/releases/$version/SHA256SUMS" || { echo "FAIL: NOTES.md is not in SHA256SUMS" >&2; exit 1; }
echo "ok: NOTES.md is the release notes section of $version and is signed"
# Licences: Prism's GPL, pi's MIT notice, the Rust programs' third-party licences.
listing="$(tar -tzf "$rel/releases/$version/$archive")"
for licence in LICENSE LICENSES/GPL-3.0-or-later.txt LICENSES/MIT.txt LICENSES/THIRD-PARTY-RUST.txt; do
	grep -qx "prism-$version-linux-x64/$licence" <<<"$listing" || { echo "FAIL: $licence is not in the archive" >&2; exit 1; }
done
echo "ok: the archive carries the licences"
# The browser extension's store packages: in a stable release, signed, at the version this checkout
# ships; the build server sends them to the stores. Never in a canary.
extension_version="$(node -p 'require(process.argv[1]).version' "$ROOT/packages/coding-agent/browser-extension/manifest.json")"
for store in firefox chromium; do
	package="prism-$store-$extension_version.zip"
	if [[ "$channel" == canary ]]; then
		! grep -q "prism-$store-" "$rel/releases/$version/SHA256SUMS" ||
			{ echo "FAIL: a canary carries the $store package" >&2; exit 1; }
		continue
	fi
	grep -q " \*\{0,1\}$package\$" "$rel/releases/$version/SHA256SUMS" ||
		{ echo "FAIL: $package is not in SHA256SUMS" >&2; exit 1; }
	[[ "$(unzip -p "$rel/releases/$version/$package" manifest.json | node -p 'JSON.parse(require("fs").readFileSync(0)).version')" == "$extension_version" ]] ||
		{ echo "FAIL: $package's manifest is not version $extension_version" >&2; exit 1; }
done
# The deb and rpm packages: in a stable release, signed; never in a canary. fork/tools/test-packages.sh
# installs them.
pkg_version="${version//-/+}"
for package in "prism_${pkg_version}-1_amd64.deb" "prism-${pkg_version}-1.x86_64.rpm"; do
	if [[ "$channel" == canary ]]; then
		! grep -q '\.\(deb\|rpm\)$' "$rel/releases/$version/SHA256SUMS" ||
			{ echo "FAIL: a canary carries a deb or rpm package" >&2; exit 1; }
		continue
	fi
	grep -q " \*\{0,1\}$package\$" "$rel/releases/$version/SHA256SUMS" ||
		{ echo "FAIL: $package is not in SHA256SUMS" >&2; exit 1; }
done
# The AppImage: the same rule.
if [[ "$channel" == canary ]]; then
	! grep -q '\.AppImage$' "$rel/releases/$version/SHA256SUMS" || { echo "FAIL: a canary carries an AppImage" >&2; exit 1; }
else
	grep -q " \*\{0,1\}prism-$version-x86_64\.AppImage\$" "$rel/releases/$version/SHA256SUMS" ||
		{ echo "FAIL: the AppImage is not in SHA256SUMS" >&2; exit 1; }
	[[ "$(APPIMAGE_EXTRACT_AND_RUN=1 "$rel/releases/$version/prism-$version-x86_64.AppImage" --version)" == "$version" ]] ||
		{ echo "FAIL: the AppImage does not report version $version" >&2; exit 1; }
fi
(cd "$rel/releases/$version" && sha256sum -c --quiet SHA256SUMS) || { echo "FAIL: a file does not match SHA256SUMS" >&2; exit 1; }
[[ "$channel" == canary ]] || echo "ok: the deb and rpm packages and the AppImage are signed in the release"
[[ "$channel" == canary ]] && echo "ok: no extension packages in a canary" ||
	echo "ok: the extension's store packages ($extension_version) are signed in the release"

# Served tree: the release as built, plus one broken variant per subdirectory.
srv="$work/srv"
mkdir -p "$srv"
cp -a "$rel/releases" "$srv/"
# A canary build leaves the site's installer alone: the checkout's is the one that installs it.
cp "$ROOT/fork/scripts/install.sh" "$srv/install.sh"
[[ "$channel" == canary ]] || cp "$rel/install.sh" "$srv/install.sh"
variant() {
	mkdir -p "$srv/$1/releases/$2"
	printf '%s\n' "$2" >"$srv/$1/releases/$list"
	cp -a "$rel/releases/$version/." "$srv/$1/releases/$2/"
}
flip_byte() { printf '\377' | dd of="$1" bs=1 seek=4096 conv=notrunc 2>/dev/null; }

variant tamper "$version"
flip_byte "$srv/tamper/releases/$version/$archive"

variant sums "$version"
flip_byte "$srv/sums/releases/$version/$archive"
(cd "$srv/sums/releases/$version" && sha256sum "$archive" >SHA256SUMS)

variant otherkey "$version"
minisign -G -W -p "$work/other.pub" -s "$work/other.key" >/dev/null
comment="prism $version"
[[ "$channel" == stable ]] || comment="prism $version canary"
minisign -S -s "$work/other.key" -m "$srv/otherkey/releases/$version/SHA256SUMS" -t "$comment" >/dev/null

# A genuine SHA256SUMS and signature, served as another version.
variant replay 9.9.9
mv "$srv/replay/releases/9.9.9/$archive" "$srv/replay/releases/9.9.9/prism-9.9.9-linux-x64.tar.gz"

# Update channel: n and n+1, signed with the throwaway key, which their install.sh trusts; canaries with a
# throwaway canary key, which it trusts for canaries only.
# Stable versions, also for a canary build. base is fork.N without a maintenance number; the
# next release of a fork.N build is its first maintenance release, that of N.P is N.(P+1).
stable="${version%%.canary.*}"
base="$(sed -E 's/^(.*-fork\.[0-9]+)\.[0-9]+$/\1/' <<<"$stable")"
if [[ "$stable" == "$base" ]]; then next="$base.1"; else next="$base.$((${stable##*.} + 1))"; fi
minisign -G -W -p "$work/canary.pub" -s "$work/canary.key" >/dev/null
# testkeys: an installer trusting the throwaway keys (an installer from before the canary key trusts one).
testkeys() {
	sed -e "s|^PRISM_PUBLIC_KEY=.*|PRISM_PUBLIC_KEY=$(tail -n 1 "$work/other.pub")|" \
		-e "s|^PRISM_CANARY_PUBLIC_KEY=.*|PRISM_CANARY_PUBLIC_KEY=$(tail -n 1 "$work/canary.pub")|"
}
testkeys <"$ROOT/fork/scripts/install.sh" >"$work/install-testkey.sh"
# repack <version> [installer]: signed with the comment of the version's channel; the archive
# carries the throwaway-key installer, or the one given (what `prism update` will run).
repack() {
	local v=$1 dir="$work/repack/$1" out="$work/repacked/$1" comment="prism $1" key="$work/other.key"
	[[ ! -e "$out" ]] || return 0
	[[ "$v" != *.canary.* ]] || comment="prism $v canary" key="$work/canary.key"
	mkdir -p "$dir" "$out"
	tar -xzf "$rel/releases/$version/$archive" -C "$dir" --strip-components=1
	cp "${2:-$work/install-testkey.sh}" "$dir/install.sh"
	node -e 'const fs = require("fs"); const [file, v] = process.argv.slice(1); const pkg = JSON.parse(fs.readFileSync(file, "utf8")); pkg.version = v; fs.writeFileSync(file, JSON.stringify(pkg, null, "\t") + "\n");' \
		"$dir/node_modules/@earendil-works/pi-coding-agent/package.json" "$v"
	tar -czf "$out/prism-$v-linux-x64.tar.gz" -C "$work/repack" "$v"
	rm -rf -- "$dir"
	printf '## [%s] - test\n\n- notes for %s\n' "$v" "$v" >"$out/NOTES.md"
	(cd "$out" && sha256sum "prism-$v-linux-x64.tar.gz" NOTES.md >SHA256SUMS)
	minisign -S -s "$key" -m "$out/SHA256SUMS" -t "$comment" >/dev/null
}
repack "$stable"
repack "$next"
# site <name> <LATEST>: both releases, hard-linked, and the throwaway-key installer.
site() {
	mkdir -p "$srv/$1/releases"
	cp -al "$work/repacked/$stable" "$work/repacked/$next" "$srv/$1/releases/"
	printf '%s\n' "$2" >"$srv/$1/releases/LATEST"
	cp "$work/install-testkey.sh" "$srv/$1/install.sh"
}
# The installer of the first releases, which lays out no versions/.
git -C "$ROOT" show d2f060ff7:fork/scripts/install.sh >"$srv/legacy-install.sh"
site old "$stable"
site new "$next"
site newbad "$next"
cp --remove-destination "$work/repacked/$next/prism-$next-linux-x64.tar.gz" "$srv/newbad/releases/$next/"
flip_byte "$srv/newbad/releases/$next/prism-$next-linux-x64.tar.gz"
site newnotes "$next"
cp --remove-destination "$work/repacked/$next/NOTES.md" "$srv/newnotes/releases/$next/"
printf -- '- forged\n' >>"$srv/newnotes/releases/$next/NOTES.md"
site newsums "$next"
cp --remove-destination "$work/repacked/$next/SHA256SUMS" "$srv/newsums/releases/$next/"
sed -i "s/^[0-9a-f]*/$(printf "%064d" 0)/" "$srv/newsums/releases/$next/SHA256SUMS"
# mirror <name> <LATEST>: laid out as GitHub releases (latest/download/LATEST, download/prism-v<version>/).
mirror() {
	mkdir -p "$srv/$1/latest/download" "$srv/$1/download"
	printf '%s\n' "$2" >"$srv/$1/latest/download/LATEST"
	cp -al "$work/repacked/$2" "$srv/$1/download/prism-v$2"
}
mirror mirror "$next"
mirror mirrorbad "$next"
cp --remove-destination "$work/repacked/$next/prism-$next-linux-x64.tar.gz" "$srv/mirrorbad/download/prism-v$next/"
flip_byte "$srv/mirrorbad/download/prism-v$next/prism-$next-linux-x64.tar.gz"

# Release channels: stable S1 < canaries C1 < C2 < stable S2 (the next fork number).
s1=$stable
c1=$base.canary.1
c2=$base.canary.2
s2="${base%.*}.$((${base##*.} + 1))"
repack "$c1"
repack "$c2"
repack "$s2"
# chan <name> <LATEST> [LATEST-canary]: the channel releases and the throwaway-key installer.
chan() {
	mkdir -p "$srv/$1/releases"
	cp -al "$work/repacked/$s1" "$work/repacked/$c1" "$work/repacked/$c2" "$work/repacked/$s2" "$srv/$1/releases/"
	printf '%s\n' "$2" >"$srv/$1/releases/LATEST"
	[[ -z "${3:-}" ]] || printf '%s\n' "$3" >"$srv/$1/releases/LATEST-canary"
	cp "$work/install-testkey.sh" "$srv/$1/install.sh"
}
chan chan1 "$s1" "$c1"
chan chan2 "$s1" "$c2"
chan chan3 "$s2" "$c2"
# A canary listed as stable.
chan poison "$c1" "$c1"
# A stable release signed as canary, and a canary signed as stable: same files, other comment. Then each signed
# with the other channel's key, under its own comment.
# forge <name> <version> <comment> <key> <LATEST>: the forged version is newer than the installed one.
forge() {
	chan "$1" "$5" "$c2"
	rm -rf -- "$srv/$1/releases/$2"
	cp -a "$work/repacked/$2" "$srv/$1/releases/$2"
	minisign -S -s "$work/$4.key" -m "$srv/$1/releases/$2/SHA256SUMS" -t "$3" >/dev/null
}
forge stableascanary "$s2" "prism $s2 canary" other "$s2"
forge canaryasstable "$c2" "prism $c2" canary "$s1"
forge stablebycanarykey "$s2" "prism $s2" canary "$s2"
forge canarybystablekey "$c2" "prism $c2 canary" other "$s1"
# Maintenance releases: B = fork.N < M1 = N.1 < M2 < M10 < C1 < S2. B carries the installer
# published with fork.N when its tag exists, so the update to N.1 is the one users will run.
m1=$base.1
m2=$base.2
m10=$base.10
if git -C "$ROOT" rev-parse -q --verify "refs/tags/prism-v$base" >/dev/null; then
	base_installer_from="prism-v$base"
else
	base_installer_from="this checkout (no tag prism-v$base)"
fi
if [[ "$base_installer_from" == "prism-v$base" ]]; then
	git -C "$ROOT" show "prism-v$base:fork/scripts/install.sh"
else
	cat "$ROOT/fork/scripts/install.sh"
fi | testkeys >"$work/install-base.sh"
# A fork.N build repacked B with this checkout's installer for steps 5 and 6 (already served).
[[ "$stable" != "$base" ]] || rm -rf -- "$work/repacked/$base"
repack "$base" "$work/install-base.sh"
repack "$m1"
repack "$m2"
repack "$m10"
# maint <name> <LATEST> [LATEST-canary]: the maintenance releases and fork.N's installer.
maint() {
	mkdir -p "$srv/$1/releases"
	for v in "$base" "$m1" "$m2" "$m10" "$c1" "$s2"; do cp -al "$work/repacked/$v" "$srv/$1/releases/"; done
	printf '%s\n' "$2" >"$srv/$1/releases/LATEST"
	[[ -z "${3:-}" ]] || printf '%s\n' "$3" >"$srv/$1/releases/LATEST-canary"
	cp "$work/install-base.sh" "$srv/$1/install.sh"
}
maint mbase "$base"
maint m1 "$m1" "$c1"
maint m2 "$m2"
maint m10 "$m10"
maint mnext "$s2"
# M1 signed as canary; B's genuine signature replayed for M1; M1 signed with an untrusted key.
maint m1canary "$m1"
rm -rf -- "$srv/m1canary/releases/$m1" && cp -a "$work/repacked/$m1" "$srv/m1canary/releases/"
minisign -S -s "$work/other.key" -m "$srv/m1canary/releases/$m1/SHA256SUMS" -t "prism $m1 canary" >/dev/null
maint m1replay "$m1"
rm -rf -- "$srv/m1replay/releases/$m1" && cp -a "$work/repacked/$base" "$srv/m1replay/releases/$m1"
mv "$srv/m1replay/releases/$m1/prism-$base-linux-x64.tar.gz" "$srv/m1replay/releases/$m1/prism-$m1-linux-x64.tar.gz"
maint m1untrusted "$m1"
rm -rf -- "$srv/m1untrusted/releases/$m1" && cp -a "$work/repacked/$m1" "$srv/m1untrusted/releases/"
minisign -G -W -p "$work/third.pub" -s "$work/third.key" >/dev/null
minisign -S -s "$work/third.key" -m "$srv/m1untrusted/releases/$m1/SHA256SUMS" -t "prism $m1" >/dev/null

# The installer from before the channels, trusting the throwaway key.
git -C "$ROOT" show 16c88c610:fork/scripts/install.sh |
	sed "s|^PRISM_PUBLIC_KEY=.*|PRISM_PUBLIC_KEY=$(tail -n 1 "$work/other.pub")|" >"$srv/prechannel-install.sh"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost \
	-keyout "$work/tls.key" -out "$work/tls.pem" 2>/dev/null
python3 -c '
import functools, http.server, ssl, sys
port, root, cert, key = sys.argv[1:]
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
handler = functools.partial(Quiet, directory=root)
server = http.server.ThreadingHTTPServer(("127.0.0.1", int(port)), handler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)
server.socket = ctx.wrap_socket(server.socket, server_side=True)
server.serve_forever()
' "$port" "$srv" "$work/tls.pem" "$work/tls.key" &
server_pid=$!

if ! podman image exists "$image"; then
	podman build -q -t "$image" -f - "$work" >/dev/null <<'EOF'
FROM docker.io/library/debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates openssl && rm -rf /var/lib/apt/lists/*
EOF
fi

# Runs inside the container; $1 names the verifier.
cat >"$work/check.sh" <<'EOF'
set -eu
verifier=$1
base=https://localhost:$PORT
export CURL_CA_BUNDLE=/test/tls.pem PATH="$HOME/.local/bin:$PATH" PI_OFFLINE=1
ok() { printf 'ok (%s): %s\n' "$verifier" "$*"; }
fail() { printf 'FAIL (%s): %s\n' "$verifier" "$*" >&2; exit 1; }
install() { curl -fsSL "$base/install.sh" | PRISM_BASE_URL="$1" sh -s -- --channel "$CHANNEL"; }

! command -v pi >/dev/null && ! command -v prism >/dev/null || fail "pi or prism already present"
out=$(install "$base") || fail "install"
# Audit REL-06: this image's glibc (2.36) is older than the window's (2.39), so the install says so instead of
# listing WebKitGTK, which would not help.
printf '%s\n' "$out" | grep -q "the window (prism --gui) and the phone link need glibc 2.39 or newer.*this system has 2.36" ||
	fail "install on an old glibc does not say so: $out"
! printf '%s\n' "$out" | grep -q "WebKitGTK" || fail "install on an old glibc asks for WebKitGTK: $out"
# Nor bubblewrap, which the sandbox needs.
printf '%s\n' "$out" | grep -q "the sandbox for the agent's commands needs bubblewrap: sudo apt install bubblewrap" ||
	fail "install without bubblewrap does not name the command: $out"
# nor labwc, which the agent's desktop needs; named on a first install only.
printf '%s\n' "$out" | grep -q "the agent's desktop .* needs labwc: sudo apt install labwc" ||
	fail "install without labwc does not name the command: $out"
# Nor libei, which the portal helper needs (the user's desktop under GNOME and KDE), also named on a first install only.
printf '%s\n' "$out" | grep -q "under GNOME or KDE .* needs libraries this system does not have: .*libei.so.1" ||
	fail "install without libei does not say so: $out"
[ "$(prism --version)" = "$VERSION" ] || fail "prism --version"
cd /tmp && prism --no-session -e /test/fake-provider.ts --model fake/scripted -p md </dev/null | grep -q "Résumé" ||
	fail "print-mode prompt"
ok "installed $VERSION, prompt answered"
# The window: shipped, and the terminal stays the fallback. This image has no display and
# no WebKitGTK, so --gui says why and fails without a terminal; a plain prism -p never tries the window.
[ -x "$HOME/.local/share/prism/current/gui/prism-gui" ] || fail "the window is not in the release"
# The agent's desktop helper is shipped next to it.
[ -x "$HOME/.local/share/prism/current/desktop/prism-desktop-helper" ] ||
	fail "the desktop helper is not in the release"
if out=$(cd /tmp && prism --gui 2>&1 </dev/null); then fail "--gui without a display succeeded"; fi
printf '%s\n' "$out" | grep -q "No graphical display" || fail "--gui without a display: $out"
if out=$(cd /tmp && DISPLAY=:99 prism --gui 2>&1 </dev/null); then fail "--gui without WebKitGTK succeeded"; fi
printf '%s\n' "$out" | grep -q "The window could not open" || fail "--gui without WebKitGTK: $out"
ok "--gui falls back with its reason (no display, no WebKitGTK)"
install "$base" >/dev/null || fail "reinstall"
ok "reinstall"
mkdir -p "$HOME/.local/share/applications"
# The entry Prism writes carries its marker (launch-interface.ts); install.sh removes no other prism.desktop.
printf '[Desktop Entry]\nExec=%s --gui\nX-Prism-Menu=true\n' "$HOME/.local/bin/prism" >"$HOME/.local/share/applications/prism.desktop"
printf '[Desktop Entry]\nExec=%s --gui\nNoDisplay=true\nX-Prism-Portal=true\n' "$HOME/.local/bin/prism" \
	>"$HOME/.local/share/applications/space.odelserver.prism.gui.desktop"
sh /test/install.sh --uninstall >/dev/null
[ ! -e "$HOME/.local/share/prism" ] && [ ! -e "$HOME/.local/bin/prism" ] || fail "uninstall left files"
[ ! -e "$HOME/.local/share/applications/prism.desktop" ] || fail "uninstall left the menu entry"
[ ! -e "$HOME/.local/share/applications/space.odelserver.prism.gui.desktop" ] || fail "uninstall left the portal entry"
ok "uninstall, menu entry included"

for case in tamper sums otherkey replay; do
	if out=$(install "$base/$case" 2>&1); then fail "$case was installed"; fi
	[ ! -e "$HOME/.local/share/prism" ] && [ ! -e "$HOME/.local/bin/prism" ] || fail "$case left files"
	ok "$case refused: $(printf '%s\n' "$out" | tail -n 1)"
done
EOF

# The update channel, inside the container.
cat >"$work/check-update.sh" <<'EOF'
set -eu
base=https://localhost:$PORT
export CURL_CA_BUNDLE=/test/tls.pem PATH="$HOME/.local/bin:$PATH"
ok() { printf 'ok (update): %s\n' "$*"; }
fail() { printf 'FAIL (update): %s\n' "$*" >&2; exit 1; }
v() { prism --version; }
# refused <base url> <case>: the update fails and leaves the version alone.
refused() {
	before=$(v)
	if out=$(PRISM_BASE_URL=$1 prism update 2>&1); then fail "$2: update succeeded"; fi
	[ "$(v)" = "$before" ] || fail "$2 changed the version"
	ok "$2 refused: $(printf '%s\n' "$out" | tail -n 1)"
}

# The first installer takes the release as built from LATEST, signed with the real key: a stable build only.
if [ "$CHANNEL" = stable ]; then
	curl -fsSL "$base/legacy-install.sh" | PRISM_BASE_URL=$base sh >/dev/null || fail "install with the first installer"
fi
curl -fsSL "$base/old/install.sh" | PRISM_BASE_URL=$base/old sh >/dev/null || fail "install over it"
[ "$(v)" = "$OLD" ] && [ -L "$HOME/.local/share/prism/current" ] || fail "installed layout"
if [ "$CHANNEL" = stable ]; then
	ok "installed $OLD over a previous installation"
else
	ok "installed $OLD (canary build: the first installer's install is not tried)"
fi

PRISM_BASE_URL=$base/old prism update --check | grep -q "is up to date" || fail "check, up to date"
PRISM_BASE_URL=$base/new prism update --check | grep -q "$NEW is available" || fail "check, newer"
[ "$(v)" = "$OLD" ] || fail "--check changed the version"
ok "check"

refused "$base/newbad" "tampered archive"
refused "$base/newsums" "tampered SHA256SUMS"
refused "$base/newnotes" "tampered NOTES.md"
refused "https://localhost:1" "unreachable server"

out=$(PRISM_BASE_URL=$base/new prism update) || fail "update"
[ "$(v)" = "$NEW" ] || fail "updated version"
printf '%s\n' "$out" | grep -qx -- "- notes for $NEW" || fail "release notes not shown: $out"
# labwc is offered on a first install only; an update does not ask again.
! printf '%s\n' "$out" | grep -q "needs labwc" || fail "the update offered labwc again: $out"
! printf '%s\n' "$out" | grep -q "under GNOME or KDE" || fail "the update offered libei again: $out"
cd /tmp && PI_OFFLINE=1 prism --no-session -e /test/fake-provider.ts --model fake/scripted -p md </dev/null | grep -q "Résumé" ||
	fail "print-mode prompt after the update"
ok "updated $OLD -> $NEW, notes shown, prompt answered"

refused "$base/old" "older LATEST"

prism update --rollback >/dev/null && [ "$(v)" = "$OLD" ] || fail "rollback"
prism update --rollback >/dev/null && [ "$(v)" = "$NEW" ] || fail "undo the rollback"
[ "$(ls "$HOME/.local/share/prism/versions" | wc -l)" = 2 ] || fail "releases kept: $(ls "$HOME/.local/share/prism/versions")"
ok "rollback and undo, two releases kept"

# the site does not answer; the mirror serves the release, checked the same way. A test site given by
# PRISM_BASE_URL gets no mirror unless PRISM_MIRROR_URL names one ("unreachable server" above).
down=https://localhost:1
prism update --rollback >/dev/null && [ "$(v)" = "$OLD" ] || fail "rollback before the mirror"
before=$(v)
if out=$(PRISM_BASE_URL=$down PRISM_MIRROR_URL=$base/mirrorbad prism update 2>&1); then fail "tampered archive on the mirror: update succeeded"; fi
[ "$(v)" = "$before" ] || fail "tampered archive on the mirror changed the version"
ok "tampered archive on the mirror refused: $(printf '%s\n' "$out" | tail -n 1)"
PRISM_BASE_URL=$down PRISM_MIRROR_URL=$base/mirror prism update --check | grep -q "$NEW is available" || fail "check from the mirror"
out=$(PRISM_BASE_URL=$down PRISM_MIRROR_URL=$base/mirror prism update) || fail "update from the mirror: $out"
[ "$(v)" = "$NEW" ] || fail "update from the mirror: $(v)"
printf '%s\n' "$out" | grep -q "does not answer; downloading from the copy at $base/mirror" || fail "mirror not announced: $out"
printf '%s\n' "$out" | grep -qx -- "- notes for $NEW" || fail "notes not shown from the mirror: $out"
ok "site down: check and update $OLD -> $NEW from the mirror, notes shown"
EOF

# The release channels, inside the container.
cat >"$work/check-channels.sh" <<'EOF'
set -eu
base=https://localhost:$PORT
export CURL_CA_BUNDLE=/test/tls.pem PATH="$HOME/.local/bin:$PATH"
ok() { printf 'ok (channels): %s\n' "$*"; }
fail() { printf 'FAIL (channels): %s\n' "$*" >&2; exit 1; }
v() { prism --version; }
channel() { cat "$HOME/.local/share/prism/channel"; }
# refused <site> <case>: the update fails and leaves the version alone.
refused() {
	before=$(v)
	if out=$(PRISM_BASE_URL=$base/$1 prism update 2>&1); then fail "$2: update succeeded"; fi
	[ "$(v)" = "$before" ] || fail "$2 changed the version"
	ok "$2 refused: $(printf '%s\n' "$out" | tail -n 1)"
}
uninstall() { sh "$HOME/.local/share/prism/current/install.sh" --uninstall >/dev/null; }

# The installer from before the channels: LATEST only, and a canary listed there is refused.
curl -fsSL "$base/prechannel-install.sh" | PRISM_BASE_URL=$base/chan2 sh >/dev/null || fail "pre-channel install"
[ "$(v)" = "$S1" ] || fail "pre-channel installer took $(v)"
uninstall
if curl -fsSL "$base/prechannel-install.sh" | PRISM_BASE_URL=$base/poison sh >/dev/null 2>&1; then
	fail "the pre-channel installer installed a canary listed in LATEST"
fi
[ ! -e "$HOME/.local/share/prism" ] || fail "the refused pre-channel install left files"
ok "the installer from before the channels ignores LATEST-canary and refuses a canary in LATEST"

curl -fsSL "$base/chan2/install.sh" | PRISM_BASE_URL=$base/chan2 sh >/dev/null || fail "install"
[ "$(v)" = "$S1" ] && [ "$(channel)" = stable ] || fail "default install: $(v) $(channel)"
PRISM_BASE_URL=$base/chan2 prism update --check | grep -q "is up to date (stable channel)" || fail "stable check saw the canary"
ok "stable by default, LATEST-canary ignored"
refused poison "a canary listed in LATEST"
if out=$(curl -fsSL "$base/poison/install.sh" | PRISM_INSTALL_DIR=/tmp/poison PRISM_BASE_URL=$base/poison sh 2>&1); then
	fail "fresh install of a canary listed in LATEST"
fi
[ ! -e /tmp/poison ] || fail "the refused install left files"
ok "fresh install of a canary listed in LATEST refused: $(printf '%s\n' "$out" | tail -n 1)"
refused stableascanary "a stable release signed as canary"
refused stablebycanarykey "a stable release signed with the canary key"

mkdir -p "$HOME/.prism" && echo kept >"$HOME/.prism/marker"
out=$(PRISM_BASE_URL=$base/chan1 prism update --channel canary) || fail "switch to canary: $out"
[ "$(v)" = "$C1" ] && [ "$(channel)" = canary ] || fail "switch to canary: $(v) $(channel)"
printf '%s\n' "$out" | grep -qx -- "- notes for $C1" || fail "canary notes not shown: $out"
printf '%s\n' "$out" | grep -q "canary channel: experimental" || fail "canary warning not shown: $out"
ok "switched to canary $C1, notes and warning shown"
if out=$(PRISM_BASE_URL=https://localhost:1 PRISM_MIRROR_URL=$base/mirror prism update 2>&1); then
	fail "a canary installation updated from the mirror"
fi
[ "$(v)" = "$C1" ] || fail "the mirror changed a canary installation"
ok "canary: no mirror when the site does not answer: $(printf '%s\n' "$out" | tail -n 1)"
refused canaryasstable "a canary signed as stable"
refused canarybystablekey "a canary signed with the stable key"
PRISM_BASE_URL=$base/chan2 prism update >/dev/null && [ "$(v)" = "$C2" ] || fail "canary update to $C2"
ok "canary updated to $C2"
prism update --rollback >/dev/null && [ "$(v)" = "$C1" ] && [ "$(channel)" = canary ] || fail "rollback within canary"
prism update --rollback >/dev/null && [ "$(v)" = "$C2" ] || fail "undo the rollback"
ok "rollback within canary and undo"

out=$(PRISM_BASE_URL=$base/chan2 prism update --channel stable) || fail "back to stable: $out"
[ "$(v)" = "$S1" ] && [ "$(channel)" = stable ] || fail "back to stable: $(v) $(channel)"
printf '%s\n' "$out" | grep -q "going back from $C2 to $S1" || fail "the way back is not explained: $out"
[ "$(cat "$HOME/.prism/marker")" = kept ] || fail "~/.prism lost"
cd /tmp && PI_OFFLINE=1 prism --no-session -e /test/fake-provider.ts --model fake/scripted -p md </dev/null | grep -q "Résumé" ||
	fail "print-mode prompt after going back to stable"
ok "back to the older stable $S1, ~/.prism kept, prompt answered"
prism update --rollback >/dev/null && [ "$(v)" = "$C2" ] && [ "$(channel)" = canary ] || fail "rollback restores the canary channel"
prism update --rollback >/dev/null && [ "$(v)" = "$S1" ] && [ "$(channel)" = stable ] || fail "undo restores stable"
ok "rollback across the switch restores the channel"

PRISM_BASE_URL=$base/chan3 prism update >/dev/null && [ "$(v)" = "$S2" ] || fail "stable update to $S2"
out=$(PRISM_BASE_URL=$base/chan3 prism update --channel canary) && [ "$(v)" = "$S2" ] && [ "$(channel)" = canary ] ||
	fail "switch to canary when stable is newer: $(v) $(channel) $out"
PRISM_BASE_URL=$base/chan3 prism update | grep -q "up to date (canary channel)" || fail "canary should stay on the newer stable"
ok "a stable release newer than the last canary is canary's latest"
uninstall

curl -fsSL "$base/chan2/install.sh" | PRISM_BASE_URL=$base/chan2 sh -s -- --channel canary >/dev/null || fail "canary install"
[ "$(v)" = "$C2" ] && [ "$(channel)" = canary ] || fail "canary install: $(v) $(channel)"
ok "fresh install on the canary channel"
EOF

# Maintenance releases, inside the container.
cat >"$work/check-maintenance.sh" <<'EOF'
set -eu
base=https://localhost:$PORT
export CURL_CA_BUNDLE=/test/tls.pem PATH="$HOME/.local/bin:$PATH"
ok() { printf 'ok (maintenance): %s\n' "$*"; }
fail() { printf 'FAIL (maintenance): %s\n' "$*" >&2; exit 1; }
v() { prism --version; }
channel() { cat "$HOME/.local/share/prism/channel"; }
# refused <site> <case>: the update fails and leaves the version alone.
refused() {
	before=$(v)
	if out=$(PRISM_BASE_URL=$base/$1 prism update 2>&1); then fail "$2: update succeeded"; fi
	[ "$(v)" = "$before" ] || fail "$2 changed the version"
	ok "$2 refused: $(printf '%s\n' "$out" | tail -n 1)"
}
uninstall() { sh "$HOME/.local/share/prism/current/install.sh" --uninstall >/dev/null; }

curl -fsSL "$base/mbase/install.sh" | PRISM_BASE_URL=$base/mbase sh >/dev/null || fail "install $B"
[ "$(v)" = "$B" ] && [ "$(channel)" = stable ] || fail "installed $(v) $(channel)"
ok "installed $B with the installer of $BASE_INSTALLER"
PRISM_BASE_URL=$base/m1 prism update --check | grep -q "$M1 is available on the stable channel" || fail "check offers $M1"
refused m1canary "a maintenance release signed as canary"
refused m1replay "the signature of $B replayed for $M1"
refused m1untrusted "a maintenance release signed with an untrusted key"

out=$(PRISM_BASE_URL=$base/m1 prism update) || fail "update to $M1: $out"
[ "$(v)" = "$M1" ] && [ "$(channel)" = stable ] || fail "update to $M1: $(v) $(channel)"
printf '%s\n' "$out" | grep -qx -- "- notes for $M1" || fail "notes of $M1 not shown: $out"
cd /tmp && PI_OFFLINE=1 prism --no-session -e /test/fake-provider.ts --model fake/scripted -p md </dev/null | grep -q "Résumé" ||
	fail "print-mode prompt on $M1"
ok "updated $B -> $M1 by the installer of $BASE_INSTALLER, stable channel kept, notes shown, prompt answered"
refused mbase "the older $B listed in LATEST"
prism update --rollback >/dev/null && [ "$(v)" = "$B" ] && [ "$(channel)" = stable ] || fail "rollback to $B"
prism update --rollback >/dev/null && [ "$(v)" = "$M1" ] || fail "undo the rollback"
ok "rollback to $B and undo"

PRISM_BASE_URL=$base/m2 prism update >/dev/null && [ "$(v)" = "$M2" ] || fail "update to $M2"
PRISM_BASE_URL=$base/m10 prism update >/dev/null && [ "$(v)" = "$M10" ] || fail "update to $M10 (10 after 2)"
refused m2 "the older $M2 after $M10"
PRISM_BASE_URL=$base/mnext prism update >/dev/null && [ "$(v)" = "$S2" ] || fail "update to $S2"
ok "order $M1 < $M2 < $M10 < $S2"
uninstall

# This checkout's installer: one from does not know the canary key.
curl -fsSL "$base/chan1/install.sh" | PRISM_BASE_URL=$base/m1 sh -s -- --channel canary >/dev/null || fail "canary install"
[ "$(v)" = "$C1" ] && [ "$(channel)" = canary ] || fail "canary install: $(v) $(channel)"
PRISM_BASE_URL=$base/m1 prism update | grep -q "up to date (canary channel)" || fail "canary should keep $C1 over $M1"
ok "a canary installation keeps $C1, newer than $M1"
EOF

run() {
	podman run --rm --network host -e PORT="$port" -e VERSION="$version" -e CHANNEL="$channel" \
		-v "$work/check.sh:/test/check.sh:ro,Z" -v "$work/tls.pem:/test/tls.pem:ro,Z" \
		-v "$srv/install.sh:/test/install.sh:ro,Z" \
		-v "$ROOT/fork/tools/fake-provider.ts:/test/fake-provider.ts:ro,Z" "$@"
}
run "$image" sh /test/check.sh openssl
run -v "$(command -v minisign):/usr/local/bin/minisign:ro,Z" "$image" sh /test/check.sh minisign
run -e OLD="$stable" -e NEW="$next" -v "$work/check-update.sh:/test/check-update.sh:ro,Z" "$image" sh /test/check-update.sh
run -e S1="$s1" -e C1="$c1" -e C2="$c2" -e S2="$s2" -v "$work/check-channels.sh:/test/check-channels.sh:ro,Z" \
	"$image" sh /test/check-channels.sh
run -e B="$base" -e M1="$m1" -e M2="$m2" -e M10="$m10" -e C1="$c1" -e S2="$s2" -e BASE_INSTALLER="$base_installer_from" \
	-v "$work/check-maintenance.sh:/test/check-maintenance.sh:ro,Z" "$image" sh /test/check-maintenance.sh
echo "all release checks passed ($version)"
