#!/usr/bin/env bash
# Build Prism from this checkout and install it for the current user, without sudo.
#
# usage: fork/scripts/install-local.sh [--runtime node|bun] [--skip-build] [--fork-number N] [--maintenance P | --canary M]
#        fork/scripts/install-local.sh --uninstall
#
#   --runtime node        default: run Prism with Node (2 to 2.6 times less render time per token than the Bun binary, journal)
#                         
#   --runtime bun         install the standalone binary compiled by Bun instead
#   --skip-build          reuse the packages already built in this checkout (dist/)
#   --fork-number N       version suffix, <upstream>-fork.N (default 1)
#   --maintenance P       stable maintenance release of fork.N, <upstream>-fork.N.P (node only)
#   --canary M            canary version, <upstream>-fork.N.canary.M (node only)
#   --uninstall           remove the installation and its link
#
# Installs into $PRISM_INSTALL_DIR (default ~/.local/share/prism) and links
# $PRISM_BIN_DIR/prism (default ~/.local/bin/prism). The user config in ~/.prism is
# never touched. The build always uses the committed model data snapshot, the one CI
# tested (refreshed by .github/workflows/model-catalog-refresh.yml), never the network.
#
# node: packs the built packages and installs them with npm, as an npm user would
# get them (third-party dependencies pinned by npm-shrinkwrap.json, from the npm cache
# or the registry; no lifecycle scripts), adds the vendored plugins, and writes a
# `prism` launcher bound to the Node found at install time (>= 22.19).
# bun: compiles the standalone linux-x64 binary (scripts/build-binaries.sh).
#
# Needs Node, npm dependencies installed (npm ci --ignore-scripts), and Bun for --runtime bun.
set -euo pipefail

