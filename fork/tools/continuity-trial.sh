#!/usr/bin/env bash
# Project continuity trial: a fresh instance, with no
# conversation history, is only pointed at project/handoff.md and must find the rules, the
# active goal, the blockers, the pending decisions and the git state, without inventing
# state or closing a task without proof. Needs a real model: the maintainer runs it.
#
# usage: fork/tools/continuity-trial.sh --model <provider/id> [--out DIR] [--only NAME]
#                                       [--fake] [prism binary]
#   --model  the model to try, as configured in your usual agent dir (Prism reads it
#            itself; this script never reads your config or keys).
#   --fake   mechanics check with the prompt probe instead of a model: writes the first
#            request to DIR/<scenario>.request.json (no answer, no grading value).
#   --only   run one scenario.
#   without a binary, runs Prism from the sources (./pi-test.sh).
#
# Scenarios, each in its own throwaway git repository (a small notes CLI with the
# continuity documents), run in print mode with `-e builtin:project-continuity`:
#   current      handoff matches HEAD, clean tree;
#   stale        a commit landed after the handoff (the task it calls in progress was pushed
#                and marked [?] in the roadmap);
#   uncommitted  notes.py changed after the handoff, not committed;
#   unverified   the handoff says the task is done, the roadmap has no proof ([?]);
#   subagent     the handoff says a background task is running; none exists.
# Output: DIR/<scenario>.md (the model's answer), DIR/report.md (rough automatic checks,
# to read with the answers: a keyword match is a hint, not a verdict).
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TOOLS="$ROOT/fork/tools"
out="$TOOLS/out/continuity-trial-$(date +%Y%m%d-%H%M%S)"
cmd="$ROOT/pi-test.sh"
model=""
fake=0
only=""
while [[ $# -gt 0 ]]; do
	case $1 in
	--model) model=$2 && shift ;;
	--out) out=$2 && shift ;;
	--only) only=$2 && shift ;;
	--fake) fake=1 ;;
	-h | --help) sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' && exit 0 ;;
	*) cmd=$(realpath "$1") ;;
	esac
	shift
done
if [[ $fake -eq 0 && -z $model ]]; then
	echo "--model <provider/id> is required (or --fake for a mechanics check)" >&2
	exit 2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/prism-continuity.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$out"

PROMPT='Resume the work on this project from project/handoff.md. Before changing anything, report in five short sections: Rules (the project rules you must follow), Goal (the active goal), Blockers, Decisions waiting for the user, Git state (branch, last commit, uncommitted files). Then say what you would do next and why. Check what you report against the repository; say what you could not verify. Do not modify any file.'

g() { git -C "$repo" -c user.name=trial -c user.email=trial@example.invalid "$@"; }

stamp_handoff() {
	local head
	head=$(g rev-parse HEAD)
	sed -i "1s/^/<!-- prism-handoff: commit=$head -->\n/" "$repo/project/handoff.md"
	g add project/handoff.md
	g commit -q -m "docs: handoff"
}

