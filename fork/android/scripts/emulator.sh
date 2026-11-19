#!/usr/bin/env bash
# Starts the test emulator with no window, waits until Android has booted, and says how to stop it.
#   scripts/emulator.sh          start (creates the AVD "prism-test" on first use)
#   scripts/emulator.sh stop
# Needs the emulator and system-images;android-36;default;x86_64.
# Rendering is swangle_indirect: on this machine, swiftshader_indirect, guest and host all
# crashed qemu or hung it at the start of Android's display.
set -euo pipefail
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/sdk}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$HOME/Android/avd}"
PORT=5584
ADB="$ANDROID_HOME/platform-tools/adb"
SERIAL="emulator-$PORT"
IMAGE="system-images;android-36;default;x86_64"

if [[ "${1:-}" == stop ]]; then
	"$ADB" -s "$SERIAL" emu kill
	exit 0
fi
if [[ ! -d "$ANDROID_AVD_HOME/prism-test.avd" ]]; then
	mkdir -p "$ANDROID_AVD_HOME"
	echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n prism-test -k "$IMAGE" -d pixel_6 >/dev/null
fi
log="${TMPDIR:-/tmp}/prism-emulator.log"
# Never on the maintainer's screen; at most 5 GB, no swap.
env -u WAYLAND_DISPLAY -u DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE \
	systemd-run --user --scope -q -p MemoryMax=5G -p MemorySwapMax=0 -- \
	"$ANDROID_HOME/emulator/emulator" -avd prism-test -no-window -no-audio -no-boot-anim -no-snapshot \
	-gpu swangle_indirect -no-metrics -memory 2048 -port "$PORT" >"$log" 2>&1 &
for _ in $(seq 1 80); do
	if [[ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then
		echo "$SERIAL booted; stop with: $0 stop"
		exit 0
	fi
	kill -0 $! 2>/dev/null || { echo "emulator exited; see $log" >&2; exit 1; }
	sleep 3
done
echo "not booted after 4 minutes; see $log" >&2
"$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true
exit 1
