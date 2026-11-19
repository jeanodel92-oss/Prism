#!/usr/bin/env bash
# Prompt cost per part: what pi sends to the model on the first
# request, broken down into system prompt sections, context files, skills and tool
# definitions, with a local estimate and, optionally, exact counts.
#
# usage: fork/tools/prompt-cost.sh [--out file.json] [--tokenize-url URL]
#                                  [--agent-dir DIR --cwd DIR] [prism binary]
#   without a binary, runs pi from the sources (./pi-test.sh).
#   --tokenize-url  llama.cpp server (e.g. http://127.0.0.1:8080): exact token
#                   counts per part for that server's model.
#   --agent-dir/--cwd  also measure an existing config (scenario "custom"). It is
#                   used read-only by pi as its agent dir; nothing is copied.
#   --modules "a b"  also measure each built-in module turned off: one run
#                   with the default settings ("modules-on"), then one per module
#                   with `-builtin:<name>` ("off:<name>"); the summary lists what
#                   each module adds to the prompt.
#
# Scenarios, each in print mode with the probe provider (fork/tools/prompt-probe.ts),
# a throwaway HOME and an empty working directory unless stated:
#   default    empty agent dir: the vanilla prompt and built-in tools;
#   safe       same with --safe;
#   fixture    one context file (AGENTS.md) and one skill, to show the fixed and
#              per-item cost of those sections;
#   reference  fork/reference/APPEND_SYSTEM.md and the extensions of
#              fork/reference/extensions/;
#   custom     only with --agent-dir and --cwd;
#   modules-on, off:<name>  only with --modules.
# Output: one JSON report (default fork/tools/out/prompt-cost-<date>.json) and a summary.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TOOLS="$ROOT/fork/tools"
out="$TOOLS/out/prompt-cost-$(date +%Y%m%d-%H%M%S).json"
cmd="$ROOT/pi-test.sh"
tokenize=()
custom_agent=""
custom_cwd=""
modules=()
while [[ $# -gt 0 ]]; do
	case $1 in
	--out) out=$2 && shift ;;
	--tokenize-url) tokenize=(--tokenize-url "$2") && shift ;;
	--agent-dir) custom_agent=$(realpath "$2") && shift ;;
	--cwd) custom_cwd=$(realpath "$2") && shift ;;
	--modules) read -ra modules <<<"$2" && shift ;;
	-h | --help) sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' && exit 0 ;;
	*) cmd=$(realpath "$1") ;;
	esac
	shift
done
if [[ -n $custom_agent && -z $custom_cwd ]] || [[ -z $custom_agent && -n $custom_cwd ]]; then
	echo "--agent-dir and --cwd go together" >&2
	exit 2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/prism-prompt.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$(dirname "$out")"

# probe <name> <agent dir> <cwd> [pi args...]: dump the first request of one prompt.
probe() {
	local name=$1 agent=$2 dir=$3
	shift 3
	mkdir -p "$work/home"
	(cd "$dir" && env HOME="$work/home" PI_CODING_AGENT_DIR="$agent" PRISM_CODING_AGENT_DIR="$agent" PI_OFFLINE=1 \
		PRISM_PROMPT_OUT="$work/$name.json" "$cmd" --no-session -e "$TOOLS/prompt-probe.ts" --model probe/dump "$@" \
		-p "hi" </dev/null >/dev/null 2>"$work/$name.err") || {
		echo "scenario $name failed:" >&2
		cat "$work/$name.err" >&2
		exit 1
	}
	[[ -s "$work/$name.json" ]] || {
		echo "scenario $name: no request recorded" >&2
		exit 1
	}
	dumps+=("$name=$work/$name.json")
}

dumps=()
mkdir -p "$work/ws"
for name in default safe fixture reference; do mkdir -p "$work/agent-$name"; done

probe default "$work/agent-default" "$work/ws"
probe safe "$work/agent-safe" "$work/ws" --safe

mkdir -p "$work/fixture-ws" "$work/agent-fixture/skills/release-notes"
cat >"$work/fixture-ws/AGENTS.md" <<'EOF'
# Project rules

- Run the tests before committing.
- Keep functions short and named after what they return.
EOF
cat >"$work/agent-fixture/skills/release-notes/SKILL.md" <<'EOF'
---
name: release-notes
description: Write release notes from the git log since the last tag, grouped by Added, Changed and Fixed.
---

# Release notes

Read `git log <last tag>..HEAD`, group the commits, write one line each.
EOF
probe fixture "$work/agent-fixture" "$work/fixture-ws"

cp "$ROOT/fork/reference/APPEND_SYSTEM.md" "$work/agent-reference/"
extension_args=()
for f in "$ROOT"/fork/reference/extensions/*.ts; do extension_args+=(-e "$f"); done
probe reference "$work/agent-reference" "$work/ws" "${extension_args[@]}"

if [[ -n $custom_agent ]]; then
	probe custom "$custom_agent" "$custom_cwd"
fi

if [[ ${#modules[@]} -gt 0 ]]; then
	# Same path length for every agent dir: the path appears in the prompt.
	mkdir -p "$work/mod/000"
	probe modules-on "$work/mod/000" "$work/ws"
	for i in "${!modules[@]}"; do
		dir=$(printf '%s/mod/%03d' "$work" $((i + 1)))
		mkdir -p "$dir"
		printf '{"extensions": ["-builtin:%s"]}\n' "${modules[$i]}" >"$dir/settings.json"
		probe "off:${modules[$i]}" "$dir" "$work/ws"
	done
fi

python3 "$TOOLS/prompt-cost.py" "${tokenize[@]}" "${dumps[@]}" >"$out"
python3 "$TOOLS/prompt-cost.py" --summary "$out"
echo "report: $out"
