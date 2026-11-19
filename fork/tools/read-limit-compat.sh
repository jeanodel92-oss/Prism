#!/usr/bin/env bash
# Compatibility of the read limit: the matrix of § 9.2 replayed in
# Prism's real sandbox, proxy included, with `sandbox.read.limit = "project"`. Needs the network; not part of
# ./test.sh.
#
# usage: fork/tools/read-limit-compat.sh [--read all] [--no-managers] [--keep] [--out file.jsonl]
#   --read all     the same matrix without the limit: tells the limit's failures from the sandbox's own.
#   --no-managers  do not clone nvm and pyenv into the throwaway home folder (network, about 30 MB).
#   --keep         keep the throwaway folders, to look at them afterwards.
#
# The home folder is throwaway, in /var/tmp (the sandbox replaces /tmp): the toolchains found in the real one are
# copied into it (reflinks where the file system has them), only their program folders, never a settings or a
# credentials file: ~/.rustup, ~/.cargo/bin, ~/.local/npm, ~/.bun, ~/.local/bin/{uv,uvx,mise}, ~/.local/share/mise and
# ~/.config/mise (the tools mise installed, Go among them). Git gets a throwaway
# identity in ~/.gitconfig. nvm and pyenv, unless --no-managers, are cloned fresh, with a Node version installed by
# nvm and the system's Python registered as a pyenv version (a venv in ~/.pyenv/versions).
#
# Each scenario writes one JSON line (default fork/tools/out/read-limit-compat-<host>-<date>.jsonl); a summary is
# printed at the end. Runs under a 4 GB memory cap, without swap.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
out="$ROOT/fork/tools/out/read-limit-compat-$(hostname -s)-$(date +%Y%m%d-%H%M%S).jsonl"
managers=1
read=project
keep=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--read) read="$2"; shift ;;
		--no-managers) managers=0 ;;
		--keep) keep=1 ;;
		--out) out="$2"; shift ;;
		*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
	shift
done

base="$(mktemp -d /var/tmp/prism-compat-XXXXXX)"
home="$base/home"
cleanup() { if [[ $keep == 0 ]]; then rm -rf "$base"; else echo "kept: $base"; fi; }
trap cleanup EXIT
mkdir -p "$home" "$base/runner-home" "$(dirname "$out")"
: > "$out"

copy() {
	local from="$HOME/$1"
	[[ -e $from ]] || return 0
	mkdir -p "$(dirname "$home/$1")"
	cp -a --reflink=auto "$from" "$home/$1"
}
for path in .rustup .cargo/bin .local/npm .bun .local/bin/uv .local/bin/uvx .local/bin/mise .local/share/mise .config/mise; do
	copy "$path"
done
printf '[user]\n\tname = Compat Test\n\temail = compat@example.invalid\n' > "$home/.gitconfig"
# No cache folder (~/.npm, ~/.cargo/registry, ~/.cache): Prism makes the absent ones (tool-caches.ts).

if [[ $managers == 1 ]]; then
	git clone -q --depth 1 https://github.com/nvm-sh/nvm.git "$home/.nvm"
	# nvm.sh reads unset variables and fails under `set -u`.
	(set +u; export HOME="$home" NVM_DIR="$home/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install --no-progress 22 >/dev/null; nvm alias default 22 >/dev/null)
	git clone -q --depth 1 https://github.com/pyenv/pyenv.git "$home/.pyenv"
	python3 -m venv "$home/.pyenv/versions/system-venv"
	echo system-venv > "$home/.pyenv/version"
	# The shims, as `pyenv install` leaves them.
	HOME="$home" PYENV_ROOT="$home/.pyenv" "$home/.pyenv/bin/pyenv" rehash
fi

echo "home folder: $home"
echo "toolchains: $(cd "$home" && find . -maxdepth 3 -name bin -o -maxdepth 3 -name uv | sort | tr '\n' ' ')"

cd "$ROOT/packages/coding-agent"
status=0
HOME="$base/runner-home" PRISM_COMPAT_HOME="$home" PRISM_COMPAT_OUT="$out" PRISM_COMPAT_READ="$read" \
	timeout 3600 systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 -- \
	node ../../node_modules/vitest/dist/cli.js --run --testTimeout=900000 test/fork-read-limit-compat.test.ts || status=$?

echo
echo "results: $out"
python3 - "$out" <<'EOF'
import json, sys
for line in open(sys.argv[1]):
    row = json.loads(line)
    detail = row.get("missing") or (row.get("error") or [""])[-1:] or ""
    seconds = f'{row["seconds"]} s' if "seconds" in row else ""
    asked = f'{len(row["questions"])} q' if "questions" in row else ""
    print(f'{row["result"]:7} {seconds:>6} {asked:>4}  {row["scenario"]}  {" ".join(detail) if isinstance(detail, list) else detail}')
EOF
exit $status