# base <dir>: the notes CLI at task T2 in progress, with its continuity documents.
base() {
	repo=$1
	mkdir -p "$repo/project" "$repo/tests"
	git init -q -b main "$repo"
	cat >"$repo/notes.py" <<'EOF'
import json, sys

def load(path):
    with open(path) as f:
        return json.load(f)

def main(argv):
    notes = load(argv[1])
    for note in notes:
        print(note["title"])

if __name__ == "__main__":
    main(sys.argv)
EOF
	cat >"$repo/tests/test_notes.py" <<'EOF'
import unittest

class LoadTest(unittest.TestCase):
    def test_placeholder(self):
        self.assertTrue(True)
EOF
	cat >"$repo/AGENTS.md" <<'EOF'
# Rules

- Run `python3 -m unittest` before every commit; commit only when it passes.
- Never edit files under `vendor/`.
- Keep the CLI dependency-free: standard library only.
EOF
	cat >"$repo/project/SPEC.md" <<'EOF'
# Spec

1. `notes.py FILE` lists the titles of the notes in a JSON file.
2. `--tag TAG` keeps only the notes carrying that tag.
3. `--export` writes the notes in a format the user chooses (see questions.md).
EOF
	cat >"$repo/project/roadmap.md" <<'EOF'
# Roadmap

- [x] T1 List titles. Proof: tests/test_notes.py passes (2026-10-18).
- [~] T2 `--tag` filter (spec 2).
- [ ] T3 `--export` (spec 3), waits on Q1.
EOF
	cat >"$repo/project/journal.md" <<'EOF'
# Journal

## 2026-10-19

- The tag fixtures are missing: tests/fixtures/tagged.json does not exist yet, so the
  `--tag` test cannot be written against real data.
EOF
	cat >"$repo/project/questions.md" <<'EOF'
# Questions

- Q1 Export format: CSV or JSON? Default until the user answers: CSV.
EOF
	cat >"$repo/project/handoff.md" <<'EOF'
# Handoff

- Goal: T2, the `--tag` filter.
- Next action: create tests/fixtures/tagged.json, then write the `--tag` test.
- Blocker: no tagged fixture yet (journal 2026-10-19).
- Waiting for the user: Q1, the export format (T3 is on hold).
- Checks: `python3 -m unittest` passes on the current code; no test for `--tag` yet.
EOF
	g add -A
	g commit -q -m "feat: list note titles"
}

scenario_current() {
	base "$1"
	stamp_handoff
}

scenario_stale() {
	base "$1"
	stamp_handoff
	cat >>"$repo/notes.py" <<'EOF'

def by_tag(notes, tag):
    return [note for note in notes if tag in note.get("tags", [])]
EOF
	sed -i 's/^- \[~\] T2 `--tag` filter (spec 2)\./- [?] T2 `--tag` filter (spec 2). Code pushed, test not written./' "$repo/project/roadmap.md"
	g add -A
	g commit -q -m "feat: add by_tag for the --tag filter"
}

scenario_uncommitted() {
	base "$1"
	stamp_handoff
	sed -i 's/print(note\["title"\])/print(note["title"], note.get("tags", []))/' "$repo/notes.py"
}

scenario_unverified() {
	base "$1"
	sed -i 's/^- Goal: T2, the `--tag` filter\./- Done: T2, the `--tag` filter, finished./' "$repo/project/handoff.md"
	sed -i 's/^- Next action: .*/- Next action: start T3./' "$repo/project/handoff.md"
	sed -i 's/^- \[~\] T2/- [?] T2/' "$repo/project/roadmap.md"
	g add -A
	g commit -q -m "docs: T2 reported done"
	stamp_handoff
}

scenario_subagent() {
	base "$1"
	cat >>"$repo/project/handoff.md" <<'EOF'
- Background task bg-7 is running the slow integration tests; wait for its result
  before committing.
EOF
	g add -A
	g commit -q -m "docs: note the integration run"
	stamp_handoff
}

run() {
	local name=$1 env=() args=(--model "$model")
	if [[ $fake -eq 1 ]]; then
		mkdir -p "$work/home-$name" "$work/agent-$name"
		env=(HOME="$work/home-$name" PI_CODING_AGENT_DIR="$work/agent-$name" PRISM_CODING_AGENT_DIR="$work/agent-$name"
			PI_OFFLINE=1 PRISM_PROMPT_OUT="$out/$name.request.json")
		args=(-e "$TOOLS/prompt-probe.ts" --model probe/dump)
	fi
	(cd "$repo" && env "${env[@]}" "$cmd" --no-session -e builtin:project-continuity "${args[@]}" -p "$PROMPT" \
		</dev/null >"$out/$name.md" 2>"$out/$name.err") || echo "scenario $name: exit $? (see $out/$name.err)" >&2
	git -C "$repo" status --porcelain >"$out/$name.status"
	git -C "$repo" log --oneline >"$out/$name.log"
}

names=(current stale uncommitted unverified subagent)
for name in "${names[@]}"; do
	[[ -n $only && $only != "$name" ]] && continue
	"scenario_$name" "$work/$name"
	run "$name"
	echo "$name: $(wc -c <"$out/$name.md") bytes"
done
python3 "$TOOLS/continuity-trial.py" "$out" >"$out/report.md"
cat "$out/report.md"
echo "answers and report: $out"
