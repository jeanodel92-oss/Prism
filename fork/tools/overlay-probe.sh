#!/bin/sh
# Can this machine give a sandboxed command an overlay of a folder, without root? (overlay availability under AppArmor and bubblewrap restrictions.)
#  Not part of
# ./test.sh; throwaway folders only, removed at the end.
#
# usage: fork/tools/overlay-probe.sh
#
# Three ways, each checked by its result (reads see the lower folder, writes land in the upper one, the lower
# folder is unchanged, the command has no capability, cannot unmount the overlay nor write the upper folder):
#   bwrap-overlay   bubblewrap's own --overlay-src/--overlay (bubblewrap 0.10 or later).
#   unshare         a plain user namespace (util-linux unshare), as Ubuntu's AppArmor userns restriction sees it.
#   nested-bwrap    an outer bubblewrap keeps CAP_SYS_ADMIN and CAP_DAC_OVERRIDE in its own user namespace,
#                   mounts the overlay (mount(2) through python3 here: util-linux mount refuses a non-root uid),
#                   drops its capabilities, then an inner unprivileged bubblewrap runs the command on it.
#                   The outer one shows the host's /dev: with --dev, mount(2) of the overlay gets EPERM.
set -u
d=$(mktemp -d)
trap 'chmod -R u+rwx "$d" 2>/dev/null; rm -rf "$d"' EXIT

echo "bubblewrap: $(bwrap --version 2>&1 | head -1)"
echo "kernel: $(uname -r)"
[ -r /etc/os-release ] && echo "system: $(. /etc/os-release && echo "$PRETTY_NAME")"
if [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
	echo "apparmor_restrict_unprivileged_userns: $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)"
fi

fresh() {
	rm -rf "$d/lower" "$d/upper" "$d/work" "$d/dest"
	mkdir -p "$d/lower" "$d/upper" "$d/work" "$d/dest"
	echo base > "$d/lower/a"
}

# The command run on the overlay, in the sandbox.
inside="grep -q '^CapEff:[[:space:]]*0*$' /proc/self/status || echo capabilities
	[ \"\$(cat '$d/dest/a')\" = base ] || echo unread
	echo new > '$d/dest/b'; echo changed > '$d/dest/a'
	umount '$d/dest' 2>/dev/null && echo unmounted
	(echo x > '$d/upper/y') 2>/dev/null && echo upper-writable
	true"

# Prints "works" or what went wrong, from the command's output and the folders.
verdict() {
	if [ -n "$1" ]; then echo "fails: $(echo "$1" | head -1)"; return; fi
	[ "$(cat "$d/lower/a")" = base ] || { echo "fails: the lower folder changed"; return; }
	[ -f "$d/lower/b" ] && { echo "fails: the lower folder changed"; return; }
	[ "$(cat "$d/upper/a" 2>/dev/null)" = changed ] && [ -f "$d/upper/b" ] || { echo "fails: writes not in the upper folder"; return; }
	echo works
}

fresh
if bwrap --help 2>&1 | grep -q -- '--overlay-src'; then
	out=$(bwrap --unshare-all --die-with-parent --ro-bind / / --dev /dev --proc /proc \
		--overlay-src "$d/lower" --overlay "$d/upper" "$d/work" "$d/dest" sh -c "$inside" 2>&1)
	echo "bwrap-overlay: $(verdict "$out")"
else
	echo "bwrap-overlay: absent (no --overlay option in this bubblewrap)"
fi

fresh
out=$(unshare -Urm sh -c "mount -t overlay overlay -o lowerdir='$d/lower',upperdir='$d/upper',workdir='$d/work' '$d/dest' && echo new > '$d/dest/b' && echo changed > '$d/dest/a'" 2>&1)
echo "unshare: $(verdict "$out")"

fresh
if command -v python3 >/dev/null; then
	out=$(bwrap --unshare-user --die-with-parent --cap-add CAP_SYS_ADMIN --cap-add CAP_DAC_OVERRIDE \
		--ro-bind / / --dev-bind /dev /dev --proc /proc --bind "$d" "$d" \
		python3 -I -c "
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
d = sys.argv[1]
options = f'lowerdir={d}/lower,upperdir={d}/upper,workdir={d}/work'.encode()
if libc.mount(b'overlay', (d + '/dest').encode(), b'overlay', 0, options):
    sys.exit('mount: ' + os.strerror(ctypes.get_errno()))
os.execvp('setpriv', ['setpriv', '--inh-caps=-all', '--ambient-caps=-all', '--'] + sys.argv[2:])
" "$d" bwrap --unshare-all --die-with-parent --ro-bind / / --dev /dev --proc /proc --bind "$d/dest" "$d/dest" \
		sh -c "$inside" 2>&1)
	echo "nested-bwrap: $(verdict "$out")"
else
	echo "nested-bwrap: not measured (no python3 to call mount(2))"
fi
