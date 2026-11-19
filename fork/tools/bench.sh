#!/usr/bin/env bash
# Baseline performance measurements, reproducible, with the fake
# provider and a throwaway agent dir. Drives the interactive TUI in tmux.
#
# usage: fork/tools/bench.sh [--series N] [--launches N] [--out file.json]
#                             [--settings file.json] [--startup-only] [--sizes "50 1000"]
#                             [prism binary]
#   without a binary, runs pi from the sources (./pi-test.sh).
#   --settings      copied as settings.json into each throwaway agent dir, e.g. to
#                   turn modules off (compare the same build with and without).
#   --startup-only  skip the transcript runs.
#   --sizes         transcript lengths in messages (default "50 1000"), e.g. "50 1000 5000 20000"
#                   to see how the streaming cost grows with the context.
#
# For each series, each TUI mode (fullscreen, regular), at 100x40:
#   - startup: N launches with an empty agent dir and no transcript; time to the
#     first frame (ms since process start) and RSS 3 s after it;
#   - for transcripts of 50 and 1000 messages, or --sizes (fork/tools/bench-transcript.py):
#     time to first frame and RSS after loading, then one "bench" prompt streamed
#     by the fake provider (776 deltas of 4 characters, ~1 token each), with
#     the per-delta render cost, frame time and message update time (p50, p95);
#   - one "work" launch: 20 keys typed 150 ms apart (time from each key to the
#     next frame), then 3 rounds of one turn per tool (read, grep, find, ls, bash, write,
#     edit, enabled with --tools, in --perm-mode broad, in a throwaway workspace): per
#     turn, the harness's own time (wall time minus the fake provider and the tool), and
#     each tool's time, one tool at a time.
# Measured inside the process by fork/tools/bench-probe.ts. Writes one JSON file
# (default fork/tools/out/bench-<date>.json) and prints a summary.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TOOLS="$ROOT/fork/tools"
series=3
launches=10
out="$TOOLS/out/bench-$(date +%Y%m%d-%H%M%S).json"
cmd="$ROOT/pi-test.sh"
settings=""
startup_only=0
sizes="50 1000"
while [[ $# -gt 0 ]]; do
	case $1 in
	--series) series=$2 && shift ;;
	--launches) launches=$2 && shift ;;
	--out) out=$2 && shift ;;
	--settings) settings=$(realpath "$2") && shift ;;
	--startup-only) startup_only=1 ;;
	--sizes) sizes=$2 && shift ;;
	-h | --help) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' && exit 0 ;;
	*) cmd=$(realpath "$1") ;;
	esac
	shift
done

work="$(mktemp -d "${TMPDIR:-/tmp}/prism-bench.XXXXXX")"
session="prism-bench-$$"
trap 'tmux kill-session -t "$session" 2>/dev/null || true; rm -rf -- "$work"' EXIT
mkdir -p "$work/ws" "$work/runs" "$(dirname "$out")"
python3 "$TOOLS/bench-report.py" --conditions >"$work/runs/conditions-start.json"
for n in $sizes; do python3 "$TOOLS/bench-transcript.py" "$n" "$work/transcript-$n.jsonl" "$work/ws"; done
# The work runs' workspace: a 2000-line file, a small tree, a file the edits rewrite.
mkdir -p "$work/ws-tools/src"
for i in $(seq 1 2000); do echo "line $i of the sample file"; done >"$work/ws-tools/sample.txt"
for i in $(seq 1 50); do echo "export const value$i = $i;" >"$work/ws-tools/src/m$i.ts"; done
# One call per turn, so a tool's time is not shared with others running in parallel.
work_calls=(
	'read {"path":"sample.txt"}'
	'grep {"pattern":"line 1","path":"."}'
	'find {"pattern":"*.ts"}'
	'ls {"path":"src"}'
	'bash {"command":"true"}'
	'write {"path":"out.txt","content":"x"}'
	'edit {"path":"edit.txt","edits":[{"oldText":"v{round}","newText":"v{next}"}]}'
)
work_rounds=3

# wait_for <file> <key> <timeout s>: until the probe has written that record.
wait_for() {
	local i
	for ((i = 0; i < $3 * 10; i++)); do
		[[ -s $1 ]] && python3 -c 'import json,sys; sys.exit(0 if sys.argv[2] in json.load(open(sys.argv[1])) else 1)' "$1" "$2" 2>/dev/null && return 0
		sleep 0.1
	done
	echo "timeout waiting for $2 in $1" >&2
	return 1
}

