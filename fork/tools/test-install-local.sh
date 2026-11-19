#!/usr/bin/env bash
# Acceptance check for fork/scripts/install-local.sh, in a throwaway
# HOME so the real user config is never touched.
#
# usage: fork/tools/test-install-local.sh [install-local options]
#   e.g. fork/tools/test-install-local.sh --runtime bun
#
# Checks, in order:
#   1. install: `prism --version` prints the fork version;
#   2. a print-mode prompt answered by the fake provider;
#   2b. in the TUI (tmux), an ask_user_question call shows its dialog and returns the
#      answer (the prebundled plugin used to hang there);
#   3. no file created outside ~/.local/share/prism, ~/.local/bin/prism, ~/.prism
#      (Bun's own runtime cache in ~/.bun, filled by the compile step, is allowed);
#   4. reinstall over an existing install works;
#   5. uninstall removes the binary and the link and keeps ~/.prism.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
home="$(mktemp -d "${TMPDIR:-/tmp}/prism-install-test.XXXXXX")"
# npm writes logs and a cache under $HOME while building; keep them out of the
# checked HOME so the check only sees what the install and Prism create.
npm_dir="$(mktemp -d "${TMPDIR:-/tmp}/prism-install-npm.XXXXXX")"
trap 'rm -rf -- "$home" "$npm_dir"' EXIT

fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}
ok() { printf 'ok: %s\n' "$*"; }
in_home() {
	env HOME="$home" PI_OFFLINE=1 PATH="$home/.local/bin:$PATH" \
		npm_config_cache="$npm_dir/cache" npm_config_logs_dir="$npm_dir/logs" npm_config_update_notifier=false "$@"
}

snapshot() { (cd "$home" && find . -mindepth 1 | sort); }
before="$(snapshot)"

in_home "$ROOT/fork/scripts/install-local.sh" "$@" >/dev/null
prism="$home/.local/bin/prism"
[[ -L "$prism" && -x "$prism" ]] || fail "missing link $prism"

version="$(in_home prism --version </dev/null)"
[[ "$version" =~ -fork\.[0-9]+$ ]] || fail "unexpected version: $version"
ok "prism --version -> $version"

answer="$(cd "$home" && in_home prism --no-session -e "$ROOT/fork/tools/fake-provider.ts" --model fake/scripted -p "md" </dev/null)"
grep -q "Résumé" <<<"$answer" || fail "fake provider answer missing: $answer"
ok "print-mode prompt answered"

question='{"questions":[{"question":"Pick one","header":"Pick","options":[{"label":"Alpha","description":"First"},{"label":"Beta","description":"Second"}]}]}'
drive_out="$(mktemp -d "${TMPDIR:-/tmp}/prism-install-drive.XXXXXX")"
PI_CMD="env HOME=$home PI_OFFLINE=1 $prism" PI_EXTRA_ARGS="--perm-mode broad" NO_PNG=1 OUT="$drive_out" \
	"$ROOT/fork/tools/tui-drive.sh" ask 100 40 s:8 k:Escape s:1 "t:call ask_user_question $question" k:Enter s:4 \
	c:dialog k:Enter s:4 C:answered >/dev/null 2>&1
plain() { sed 's/\x1b\[[0-9;:]*m//g;s/\x1b_[^\x07]*\x07//g;s/\x1b\][^\x07]*\x07//g' "$1"; }
grep -q "Alpha" <(plain "$drive_out/ask-dialog.ans") || fail "ask_user_question dialog not shown"
tr -d '\n' <"$drive_out/ask-answered.ans" | sed 's/\x1b\[[0-9;:]*m//g' | grep -q 'answered your questions' ||
	fail "ask_user_question answer not returned"
rm -rf -- "$drive_out"
ok "ask_user_question dialog shown and answered"

unexpected="$(comm -13 <(printf '%s\n' "$before") <(snapshot) | grep -v -E '^\./(\.local|\.local/share|\.local/bin|\.local/share/prism(/.*)?|\.local/bin/prism|\.prism(/.*)?|\.bun(/.*)?)$' || true)"
[[ -z "$unexpected" ]] || fail "files outside the allowed paths: $unexpected"
ok "no file outside ~/.local/share/prism, ~/.local/bin/prism, ~/.prism"

# Reinstall from the build just made: same options, --skip-build exactly once.
reinstall_args=(--skip-build)
for arg in "$@"; do [[ "$arg" == --skip-build ]] || reinstall_args+=("$arg"); done
in_home "$ROOT/fork/scripts/install-local.sh" "${reinstall_args[@]}" >/dev/null
[[ "$(in_home prism --version)" == "$version" ]] || fail "reinstall changed the version"
ok "reinstall over an existing install"

in_home "$ROOT/fork/scripts/install-local.sh" --uninstall >/dev/null
[[ ! -e "$home/.local/bin/prism" && ! -e "$home/.local/share/prism" ]] || fail "uninstall left files"
[[ -d "$home/.prism" ]] || fail "uninstall removed ~/.prism"
ok "uninstall keeps ~/.prism"
