#!/usr/bin/env bash
# Plays a scripted scenario in the test variant of the window (build.sh --drive) under GNOME Shell,
# headless, apart from the user's session: a private D-Bus session bus, a throwaway runtime dir, HOME and
# XDG dirs, and a virtual monitor. Nothing appears on screen and nothing of the user's desktop is read.
#
#   fork/gui/scripts/drive-gnome.sh SCENARIO.json [WIDTHxHEIGHT] -- RUN_ARGS...
#   e.g. drive-gnome.sh fork/gui/tests/main.json 1280x800 -- demo
#
# GNOME Shell's screenshot interface answers only its own allowlisted callers, so "shot" steps are left
# out here; every other step (DOM checks, clicks, typing, contrast, metrics) runs as on Hyprland. Progress
# lines are the window's ("drive: …"), and "gnome: …" lines are this script's.
set -euo pipefail

GUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${PRISM_GNOME_INNER:-}" ]]; then
	scenario="$(realpath "$1")" size="${2:-1280x800}"
	shift 2
	[[ "${1:-}" == "--" ]] && shift
	scratch="$(mktemp -d "${TMPDIR:-/tmp}/prism-gnome.XXXXXX")"
	cleanup() {
		# The session's daemons (document portal, gvfs, evolution…) outlive the bus by a moment and keep
		# writing into the scratch dir: wait until none is left, then remove it.
		local left="" waited=0
		for waited in $(seq 0 100); do
			# Other users' processes cannot be read: grep then ends with 2, which says nothing about ours.
			left="$({ grep -lsz "XDG_RUNTIME_DIR=$scratch/run" /proc/[0-9]*/environ || true; } | cut -d/ -f3 | tr '\n' ' ')"
			[[ -z "$left" ]] && break
			sleep 0.1
		done
		[[ -z "$left" && $waited -gt 0 ]] && echo "gnome: the session's daemons ended $((waited * 100)) ms after it"
		[[ -n "$left" ]] && echo "gnome: still running after 10 s: $(ps -o comm= -p "${left// /,}" | tr '\n' ' ')" >&2
		fusermount3 -uz "$scratch/run/doc" 2>/dev/null || true
		rm -rf "$scratch" || echo "gnome: could not remove $scratch" >&2
	}
	trap cleanup EXIT
	mkdir -m 700 "$scratch/run"
	mkdir -p "$scratch/home" "$scratch/shots"
	python3 -c '
import json, sys
steps = [s for s in json.load(open(sys.argv[1])) if s.get("do") != "shot"]
json.dump(steps, open(sys.argv[2], "w"))
' "$scenario" "$scratch/scenario.json"
	status=0
	env -u DISPLAY -u WAYLAND_DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE -u DBUS_SESSION_BUS_ADDRESS \
		XDG_RUNTIME_DIR="$scratch/run" HOME="$scratch/home" XDG_CONFIG_HOME="$scratch/home/.config" \
		XDG_DATA_HOME="$scratch/home/.local/share" XDG_CACHE_HOME="$scratch/home/.cache" \
		XDG_STATE_HOME="$scratch/home/.local/state" XDG_CURRENT_DESKTOP=GNOME \
		PRISM_GNOME_INNER=1 PRISM_GNOME_SCRATCH="$scratch" PRISM_GNOME_SIZE="$size" \
		PRISM_GUI_PROFILE_DIR="${PRISM_GUI_PROFILE_DIR:-$scratch/profiles}" \
		dbus-run-session -- "${BASH_SOURCE[0]}" "$@" || status=$?
	echo "gnome: session ended with $status"
	exit "$status"
fi

# Inside the private session bus.
scratch="$PRISM_GNOME_SCRATCH"
# The scenarios expect the dark appearance unless they ask otherwise (drive-all --light), as on a desktop that
# prefers dark; GNOME's default is light. Written in the throwaway HOME's dconf, on this private bus only.
gsettings set org.gnome.desktop.interface color-scheme prefer-dark
gnome-shell --headless --wayland --no-x11 --virtual-monitor "$PRISM_GNOME_SIZE" --wayland-display prism-gnome \
	>"$scratch/gnome-shell.log" 2>&1 &
shell=$!
trap 'kill "$shell" 2>/dev/null || true; wait "$shell" 2>/dev/null || true' EXIT
for _ in $(seq 100); do
	[[ -S "$XDG_RUNTIME_DIR/prism-gnome" ]] && break
	kill -0 "$shell" 2>/dev/null || { echo "gnome: GNOME Shell exited" >&2; tail -20 "$scratch/gnome-shell.log" >&2; exit 1; }
	sleep 0.1
done
[[ -S "$XDG_RUNTIME_DIR/prism-gnome" ]] || { echo "gnome: no Wayland socket" >&2; exit 1; }
echo "gnome: $(gnome-shell --version), headless ${PRISM_GNOME_SIZE}"

export WAYLAND_DISPLAY=prism-gnome GDK_BACKEND=wayland
export PRISM_GUI_BIN="$GUI/src-tauri/target-drive/release/prism-gui"
export PRISM_GUI_DRIVE="$scratch/scenario.json" PRISM_GUI_DRIVE_SHOTS="$scratch/shots"
status=0
timeout "${PRISM_GUI_DRIVE_TIMEOUT:-600}" "$GUI/scripts/run.sh" "$@" || status=$?
echo "gnome: window exited with $status"
exit "$status"
