#!/usr/bin/env bash
# builds the desktop helpers: prism-desktop-helper, input and capture of
# the agent's desktop and of the user's under Hyprland, and prism-portal-helper, of the user's desktop through the
# desktop portal (GNOME, KDE).
# usage: fork/desktop-helper/build.sh [out-dir]   (default: fork/desktop-helper/build)
# Needs gcc, wayland-scanner and the development files of libwayland-client, GLib (gio-unix), libei, PipeWire and
# xkbcommon (Fedora: wayland-devel glib2-devel libei-devel pipewire-devel libxkbcommon-devel; Debian/Ubuntu:
# libwayland-dev libglib2.0-dev libei-dev libpipewire-0.3-dev libxkbcommon-dev). At run time, prism-desktop-helper
# needs only libwayland-client (libatspi, for the accessibility tree, is loaded when present); prism-portal-helper needs those libraries, present where the portal offers libei.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(mkdir -p "${1:-$SRC/build}" && cd "${1:-$SRC/build}" && pwd)"
GEN="$OUT/generated"
mkdir -p "$GEN"

for protocol in "$SRC"/protocols/*.xml; do
	name=$(basename "$protocol" .xml)
	wayland-scanner client-header "$protocol" "$GEN/$name-client-protocol.h"
	wayland-scanner private-code "$protocol" "$GEN/$name-protocol.c"
done

# shellcheck disable=SC2046 # pkg-config prints several flags.
${CC:-gcc} -std=c11 -O2 -Wall -Wextra -Werror -Wno-unused-parameter -D_FORTIFY_SOURCE=2 -fstack-protector-strong \
	-I"$GEN" -o "$OUT/prism-desktop-helper" "$SRC/prism-desktop-helper.c" "$SRC/prism-a11y.c" "$GEN"/*-protocol.c \
	$(pkg-config --cflags --libs wayland-client) -ldl
echo "build: $OUT/prism-desktop-helper"

# shellcheck disable=SC2046
${CC:-gcc} -std=c11 -O2 -Wall -Wextra -Werror -Wno-unused-parameter -D_FORTIFY_SOURCE=2 -fstack-protector-strong \
	-o "$OUT/prism-portal-helper" "$SRC/prism-portal-helper.c" \
	$(pkg-config --cflags --libs gio-unix-2.0 libei-1.0 libpipewire-0.3 xkbcommon)
echo "build: $OUT/prism-portal-helper"
