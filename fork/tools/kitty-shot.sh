#!/usr/bin/env bash
# Screenshot a command's output in a real kitty window (Hyprland + grim). Test tooling only.
# Used to judge pixel art: ansi2png.py shows seams between half blocks that kitty does not.
#
# usage: fork/tools/kitty-shot.sh <out.png> <command...>
#   Opens a kitty window on the visible workspace (spawned by Hyprland, so it lands there),
#   runs the command, waits, captures the window and closes it.
# env:
#   KFONT=<pt>       font size override (default: the user's kitty config)
#   KITTY_OPAQUE=0   keep the user's background opacity (default: forced opaque)
set -euo pipefail
out=$1
shift
cls=prismshot$$
run=$(mktemp --suffix=.sh)
trap 'rm -f "$run"' EXIT
printf '%s\nsleep 40\n' "$*" >"$run"
opts="-o window_padding_width=10"
[[ ${KITTY_OPAQUE:-1} == 1 ]] && opts="$opts -o background_opacity=1"
[[ -n ${KFONT:-} ]] && opts="$opts -o font_size=$KFONT"
hyprctl -q eval "hl.exec_cmd(\"kitty --class $cls $opts bash $run\")"
geo=""
for _ in $(seq 40); do
	geo=$(hyprctl clients -j | jq -r --arg c "$cls" '.[] | select(.class==$c) | "\(.at[0]),\(.at[1]) \(.size[0])x\(.size[1])"' | head -1)
	[[ -n $geo ]] && break
	sleep 0.25
done
[[ -n $geo ]] || { echo "kitty window not found" >&2; exit 1; }
sleep 2.5
grim -g "$geo" "$out"
pid=$(hyprctl clients -j | jq -r --arg c "$cls" '.[] | select(.class==$c) | .pid' | head -1)
kill "$pid"
echo "$out $geo"
