#!/usr/bin/env bash
# The pairing and the QR scanner on the emulator, case by case (linking again from the settings, while paired, left the scan stuck under the settings dialog)
# . Drives the app's WebView through its devtools,
# so it needs the debug APK: scripts/emulator.sh, then PRISM_ANDROID_TARGET=x86_64 scripts/build.sh --debug and
# adb install. Starts its own phone server (a throwaway folder, the scripted fake model) and prints one line per check:
# "pass ..." or "FAIL ...". The emulator's camera shows nothing and ML Kit does not decode there: a scan is opened,
# cancelled and left, the code itself is pasted (the path a scanned code takes next).
set -uo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$APP/../.." && pwd)"
R="$APP/server/target/release/prism-remote"
[[ -x "$R" ]] || { echo "build the server first: (cd fork/android/server && cargo build --release)" >&2; exit 1; }
export ANDROID_SERIAL=emulator-5584
work="$(mktemp -d /tmp/prism-bench.XXXXXX)"
mkdir -p "$work/home" "$work/agent" "$work/remote"
(
	export HOME="$work/home" PI_CODING_AGENT_DIR="$work/agent" PI_OFFLINE=1 PRISM_REMOTE_ENGINE=node
	PRISM_REMOTE_ENGINE_ARGS="$(node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' -- --import "file://$ROOT/packages/coding-agent/src/experimental/source-resolver.ts" "$ROOT/packages/coding-agent/src/experimental/cli.ts" -e "$ROOT/fork/tools/fake-provider.ts" --model fake/scripted)"
	export PRISM_REMOTE_ENGINE_ARGS
	exec "$R" serve --dir "$work/remote" --port 47392 --host 127.0.0.1 --cwd "$work/home"
) >"$work/serve.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; adb forward --remove-all; rm -rf "$work"' EXIT
for _ in $(seq 1 40); do "$R" status --dir "$work/remote" >/dev/null 2>&1 && break; sleep 0.25; done
adb reverse tcp:47392 tcp:47392 >/dev/null
adb shell pm grant space.odelserver.prism.mobile android.permission.CAMERA
cat >"$work/cdp.mjs" <<'CDP'
// cdp.mjs EXPR: evaluates EXPR (awaited) in the app's WebView through the forwarded devtools port 9333.
const pages = await (await fetch("http://127.0.0.1:9333/json")).json();
const page = pages.find((p) => p.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: `(async () => { ${process.argv[2]} })()`, awaitPromise: true, returnByValue: true } }));
const msg = await new Promise((r) => ws.addEventListener("message", (e) => r(JSON.parse(e.data))));
console.log(JSON.stringify(msg.result?.result?.value ?? msg.result?.exceptionDetails?.exception?.description ?? msg));
ws.close();
CDP
js() { node "$work/cdp.mjs" "$1" 2>/dev/null; }
attach() {
	sleep 1
	local pid; pid=$(adb shell pidof space.odelserver.prism.mobile | tr -d '\r')
	adb forward --remove-all; adb forward tcp:9333 localabstract:webview_devtools_remote_$pid >/dev/null
	for _ in $(seq 1 40); do [[ "$(js 'return document.readyState')" == '"complete"' ]] && return; sleep 0.25; done
}
# Started and linked, the phone's layer ready (phone.js), then into a conversation as the user would be.
restart() {
	adb shell am force-stop space.odelserver.prism.mobile; adb shell monkey -p space.odelserver.prism.mobile -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 2; attach
	for _ in $(seq 1 60); do [[ "$(js 'return !!document.querySelector(".phone-settings-back")' 2>/dev/null)" == true ]] && break; sleep 0.5; done
	adb shell input tap 540 1196; sleep 2
}
check() { # check NAME EXPECTED ACTUAL
	if [[ "$2" == "$3" ]]; then echo "pass $1"; else echo "FAIL $1: expected $2, got $3"; fi
}
state='const d=document.getElementById("settings"); const o=document.querySelector(".scan-overlay"); const vis=[...document.querySelectorAll("body *")].filter(e=>!e.closest(".scan-overlay") && getComputedStyle(e).visibility==="visible" && e.getBoundingClientRect().width>0).length; return [o?(o.open?"overlay-modal":"overlay-closed"):"no-overlay", "visible="+vis, "class="+document.documentElement.className, "settings="+(d?.open?d.dataset.level:"closed"), "pair="+!!document.getElementById("pair-screen"), "err="+(document.querySelector(".pair-error:not([hidden])")?.textContent||"")].join(" ")'
openSettings='document.getElementById("settings-button").click(); await new Promise(r=>setTimeout(r,800)); document.querySelector(".settings-section").click(); await new Promise(r=>setTimeout(r,400)); return "ok"'
scanButton='[...document.querySelectorAll("button")].find(x=>x.textContent.includes("Scan") && x.offsetParent).click(); await new Promise(r=>setTimeout(r,2500)); return "ok"'
tapCancel() { adb shell input tap 540 2142; sleep 1.5; }

