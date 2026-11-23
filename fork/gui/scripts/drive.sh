#!/usr/bin/env bash
# Plays a scripted scenario in the test variant of the window (build.sh --drive) and saves its
# screenshots, without taking the keyboard or the screen: the window opens on a hidden special workspace
# and runs on a Hyprland headless output (PRISMTEST, created if missing and removed at the end).
#
#   fork/gui/scripts/drive.sh SCENARIO.json SHOTS_DIR [WIDTHxHEIGHT[@SCALE]] -- RUN_ARGS...
#   e.g. drive.sh fork/gui/tests/main.json /tmp/shots 1280x800@1 -- demo
#
# Hyprland only (hyprctl, grim). Progress and metrics lines are printed by the window ("drive: …").
set -euo pipefail

GUI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scenario="$(realpath "$1")" shots="$2" geometry="${3:-1280x800@1}"
shift 3
[[ "${1:-}" == "--" ]] && shift
mkdir -p "$shots"
shots="$(realpath "$shots")"
mode="${geometry%@*}" scale=1
[[ "$geometry" == *@* ]] && scale="${geometry#*@}"

created=0
existing="$(hyprctl workspaces -j)"
if ! hyprctl monitors -j | grep -q '"PRISMTEST"'; then
	hyprctl output create headless PRISMTEST >/dev/null
	created=1
fi
cleanup() { if [[ $created == 1 ]]; then hyprctl output remove PRISMTEST >/dev/null || true; fi; }
trap cleanup EXIT

# The test output's own workspace, which Hyprland gives it once a borrowed one is handed back (below).
# Like the window rule further down, it lasts until Hyprland reloads its config; hyprctl reports an error.
hyprctl dispatch 'hl.workspace_rule({ workspace = "name:prismdrive", monitor = "PRISMTEST", default = true })' >/dev/null 2>&1 || true

# A new output can be given one of the user's workspaces, windows included (their workspace 3)
# , and a test window moved there would join and retile their windows. Hand each such
# workspace back to the monitor it was on until the test output shows a workspace of its own.
for _ in $(seq 10); do
	# A named workspace left by an earlier run (name:prismdrive) has no "id" in the JSON of every Hyprland version
	# (KeyError on the second run): it is the test output's own, nothing to hand back.
	taken="$(hyprctl monitors -j | python3 -c 'import json,sys; print([m for m in json.load(sys.stdin) if m["name"]=="PRISMTEST"][0]["activeWorkspace"].get("id", ""))')"
	if [[ -z "$taken" ]]; then
		origin=""
		break
	fi
	origin="$(python3 -c 'import json,sys; print(next((w["monitor"] for w in json.loads(sys.argv[1]) if w.get("id")==int(sys.argv[2])), ""))' "$existing" "$taken")"
	# Already the test output's own (left by an earlier run): nothing to hand back.
	[[ "$origin" == PRISMTEST ]] && origin=""
	[[ -z "$origin" ]] && break
	hyprctl dispatch "hl.dsp.workspace.move({ workspace = \"$taken\", monitor = \"$origin\" })" >/dev/null
done
if [[ -n "$origin" ]]; then
	echo "drive.sh: the test output still shows the user's workspace $taken; not starting" >&2
	exit 1
fi
# hl.monitor applies the mode; hyprctl reports an error because it is not a dispatcher.
hyprctl dispatch "hl.monitor({ output = \"PRISMTEST\", mode = \"$mode@60\", position = \"8000x0\", scale = $scale })" >/dev/null 2>&1 || true
# A named workspace has a negative id, which a move would read as relative: name it instead.
workspace="$(hyprctl monitors -j | python3 -c 'import json,sys; w=[m for m in json.load(sys.stdin) if m["name"]=="PRISMTEST"][0]["activeWorkspace"]; print(w["id"] if w.get("id", 0) > 0 else "name:" + w["name"])')"

export PRISM_GUI_BIN="$GUI/src-tauri/target-drive/release/prism-gui"
export PRISM_GUI_DRIVE="$scenario" PRISM_GUI_DRIVE_SHOTS="$shots" PRISM_GUI_DRIVE_OUTPUT=PRISMTEST
"$GUI/scripts/run.sh" "$@" &
pid=$!

# Test windows (initial title "Prism drive", or the egui probe) open directly on a hidden special
# workspace, so they never appear on or retile the user's workspaces; from there they go to the headless
# output. Rules added this way last until Hyprland reloads its config; hyprctl reports an error because
# hl.window_rule is not a dispatcher, but the rule is registered. They stay opaque whatever the desktop's
# active or inactive opacity, so screenshots measure the window's own colours.
hyprctl dispatch 'hl.window_rule({ match = { initial_title = "^(Prism drive|egui probe)$" }, workspace = "special:prismtest silent", opacity = "1.0 override 1.0 override" })' >/dev/null 2>&1 || true

# Send the window to the headless output as soon as it maps.
for _ in $(seq 100); do
	address="$(hyprctl clients -j | python3 -c "import json,sys; c=[c for c in json.load(sys.stdin) if c['pid']==$pid]; print(c[0]['address'] if c else '')")"
	if [[ -n "$address" ]]; then
		hyprctl dispatch "hl.dsp.window.move({ workspace = \"$workspace\", follow = false, window = \"address:$address\" })" >/dev/null
		break
	fi
	sleep 0.1
done

status=0
timeout "${PRISM_GUI_DRIVE_TIMEOUT:-600}" tail --pid="$pid" -f /dev/null || { kill "$pid" 2>/dev/null; status=124; }
wait "$pid" || status=$?
exit "$status"
