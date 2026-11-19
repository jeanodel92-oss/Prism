// The Android app's download: each stable release on publishes the APK,
// and the latest one under this fixed address. The PC window shows it
// in "Link a phone" and in the welcome, the phone in its settings, to update by hand.

const { invoke } = window.__TAURI__.core;

export const ANDROID_APP_URL = "https://prism.odelserver.space/releases/android/prism-android-arm64.apk";

/** Opens the download: in the phone's browser on the phone (MainActivity.kt), else in the PC's. */
export function openAndroidApp() {
	if (window.PrismAndroid?.openUrl) window.PrismAndroid.openUrl(ANDROID_APP_URL);
	else invoke("open_external", { url: ANDROID_APP_URL }).catch(() => {});
}

/** The download's address as a QR image (an SVG data URL), for the phone's own camera; undefined if it cannot be drawn. */
export async function androidAppQr() {
	try {
		const svg = await invoke("qr_svg", { text: ANDROID_APP_URL });
		return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	} catch {
		return undefined;
	}
}
