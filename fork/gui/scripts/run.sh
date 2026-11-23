#!/usr/bin/env bash
# Launches the fork.10 window from this worktree, with the engine of this worktree (TypeScript sources,
# no build, no installation). It never replaces or modifies an installed Prism.
#
#   fork/gui/scripts/run.sh demo  [--cwd DIR]              scripted test model, throwaway profile
#   fork/gui/scripts/run.sh local URL MODEL [--cwd DIR]    an OpenAI-compatible server, throwaway profile
#   fork/gui/scripts/run.sh user  [--cwd DIR]              your own Prism configuration (~/.prism/agent)
#   fork/gui/scripts/run.sh empty [--cwd DIR]              no model configured, offline, throwaway profile
# Add --terminal to use the same engine and profile in the terminal instead of the window; no GUI build needed.
#
# demo, local and empty keep their profile (settings, sessions, models.json, the window's own storage) in
# ${PRISM_GUI_PROFILE_DIR:-~/.cache/prism-gui/profiles}/<mode>; delete it to start over.
# user reads and writes your real configuration exactly as the terminal does (a model chosen in the
# window becomes your default model, as with /model).
set -euo pipefail

GUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$GUI/../.." && pwd)"
BIN="${PRISM_GUI_BIN:-$GUI/src-tauri/target/release/prism-gui}"
mode="${1:-}"
shift || true

usage() {
	sed -n '5,8p' "${BASH_SOURCE[0]}" | sed 's/^# //'
	exit 2
}

url="" model=""
if [[ "$mode" == "local" ]]; then
	url="${1:-}" model="${2:-}"
	[[ -n "$url" && -n "$model" ]] || usage
	shift 2
fi

cwd="" terminal=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--cwd) cwd="$2"; shift 2 ;;
		--terminal) terminal=1; shift ;;
		*) usage ;;
	esac
done

[[ "$terminal" == 1 || -x "$BIN" ]] || { echo "build first: $GUI/scripts/build.sh" >&2; exit 1; }

resolver="$(node -p 'require("node:url").pathToFileURL(process.argv[1]).href' "$ROOT/packages/coding-agent/src/experimental/source-resolver.ts")"
args=(--import "$resolver" "$ROOT/packages/coding-agent/src/experimental/cli.ts")

# The source checkout is named pi. As a shipped Prism does (install-local.sh), the engine reads its name from
# a package.json named prism: links to the checkout's files beside that package.json, rebuilt at each start.
package="${XDG_CACHE_HOME:-$HOME/.cache}/prism-gui/package/$(basename "$ROOT")"
# That copy is not beside fork/: the agent's desktop gets this checkout's helper, once built
# (fork/desktop-helper/build.sh).
helper="$ROOT/fork/desktop-helper/build/prism-desktop-helper"
[[ -n "${PRISM_DESKTOP_HELPER:-}" || ! -x "$helper" ]] || export PRISM_DESKTOP_HELPER="$helper"
rm -rf "$package"
mkdir -p "$package"
for entry in "$ROOT/packages/coding-agent"/* "$ROOT/packages/coding-agent"/.[!.]*; do
	if [[ -e "$entry" && "$(basename "$entry")" != package.json ]]; then ln -s "$entry" "$package/"; fi
done
# /changelog shows Prism's notes, under the name install-local.sh gives them (src/fork/changelog.ts).
ln -s "$ROOT/fork/CHANGELOG.md" "$package/PRISM-CHANGELOG.md"
node -e '
const fs = require("node:fs");
const [from, to] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(from, "utf8"));
pkg.piConfig = { ...pkg.piConfig, name: "prism", configDir: ".prism" };
fs.writeFileSync(to, `${JSON.stringify(pkg, null, "\t")}\n`);
' "$ROOT/packages/coding-agent/package.json" "$package/package.json"
export PI_PACKAGE_DIR="$package"
# The version the engine reports (`prism --version`), which the window's settings show (as `prism --gui` gives it).
PRISM_GUI_PRODUCT_VERSION="$(node -p 'require(process.argv[1]).version' "$package/package.json")"
export PRISM_GUI_PRODUCT_VERSION

case "$mode" in
	demo | local | empty)
		profile="${PRISM_GUI_PROFILE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/prism-gui/profiles}/$mode"
		mkdir -p "$profile/agent" "$profile/work"
		# A scripted run (drive.sh, drive-gnome.sh): the scenarios were written for the "ask" permission mode, Prism's
		# default until 2026-11-18 (now "broad"), so a profile starts in it unless its scenario seeded its own
		# permissions (drive-all.sh). Audit of 2026-11-23, TESTS-17: run alone, those scenarios failed.
		if [[ -n "${PRISM_GUI_DRIVE:-}" && ! -f "$profile/agent/permissions.json" ]]; then
			echo '{"mode":"ask"}' >"$profile/agent/permissions.json"
		fi
		# The keyring stays off, as in the test suites: a throwaway profile never touches your keyring.
		export PI_CODING_AGENT_DIR="$profile/agent" PRISM_CODING_AGENT_DIR="$profile/agent" PRISM_SECRET_SERVICE=off
		export PRISM_GUI_DATA_DIR="$profile/webview"
		cwd="${cwd:-$profile/work}"
		if [[ "$mode" == "empty" ]]; then
			export PI_OFFLINE=1
		elif [[ "$mode" == "demo" ]]; then
			export PI_OFFLINE=1
			args+=(-e "$ROOT/fork/tools/fake-provider.ts" --model fake/scripted)
		else
			# As adding a server in Prism does: context, reasoning and the rest as the server reports them.
			node --import "$resolver" "$GUI/scripts/local-profile.ts" "$profile/agent/models.json" "$url" "$model"
			args+=(--model "local/$model")
		fi
		echo "profile: $profile" >&2
		;;
	user)
		# The source checkout is named pi; a shipped Prism uses .prism and the PRISM_ override.
		prism_agent_dir="${PRISM_CODING_AGENT_DIR:-$HOME/.prism/agent}"
		export PI_CODING_AGENT_DIR="$prism_agent_dir" PRISM_CODING_AGENT_DIR="$prism_agent_dir"
		;;
	*) usage ;;
esac

if [[ "$terminal" == 1 ]]; then
	cd "${cwd:-$PWD}"
	exec node "${args[@]}"
fi

export PRISM_GUI_ENGINE=node
PRISM_GUI_ENGINE_ARGS="$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- "${args[@]}")"
export PRISM_GUI_ENGINE_ARGS
exec "$BIN" ${cwd:+--cwd "$cwd"}
