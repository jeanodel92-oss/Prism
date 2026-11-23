# Prism on Your Phone

The Prism app for Android follows and drives the Prism of your computer: you see your sessions, send messages, answer permission questions and receive files. The agent keeps running on the computer, with its models, permissions and sandbox; the phone is a window on it. There is no app for iOS.

The phone talks to the computer directly, over your local network or [Tailscale](https://tailscale.com), with no online service in between.

## Install the app

The app is published on [Prism's download page](https://prism.odelserver.space/downloads/):

- **F-Droid**: add the repository `https://prism.odelserver.space/fdroid/repo`, then install Prism. F-Droid checks the repository's signing key and offers updates.
- **Obtainium**: add the same repository address with the "F-Droid Third Party Repo" source and the app ID `space.odelserver.prism.mobile`.
- **APK** (arm64): download it on the phone and allow installs from your browser. Updates are not offered on their own.

## Link a phone

On the computer, open **Link a phone** in the window, or run `/phone` in the terminal.

1. Start the phone server (`prism-remote`, installed with Prism):
   - **Run while this Prism is open**: the phone reaches the computer only while Prism runs;
   - **Run always, as a user service**: a systemd user service (`prism-remote.service`) keeps the computer reachable while your session is open, even with Prism closed.
2. Choose **Show a pairing code**. Scan the QR code from the app, or paste the code shown below it. A code is valid for 5 minutes and works once.
3. The phone tries the computer's addresses: its Tailscale address first, then its local network addresses, on port 47392 by default. Without Tailscale, the phone reaches the computer only on the same network.

`/phone` also lists the linked phones and revokes one: a revoked phone must be paired again with a new code. **Stop the phone server** closes the link for every phone.

## Security

- The computer and each phone have their own certificate. They speak TLS 1.3 and check each other's certificate by its fingerprint, learnt during pairing; a device that was not paired is refused.
- The pairing keys and the list of linked phones are kept in `~/.prism/remote` (`PRISM_REMOTE_DIR` moves it). Commands in the [sandbox](sandbox.md) cannot read that folder.
- What the agent does from the phone goes through the same permission questions as on the computer.

## Requirements

- The computer: Linux x64 with glibc 2.39 or newer (Debian 13, Ubuntu 24.04, Fedora 40 and later), like the window.
- The phone: Android 7 or newer, on arm64.
- To reach the computer away from home: Tailscale on both, connected (`tailscale up`).