# Start paired: a run that stopped halfway may have left the phone unpaired.
adb shell am force-stop space.odelserver.prism.mobile; adb shell monkey -p space.odelserver.prism.mobile -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 3; attach; sleep 2
if [[ "$(js 'return !!document.getElementById("pair-screen")')" == true ]]; then
	code=$($R invite --dir "$work/remote" | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')
	js "const ta=document.querySelector('#pair-screen textarea'); ta.value='$code'; [...document.querySelectorAll('#pair-screen button')].find(x=>x.textContent==='Link').click(); return 1" >/dev/null; sleep 5
fi
echo "== paired, from the settings"
restart
js "$openSettings" >/dev/null; js "$scanButton" >/dev/null
check "A1 scan opens a modal overlay, nothing else visible" "overlay-modal visible=0 class=scanning settings=pane pair=false err=" "$(js "$state" | tr -d '"')"
tapCancel
check "A2 Cancel closes it, settings stay on the section" "no-overlay" "$(js "$state" | tr -d '"' | cut -d' ' -f1)"
check "A2b settings still open" "settings=pane" "$(js "$state" | tr -d '"' | grep -o 'settings=[a-z]*')"
js "$scanButton" >/dev/null; adb shell input keyevent BACK; sleep 1.5
check "A3 Back cancels, settings stay" "no-overlay settings=pane" "$(js "$state" | tr -d '"' | awk '{print $1, $4}')"
js "$scanButton" >/dev/null; tapCancel; js "$scanButton" >/dev/null; tapCancel
check "A4 twice in a row" "no-overlay settings=pane" "$(js "$state" | tr -d '"' | awk '{print $1, $4}')"
adb shell input keyevent BACK; sleep 1
check "A5 Back after the scans leaves the section for the list" "settings=list" "$(js "$state" | tr -d '"' | grep -o 'settings=[a-z]*')"
js 'document.getElementById("settings").close(); return 1' >/dev/null
code=$($R invite --dir "$work/remote" | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')
js "const ta=[...document.querySelectorAll('#settings-link textarea')][0]; ta.value='$code'; [...document.querySelectorAll('#settings-link button')].find(x=>x.textContent==='Link').click(); return 1" >/dev/null; sleep 5; attach
st=$(js 'return JSON.stringify(await window.__TAURI__.core.invoke("link_status"))')
check "A6 a new code of the same PC, pasted, links again" "true true" "$(python3 -c 'import json,sys; s=json.loads(json.loads(sys.argv[1])); print(str(s["paired"]).lower(), str(s["connected"]).lower())' "$st")"
check "A6b one device on the PC" "1" "$($R devices --dir "$work/remote" | wc -l)"
check "A6c nothing of a scan left" "no-overlay class=" "$(js "$state" | tr -d '"' | awk '{print $1, $3}')"

echo "== not paired, from the pairing screen"
js 'await window.__TAURI__.core.invoke("link_forget"); location.reload(); return 1' >/dev/null 2>&1; attach; sleep 1
check "B0 pairing screen" "pair=true" "$(js "$state" | tr -d '"' | grep -o 'pair=[a-z]*')"
js "$scanButton" >/dev/null
check "B1 modal overlay, nothing else visible" "overlay-modal visible=0 class=scanning" "$(js "$state" | tr -d '"' | awk '{print $1, $2, $3}')"
tapCancel
check "B2 Cancel back to the pairing screen" "no-overlay pair=true" "$(js "$state" | tr -d '"' | awk '{print $1, $5}')"
js "$scanButton" >/dev/null; adb shell input keyevent BACK; sleep 1.5
check "B3 Back cancels without leaving the app" "no-overlay pair=true" "$(js "$state" | tr -d '"' | awk '{print $1, $5}')"
check "B3b app in front" "space.odelserver.prism.mobile" "$(adb shell dumpsys activity activities | grep -o 'topResumedActivity.*' | grep -o 'space.odelserver.prism.mobile' | head -1)"
code=$($R invite --dir "$work/remote" | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')
js "const ta=document.querySelector('#pair-screen textarea'); ta.value='$code'; [...document.querySelectorAll('#pair-screen button')].find(x=>x.textContent==='Link').click(); return 1" >/dev/null; sleep 5; attach
st=$(js 'return JSON.stringify(await window.__TAURI__.core.invoke("link_status"))')
check "B4 a pasted code pairs after scans were cancelled" "true true" "$(python3 -c 'import json,sys; s=json.loads(json.loads(sys.argv[1])); print(str(s["paired"]).lower(), str(s["connected"]).lower())' "$st")"
check "B4b pairing screen gone" "pair=false" "$(js "$state" | tr -d '"' | grep -o 'pair=[a-z]*')"
