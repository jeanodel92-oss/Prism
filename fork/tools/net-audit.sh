#!/usr/bin/env bash
# Outgoing connection audit: which hosts Prism tries to reach during
# a plain session with a local model, without letting anything leave the machine.
#
# usage: fork/tools/net-audit.sh [--out file.log] [--cloud-key] [prism binary]
#   without a binary, runs pi from the sources (./pi-test.sh).
#   --cloud-key  also set a fake ANTHROPIC_API_KEY, as a user with a cloud provider
#                would have; no request can reach Anthropic (no network, no prompt).
#
# How: the session runs in a private network namespace (unshare -rn) where only
# loopback exists, so no packet leaves the machine; DNS still answers through the
# systemd-resolved socket. A small LD_PRELOAD library (fork/tools/netlog.c, built
# with gcc on the fly) logs every getaddrinfo() name and connect() address of every
# process, children included. The model is fork/tools/fake-openai-server.py on
# 127.0.0.1, configured in models.json like any local server. PI_OFFLINE is not set.
#
# Scenario, in tmux at 100x40, with an empty agent dir and a throwaway HOME:
# startup, /model (selector opened, then closed), one prompt answered by the local
# model, /settings (opened, then closed), quit.
# Output: the raw log and a summary of distinct names and addresses.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
TOOLS="$ROOT/fork/tools"
out="$TOOLS/out/net-audit-$(date +%Y%m%d-%H%M%S).log"
cmd="$ROOT/pi-test.sh"
port=18099
cloud_env=""
while [[ $# -gt 0 ]]; do
	case $1 in
	--out) out=$2 && shift ;;
	--cloud-key) cloud_env="ANTHROPIC_API_KEY=sk-ant-fake-key-for-audit" ;;
	-h | --help) sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' && exit 0 ;;
	*) cmd=$(realpath "$1") ;;
	esac
	shift
done

work="$(mktemp -d "${TMPDIR:-/tmp}/prism-net.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$(dirname "$out")" "$work/home" "$work/agent" "$work/ws"
gcc -shared -fPIC -O2 -o "$work/netlog.so" "$TOOLS/netlog.c" -ldl
cat >"$work/agent/models.json" <<EOF
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:$port/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "models": [{ "id": "fake-local" }]
    }
  }
}
EOF
: >"$out"

# Everything below runs inside the namespace: loopback up, model server, tmux, Prism.
cat >"$work/inner.sh" <<'EOF'
set -euo pipefail
ip link set lo up
python3 "$TOOLS/fake-openai-server.py" --port "$port" --reply "Bonjour depuis le serveur local." 2>/dev/null &
server=$!
sleep 1
tmux -L prism-net -f /dev/null new-session -d -s audit -x 100 -y 40 -c "$work/ws" \
	env HOME="$work/home" PI_CODING_AGENT_DIR="$work/agent" PRISM_CODING_AGENT_DIR="$work/agent" \
	NETLOG_OUT="$out" LD_PRELOAD="$work/netlog.so" $cloud_env "$cmd" --model local/fake-local
keys() { tmux -L prism-net send-keys -t audit "$@"; }
sleep 10
keys -l "/model" && keys Enter && sleep 3 && keys Escape && sleep 1
keys -l "hello" && keys Enter && sleep 6
keys -l "/settings" && keys Enter && sleep 3 && keys Escape && sleep 1
tmux -L prism-net capture-pane -t audit -p >"$work/screen.txt"
keys C-d && sleep 2
tmux -L prism-net kill-server 2>/dev/null || true
kill "$server" 2>/dev/null || true
EOF
env TOOLS="$TOOLS" port="$port" work="$work" out="$out" cmd="$cmd" cloud_env="$cloud_env" unshare -rn bash "$work/inner.sh"

grep -q "Bonjour depuis le serveur local" "$work/screen.txt" || {
	echo "the local model did not answer; screen:" >&2
	cat "$work/screen.txt" >&2
	exit 1
}
echo "names resolved:"
awk '$2 == "resolve" {print "  " $3}' "$out" | sort | uniq -c
echo "addresses connected (unix sockets excluded):"
awk '$2 == "connect" && $3 !~ /^unix:/ {print "  " $3}' "$out" | sort | uniq -c
echo "log: $out"
