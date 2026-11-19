#!/usr/bin/env bash
# Acceptance check for --safe, in a throwaway HOME so the real
# user config is never touched.
#
# usage: fork/tools/test-safe-mode.sh [prism binary]
#   without argument, runs pi from the sources (./pi-test.sh).
#
# The agent dir gets an extension that throws while loading and a prompt
# template `/probe`, then:
#   1. a normal start reports the error, suggests --safe and exits non-zero;
#   2. `--safe` starts, announces itself and completes a prompt with the fake provider;
#   3. `--safe` sends `/probe` as typed: the template is not loaded.
# The broken-theme case needs the TUI.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cmd=("${1:-$ROOT/pi-test.sh}")
home="$(mktemp -d "${TMPDIR:-/tmp}/prism-safe-test.XXXXXX")"
trap 'rm -rf -- "$home"' EXIT

fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}
ok() { printf 'ok: %s\n' "$*"; }
run() { (cd "$home" && env HOME="$home" PI_OFFLINE=1 "${cmd[@]}" "$@" </dev/null 2>&1); }

# Agent dir is ~/.pi/agent from the sources and ~/.prism/agent in a built prism binary.
for dir in .pi .prism; do
	mkdir -p "$home/$dir/agent/extensions"
	printf 'throw new Error("broken on purpose");\nexport default function () {}\n' >"$home/$dir/agent/extensions/broken.ts"
	mkdir -p "$home/$dir/agent/prompts"
	printf 'expanded probe template\n' >"$home/$dir/agent/prompts/probe.md"
done

prompt=(--no-session -e "$ROOT/fork/tools/fake-provider.ts" --model fake/scripted -p md)

if out="$(run "${prompt[@]}")"; then
	fail "normal start succeeded despite the broken extension: $out"
fi
grep -q 'Failed to load extension.*broken.ts' <<<"$out" || fail "normal start did not report the broken extension: $out"
grep -q -- '--safe' <<<"$out" || fail "normal start does not suggest --safe: $out"
ok "normal start reports the broken extension and suggests --safe"

out="$(run --safe "${prompt[@]}")" || fail "safe mode failed: $out"
grep -q 'Safe mode:' <<<"$out" || fail "safe mode not announced: $out"
grep -q 'Résumé' <<<"$out" || fail "fake provider answer missing: $out"
ok "--safe starts, announces itself and completes a prompt"

out="$(run --safe --no-session -e "$ROOT/fork/tools/fake-provider.ts" --model fake/scripted --mode json -p /probe)" ||
	fail "safe mode json run failed: $out"
grep -q '"text":"/probe"' <<<"$out" || fail "prompt not sent as typed: $out"
if grep -q 'expanded probe template' <<<"$out"; then fail "prompt template loaded in safe mode"; fi
ok "--safe does not load prompt templates"