# run <result file> <tui mode> [transcript]: one launch, plus a streamed prompt with a transcript.
run() {
	local result=$1 mode=$2 transcript=${3:-} agent session_args=(--no-session)
	agent="$(mktemp -d "$work/agent.XXXXXX")"
	[[ -z $settings ]] || cp "$settings" "$agent/settings.json"
	if [[ -n $transcript ]]; then
		# Not in the agent dir: a startup migration moves *.jsonl found at its root.
		cp "$transcript" "$agent.session.jsonl"
		session_args=(--session "$agent.session.jsonl")
	fi
	tmux new-session -d -s "$session" -x 100 -y 40 -c "$work/ws" \
		env COLORTERM=truecolor PI_CODING_AGENT_DIR="$agent" PRISM_CODING_AGENT_DIR="$agent" PI_OFFLINE=1 \
		PRISM_BENCH_OUT="$result" "$cmd" "${session_args[@]}" --tui-mode "$mode" \
		-e "$TOOLS/fake-provider.ts" -e "$TOOLS/bench-probe.ts" --model fake/scripted
	wait_for "$result" startup 60
	if [[ -n $transcript ]]; then
		tmux send-keys -t "$session" -l "bench"
		tmux send-keys -t "$session" Enter
		wait_for "$result" stream 120
	fi
	tmux kill-session -t "$session"
	rm -rf -- "$agent" "$agent.session.jsonl"
}

# count_turns <file>: turns recorded so far by the probe.
count_turns() {
	python3 -c 'import json,sys
try: print(len(json.load(open(sys.argv[1])).get("turns", [])))
except Exception: print(0)' "$1"
}

# run_work <result file> <tui mode>: key latency, then tool turns.
run_work() {
	local result=$1 mode=$2 agent i k=0 round call
	agent="$(mktemp -d "$work/agent.XXXXXX")"
	[[ -z $settings ]] || cp "$settings" "$agent/settings.json"
	echo v0 >"$work/ws-tools/edit.txt"
	tmux new-session -d -s "$session" -x 100 -y 40 -c "$work/ws-tools" \
		env COLORTERM=truecolor PI_CODING_AGENT_DIR="$agent" PRISM_CODING_AGENT_DIR="$agent" PI_OFFLINE=1 \
		PRISM_BENCH_OUT="$result" PRISM_BENCH_KEYS=20 "$cmd" --no-session --tui-mode "$mode" --perm-mode broad \
		--tools read,grep,find,ls,bash,write,edit \
		-e "$TOOLS/fake-provider.ts" -e "$TOOLS/bench-probe.ts" --model fake/scripted
	wait_for "$result" startup 60
	for ((i = 0; i < 20; i++)); do
		tmux send-keys -t "$session" -l x
		sleep 0.15
	done
	wait_for "$result" input 10
	for ((i = 0; i < 20; i++)); do tmux send-keys -t "$session" BSpace; done
	for ((round = 0; round < work_rounds; round++)); do
		for call in "${work_calls[@]}"; do
			# edit.txt holds v0, then v1, ...
			call=${call//\{round\}/$round}
			call=${call//\{next\}/$((round + 1))}
			tmux send-keys -t "$session" -l "call $call"
			tmux send-keys -t "$session" Enter
			for ((i = 0; i < 600; i++)); do
				[[ $(count_turns "$result") -gt $k ]] && break
				sleep 0.1
			done
			[[ $(count_turns "$result") -gt $k ]] || {
				echo "timeout waiting for turn $k in $result" >&2
				return 1
			}
			k=$((k + 1))
		done
	done
	tmux kill-session -t "$session"
	rm -rf -- "$agent"
}

for ((s = 1; s <= series; s++)); do
	for mode in fullscreen regular; do
		for ((l = 1; l <= launches; l++)); do
			run "$work/runs/s$s-$mode-startup-$l.json" "$mode"
		done
		for n in $sizes; do
			[[ $startup_only -eq 0 ]] || continue
			run "$work/runs/s$s-$mode-t$n.json" "$mode" "$work/transcript-$n.jsonl"
		done
		[[ $startup_only -eq 1 ]] || run_work "$work/runs/s$s-$mode-work.json" "$mode"
		echo "series $s/$series, $mode: done" >&2
	done
done

python3 "$TOOLS/bench-report.py" "$work/runs" "$series" "$launches" "$cmd" >"$out"
python3 "$TOOLS/bench-report.py" --summary "$out"
echo "report: $out"
