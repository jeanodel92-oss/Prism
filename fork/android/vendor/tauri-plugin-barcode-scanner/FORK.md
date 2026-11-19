# tauri-plugin-barcode-scanner 2.5.3, Prism fork

Copied from the crates.io package `tauri-plugin-barcode-scanner` 2.5.3 (checksum
`b57ad7e6ed3e8927205dade785400d9829b8208f59cfe24324fcb324f61482b2`), Apache-2.0 or MIT, by the Tauri Programme within
The Commons Conservancy. Used by the Android app through `[patch.crates-io]` in `fork/android/src-tauri/Cargo.toml`.
Left out: the package's `android/build` and `android/.tauri` (build output), `Cargo.toml.orig`, `.cargo_vcs_info.json`.

Why (owner's decision, 2026-11-15): the published plugin decodes with Google's ML Kit, from the non-free Google Play
services. That does not go with the GPL of the app, F-Droid refuses it, and it cannot read anything on a phone without
Google services.

Changes, Android only (the commands, their arguments and results are unchanged):

- `android/build.gradle.kts`: `com.google.zxing:core:3.5.3` (Apache-2.0) instead of
  `com.google.android.gms:play-services-mlkit-barcode-scanning:18.1.0`.
- `android/src/main/java/BarcodeScannerPlugin.kt`: frames are decoded by ZXing's `MultiFormatReader` from the camera's
  luminance plane, on a thread of their own rather than the main one (ZXing is synchronous); the result is sent from
  the main thread, once per scan. Same formats and the same rule as before: the formats asked for plus QR codes, every
  format when none is given. `bounds` is the rectangle around ZXing's result points.
- `android/src/main/java/GraphicOverlay.kt`: Kotlin's `check` instead of the Play services' `Preconditions`.
