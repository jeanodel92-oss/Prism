#!/usr/bin/env bash
# Builds the phone app's APK. Needs the Android SDK and NDK, the Rust Android
# targets and tauri-cli 2.12.4; on the maintainer's machine they are under ~/Android.
#   scripts/build.sh            release APK for arm64 (unsigned), with its libraries' licences (scripts/notices)
#   scripts/build.sh --debug    debug APK for arm64, signed with the debug key, for adb install
#   PRISM_ANDROID_TARGET=x86_64 scripts/build.sh --debug    the same for the emulator
set -euo pipefail
APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/sdk}"
export NDK_HOME="${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)}"
export PATH="$HOME/Android/tauri-cli/bin:$PATH"
# No Gradle or Kotlin daemon left behind: they kept about 4 GB after each build and, with the emulator and other
# builds, the machine ran out of memory.
export GRADLE_OPTS="${GRADLE_OPTS:-} -Dorg.gradle.daemon=false -Dkotlin.compiler.execution.strategy=in-process"
# The window's interface is shared: its prepared files (fonts, marked, mermaid, the site's scene) come first.
"$APP/../gui/scripts/prepare.sh"
cd "$APP/src-tauri"
# The Android project is generated, not kept in Git.
[[ -d gen/android ]] || cargo tauri android init --ci
# Our own activity (system bars and keyboard) replaces the generated one.
cp "$APP/android/MainActivity.kt" gen/android/app/src/main/java/space/odelserver/prism/mobile/MainActivity.kt
# The permanent notification that keeps the link to the PC up, and what it needs in the
# generated manifest: added once, the generated file being kept between builds.
cp "$APP/android/LinkService.kt" gen/android/app/src/main/java/space/odelserver/prism/mobile/LinkService.kt
manifest=gen/android/app/src/main/AndroidManifest.xml
if ! grep -q LinkService "$manifest"; then
	sed -i 's|<uses-permission android:name="android.permission.INTERNET" />|&\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />\n    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING" />\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />|' "$manifest"
	sed -i 's|    </application>|        <service android:name="space.odelserver.prism.mobile.LinkService" android:exported="false" android:foregroundServiceType="remoteMessaging" />\n&|' "$manifest"
fi
# The phone's identity never leaves it: no backup, no transfer to a new phone
# (res/xml/data_extraction_rules.xml, copied with the resources below).
if ! grep -q dataExtractionRules "$manifest"; then
	sed -i 's|^    <application$|&\n        android:allowBackup="false"\n        android:dataExtractionRules="@xml/data_extraction_rules"|' "$manifest"
	grep -q dataExtractionRules "$manifest" || { echo "build.sh: $manifest has no <application line to mark" >&2; exit 1; }
fi
# The window's icon (fork/gui/src-tauri/icons/icon.png) as Android's launcher icon, round mask included; regenerate with
# `cargo tauri icon` from that PNG padded to 68 % on a #0e0e0f background.
cp -r "$APP/android/res/." gen/android/app/src/main/res/
# R8 rules the release build needs beyond the libraries' own (the QR scanner's components).
cp "$APP/android/proguard-prism.pro" gen/android/app/proguard-prism.pro
build() { cargo tauri android build --apk --target "${PRISM_ANDROID_TARGET:-aarch64}" "$@"; }
if [[ " $* " == *" --debug "* ]]; then
	build "$@"
	exit
fi
# A release APK carries the licences and notices of its Java and Kotlin libraries, in the
# window's interface that the app serves; fork/scripts/release.sh adds the Rust crates' beside them. Listing those
# libraries needs the Gradle files Tauri writes while it compiles the Rust side (tauri.settings.gradle), which a fresh
# checkout does not have: the notices are written again
# after the build, and when they differ from the ones it embedded, the app is built again with them. Cargo does not see
# a file new to the interface (seen: the second build kept the APK without them), so the app's crate is touched first.
notices="$APP/../gui/ui/vendor/THIRD-PARTY-ANDROID.txt"
list_notices() { node "$APP/scripts/notices/android-notices.mjs" gen/android "$notices"; }
[[ ! -f gen/android/tauri.settings.gradle ]] || list_notices
build "$@"
embedded="$(sha256sum "$notices" 2>/dev/null || true)"
list_notices
if [[ "$(sha256sum "$notices")" != "$embedded" ]]; then
	touch src/lib.rs
	build "$@"
fi