# One literal word for sh: in single quotes, each quote written '\''.
shell_word() {
	printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
INSTALL_DIR="${PRISM_INSTALL_DIR:-$HOME/.local/share/prism}"
# A relative directory is taken from where the command runs: the link in BIN_DIR needs an absolute target
#.
[[ $INSTALL_DIR == /* ]] || INSTALL_DIR="$PWD/$INSTALL_DIR"
BIN_DIR="${PRISM_BIN_DIR:-$HOME/.local/bin}"
MARKER=".prism-install"

say() { printf 'install-local: %s\n' "$*"; }
die() {
	printf 'install-local: %s\n' "$*" >&2
	exit 1
}

runtime=node
skip_build=false
fork_number=1
canary=""
maintenance=""
uninstall=false
while [[ $# -gt 0 ]]; do
	case $1 in
	--runtime)
		runtime=${2:?--runtime needs a value}
		shift
		;;
	--skip-build) skip_build=true ;;
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
	--uninstall) uninstall=true ;;
	-h | --help)
		sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*) die "unknown option: $1 (see --help)" ;;
	esac
	shift
done

[[ "$fork_number" =~ ^[1-9][0-9]*$ ]] || die "fork number must be a positive integer, got '$fork_number'"
if [[ -n "$canary" ]]; then
	[[ "$canary" =~ ^[1-9][0-9]*$ ]] || die "canary number must be a positive integer, got '$canary'"
	[[ "$runtime" == node ]] || die "--canary needs --runtime node"
fi
if [[ -n "$maintenance" ]]; then
	[[ "$maintenance" =~ ^[1-9][0-9]*$ ]] || die "maintenance number must be a positive integer, got '$maintenance'"
	[[ -z "$canary" ]] || die "--maintenance and --canary do not combine: a maintenance release is stable"
	[[ "$runtime" == node ]] || die "--maintenance needs --runtime node"
fi
version_suffix="$fork_number${maintenance:+.$maintenance}${canary:+.canary.$canary}"

# Remove a previous installation, but only a directory this script created.
remove_install_dir() {
	[[ -e "$INSTALL_DIR" ]] || return 0
	[[ -f "$INSTALL_DIR/$MARKER" ]] || die "$INSTALL_DIR exists but was not created by this script; remove it yourself"
	rm -rf -- "$INSTALL_DIR"
}

# Remove the link, but only if it points into the installation directory.
remove_link() {
	local link="$BIN_DIR/prism"
	[[ -e "$link" || -L "$link" ]] || return 0
	[[ -L "$link" && "$(readlink "$link")" == "$INSTALL_DIR/"* ]] || die "$link is not a link created by this script; remove it yourself"
	rm -f -- "$link"
}

if [[ "$uninstall" == true ]]; then
	remove_link
	remove_install_dir
	say "removed $INSTALL_DIR and $BIN_DIR/prism; your config in ~/.prism is kept"
	exit 0
fi

[[ "$runtime" == node || "$runtime" == bun ]] || die "unknown runtime: $runtime (node or bun)"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || die "only linux-x64 is supported"
command -v node >/dev/null || die "node is required"
if [[ "$runtime" == bun ]]; then
	command -v bun >/dev/null || die "bun is required to compile the binary (https://bun.sh)"
else
	node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' ||
		die "node >= 22.19 is required, found $(node --version)"
fi
[[ -d "$ROOT/node_modules" ]] || die "dependencies are missing; run: npm ci --ignore-scripts"
if [[ -e "$BIN_DIR/prism" && ! -L "$BIN_DIR/prism" ]]; then
	die "$BIN_DIR/prism exists and is not a link created by this script; remove it yourself"
fi

build_dir="$(mktemp -d "${TMPDIR:-/tmp}/prism-build.XXXXXX")"

# Stage next to the target, then swap, so a failed copy never leaves a broken install.
staging="$INSTALL_DIR.new.$$"
rm -rf -- "$staging"
mkdir -p "$(dirname "$INSTALL_DIR")"
# the installation being replaced is moved aside, never removed, until the new one is in
# place; leaving early (an error, Ctrl-C) puts it back.
previous=""
trap 'rm -rf -- "$build_dir" "$staging"; [[ -z "$previous" || -e "$INSTALL_DIR" ]] || mv -T -- "$previous" "$INSTALL_DIR"' EXIT

if [[ "$runtime" == bun ]]; then
	build_args=(--skip-install --offline-model-data --platform linux-x64 --out "$build_dir")
	[[ "$skip_build" == true ]] && build_args+=(--skip-build)
	say "building linux-x64 binary"
	"$ROOT/scripts/build-binaries.sh" "${build_args[@]}" >"$build_dir.log" 2>&1 || {
		tail -20 "$build_dir.log" >&2
		die "build failed, full log in $build_dir.log"
	}
	rm -f -- "$build_dir.log"
	"$ROOT/fork/scripts/brand-binary.sh" "$build_dir/linux-x64" "$fork_number" >/dev/null
	cp -a "$build_dir/linux-x64" "$staging"
	# the Prism browser extension, which /browser setup points to.
	cp -a "$ROOT/packages/coding-agent/browser-extension" "$staging/"
	# fork: /changelog shows Prism's release notes.
	cp "$ROOT/fork/RELEASE-NOTES.md" "$staging/PRISM-CHANGELOG.md"
	package_json="$INSTALL_DIR/package.json"
else
	if [[ "$skip_build" != true ]]; then
		say "building packages"
		(cd "$ROOT" && npm run build:offline) >"$build_dir.log" 2>&1 || {
			tail -20 "$build_dir.log" >&2
			die "build failed, full log in $build_dir.log"
		}
	fi
	say "installing packages for node"
	(cd "$ROOT" && node fork/scripts/node-install.mjs "$staging" "$build_dir/tarballs") >"$build_dir.log" 2>&1 || {
		tail -20 "$build_dir.log" >&2
		die "install failed, full log in $build_dir.log"
	}
	rm -f -- "$build_dir.log"
	package_dir="$staging/node_modules/@earendil-works/pi-coding-agent"
	# fork: vendored third-party plugins are not part of the npm package.
	cp -a "$ROOT/packages/coding-agent/vendor" "$package_dir/"
	# the Prism browser extension, which /browser setup points to.
	cp -a "$ROOT/packages/coding-agent/browser-extension" "$package_dir/"
	# fork: /changelog shows Prism's release notes.
	cp "$ROOT/fork/RELEASE-NOTES.md" "$package_dir/PRISM-CHANGELOG.md"
	# one file per plugin whose import resolution is slow (see the script).
	node "$ROOT/fork/scripts/prebundle-vendored.mjs" "$package_dir/vendor/node_modules" "$package_dir/vendor/prebundled"
	# Same identity as brand-binary.sh: command, config dir and version.
	node -e '
const fs = require("node:fs");
const [path, forkNumber] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
pkg.piConfig = { ...pkg.piConfig, name: "prism", configDir: ".prism" };
pkg.version = `${pkg.version.replace(/-fork\.\d+(\.\d+)?(\.canary\.\d+)?$/, "")}-fork.${forkNumber}`;
fs.writeFileSync(path, `${JSON.stringify(pkg, null, "\t")}\n`);
' "$package_dir/package.json" "$version_suffix"
	node_bin="$(node -p process.execPath)"
	# each path as one literal shell word, so the launcher does not expand `$` or a quote
	# in the install folder again.
	printf '#!/bin/sh\nexec %s %s "$@"\n' "$(shell_word "$node_bin")" \
		"$(shell_word "$INSTALL_DIR/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")" >"$staging/prism"
	chmod +x "$staging/prism"
	package_json="$INSTALL_DIR/node_modules/@earendil-works/pi-coding-agent/package.json"
fi

touch "$staging/$MARKER"
if [[ -e "$INSTALL_DIR" ]]; then
	[[ -f "$INSTALL_DIR/$MARKER" ]] || die "$INSTALL_DIR exists but was not created by this script; remove it yourself"
	previous="$INSTALL_DIR.old.$$"
	mv -T -- "$INSTALL_DIR" "$previous"
fi
mv -T -- "$staging" "$INSTALL_DIR"
[[ -z "$previous" ]] || rm -rf -- "$previous"
previous=""

mkdir -p "$BIN_DIR"
ln -sfn "$INSTALL_DIR/prism" "$BIN_DIR/prism"

say "installed prism $(node -p "require(process.argv[1]).version" "$package_json") ($runtime) in $INSTALL_DIR"
say "command: $BIN_DIR/prism"
case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*) say "$BIN_DIR is not in your PATH; add it to run 'prism' directly" ;;
esac
