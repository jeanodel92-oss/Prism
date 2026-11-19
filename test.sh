#!/usr/bin/env bash
set -euo pipefail

# fork: run the suite in a memory-capped scope without swap, so a runaway test is killed instead of
# swapping the whole machine to a halt. PI_TEST_MEMORY_MAX overrides the default;
# without a systemd user session (CI), the suite runs as before.
if [[ -z "${PI_TEST_SCOPED-}" ]] && command -v systemd-run >/dev/null && systemd-run --user --scope -q true 2>/dev/null; then
	exec env PI_TEST_SCOPED=1 systemd-run --user --scope -q -p "MemoryMax=${PI_TEST_MEMORY_MAX:-6G}" \
		-p MemorySwapMax=0 -- "$0" "$@"
fi

# fork: Node's file watchers need inotify instances, limited per user (fs.inotify.max_user_instances). When another
# program has used them up, the watcher tests fail
# after the whole run; stop at once instead and say who holds them. The suite used 10 at its peak;
# PI_TEST_INOTIFY_MIN sets the minimum free.
if [[ -r /proc/sys/fs/inotify/max_user_instances ]]; then
	inotify_max="$(cat /proc/sys/fs/inotify/max_user_instances)"
	inotify_holders="$(find /proc/[0-9]*/fd -lname anon_inode:inotify 2>/dev/null | cut -d/ -f3 || true)"
	inotify_used="$(printf '%s' "$inotify_holders" | grep -c . || true)"
	if (( inotify_max - inotify_used < ${PI_TEST_INOTIFY_MIN:-16} )); then
		printf 'test.sh: only %d of %d inotify instances are free; the file-watcher tests would fail.\n' \
			"$((inotify_max - inotify_used))" "$inotify_max" >&2
		printf 'Held by:\n' >&2
		printf '%s\n' "$inotify_holders" | sort | uniq -c | sort -rn | head -5 | while read -r count pid; do
			printf '  %4d  %s (pid %s)\n' "$count" "$(cat "/proc/$pid/comm" 2>/dev/null || echo '?')" "$pid" >&2
		done
		printf 'Restart the top holder, or raise fs.inotify.max_user_instances.\n' >&2
		exit 1
	fi
fi

# Isolate user resources, credentials, temporary files, and tool configuration.
temp_parent="${TMPDIR:-/tmp}"
temp_parent="${temp_parent%/}"
test_root="$(mktemp -d "$temp_parent/pi-test.XXXXXX")"
git_askpass="$(type -P false)"
readonly temp_parent test_root git_askpass

mkdir -p "$test_root/home/.config" "$test_root/tmp" "$test_root/cache/npm"
# Mark the generated root so cleanup can verify ownership before deleting it.
touch "$test_root/.pi-test-owned" "$test_root/npm-userconfig" "$test_root/npm-globalconfig"

# Only remove the marked directory created above, never an unverified path.
cleanup() {
	local status=$?
	trap - EXIT

	case "$test_root" in
		"$temp_parent"/pi-test.*)
			if [[ -d "$test_root" && ! -L "$test_root" && -f "$test_root/.pi-test-owned" ]]; then
				rm -rf -- "$test_root"
			else
				printf "Refusing to remove unverified test directory: %s\n" "$test_root" >&2
				[[ $status -ne 0 ]] || status=1
			fi
			;;
		*)
			printf "Refusing to remove unexpected test directory: %s\n" "$test_root" >&2
			[[ $status -ne 0 ]] || status=1
			;;
	esac

	# fork: report missing real-sandbox coverage even when another suite failed.
	if ! command -v bwrap >/dev/null || ! bwrap --unshare-all --die-with-parent --ro-bind / / --proc /proc --dev /dev --tmpfs /tmp true >/dev/null 2>&1; then
		printf 'WARNING: real-sandbox suites were skipped: bubblewrap is missing or cannot start a sandbox.\n' >&2
	fi

	exit "$status"
}
trap cleanup EXIT

# Start from an empty environment and allow only required platform and test settings.
test_env=(
	"PATH=$PATH"
	"PWD=$PWD"
	"HOME=$test_root/home"
	"USERPROFILE=$test_root/home"
	"TMPDIR=$test_root/tmp"
	"TMP=$test_root/tmp"
	"TEMP=$test_root/tmp"
	"XDG_CONFIG_HOME=$test_root/home/.config"
	"XDG_CACHE_HOME=$test_root/cache"
	"LANG=C"
	"LC_ALL=C"
	"TZ=UTC"
	"GIT_CONFIG_NOSYSTEM=1"
	"GIT_CONFIG_GLOBAL=/dev/null"
	"GIT_TERMINAL_PROMPT=0"
	"GIT_ASKPASS=$git_askpass"
	"GIT_EDITOR=true"
	"GIT_SEQUENCE_EDITOR=true"
	"NPM_CONFIG_USERCONFIG=$test_root/npm-userconfig"
	"NPM_CONFIG_GLOBALCONFIG=$test_root/npm-globalconfig"
	"NPM_CONFIG_CACHE=$test_root/cache/npm"
	"PI_NO_LOCAL_LLM=1"
	"AWS_EC2_METADATA_DISABLED=true"
)

# Native Windows needs these inherited values to launch child processes.
for name in SystemRoot SYSTEMROOT WINDIR COMSPEC PATHEXT; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

# Preserve CI detection only for runner behavior and test reporting.
for name in CI GITHUB_ACTIONS; do
	value="${!name-}"
	[[ -z "$value" ]] || test_env+=("$name=$value")
done

echo "Running tests without API keys in isolated home: $test_root/home"
env -i "${test_env[@]}" npm test
