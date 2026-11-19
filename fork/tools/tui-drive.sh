#!/usr/bin/env bash
# Drive pi's interactive mode in tmux with the scripted fake provider and save
# captures (ANSI text, plus PNG when Chrome is available). Test tooling only.
#
# usage: fork/tools/tui-drive.sh <name> <cols> <rows> <action>...
#   t:<text>   type literal text          k:<key>   tmux key (Enter, Escape, C-o, …)
#   s:<sec>    sleep                      c:<label> capture visible screen
#   C:<label>  capture with 300 lines of scrollback
#
# env:
#   PI_CMD        command that starts pi (default: ./pi-test.sh from the repo root, i.e. from source)
#   PI_AGENT_DIR  agent dir to use (default: a fresh empty one, so no user config leaks in)
#   PI_EXTRA_ARGS extra pi arguments; paths must be absolute (pi runs in a temp workspace),
#                 e.g. PI_EXTRA_ARGS="-e $PWD/fork/reference/pi-prism/extensions/index.ts"
#   OUT           output dir (default: fork/tools/out)
#   NO_PNG=1      skip PNG rendering
#
# The fake provider answers a prompt containing "slow" with a long thinking
# stream, one containing "md" with markdown only, and anything else (e.g.
# "fais le tour") with thinking, text and tool calls (read, bash, grep, edit,
# write, find). Every run starts from a fresh temp workspace and agent dir.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TOOLS="$ROOT/fork/tools"
OUT="${OUT:-$TOOLS/out}"
PI_CMD="${PI_CMD:-$ROOT/pi-test.sh}"
name=$1 cols=$2 rows=$3
shift 3

WS="$(mktemp -d "${TMPDIR:-/tmp}/pi-drive-ws.XXXXXX")"
AGENT="${PI_AGENT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/pi-drive-agent.XXXXXX")}"
mkdir -p "$OUT" "$WS/src"
printf 'export function add(a: number, b: number): number {\n  return a + b; // TODO overflow\n}\n\nexport const VERSION = "1.0.0";\n' >"$WS/sample.ts"
printf 'alpha\nbeta\n' >"$WS/data.txt"
printf 'export {};\n' >"$WS/src/index.ts"

session="pi-drive-$$"
tmux kill-session -t "$session" 2>/dev/null || true
tmux new-session -d -s "$session" -x "$cols" -y "$rows" -c "$WS" \
	"env COLORTERM=truecolor PI_CODING_AGENT_DIR='$AGENT' PRISM_CODING_AGENT_DIR='$AGENT' PI_OFFLINE=1 $PI_CMD --no-session -e '$TOOLS/fake-provider.ts' --model fake/scripted ${PI_EXTRA_ARGS:-}; sleep 30"

shots=()
for a in "$@"; do
	case "$a" in
	t:*) tmux send-keys -t "$session" -l "${a#t:}" ;;
	k:*) tmux send-keys -t "$session" "${a#k:}" ;;
	s:*) sleep "${a#s:}" ;;
	c:*) tmux capture-pane -t "$session" -e -N -p >"$OUT/$name-${a#c:}.ans" && shots+=("${a#c:}") ;;
	C:*) tmux capture-pane -t "$session" -e -N -p -S -300 >"$OUT/$name-${a#C:}.ans" && shots+=("${a#C:}") ;;
	*) echo "unknown action: $a" >&2 ;;
	esac
done
tmux kill-session -t "$session" 2>/dev/null || true
rm -rf "$WS"

for n in "${shots[@]}"; do
	if [[ -z "${NO_PNG:-}" ]]; then
		python3 "$TOOLS/ansi2png.py" "$OUT/$name-$n.ans" "$OUT/$name-$n.png" "$cols" || echo "png skipped for $n" >&2
	fi
	echo "$OUT/$name-$n.ans"
done
