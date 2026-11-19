/*
 * Test of prism-desktop-helper's keymap after it starts a new one, without a
 * compositor: the helper's source is included with the virtual keyboard's requests replaced by a fake compositor
 * that keeps the last keymap it received and turns each key code back into the keysym that keymap gives it.
 *
 * usage: keymap-reset   types two batches of 200 distinct keysyms, disjoint, so the second needs a new keymap of
 * the same size as the first. Prints "keymaps <count>" after each batch, then one line per batch with the keysyms
 * the fake compositor received ("typed <hex>..."), to compare with the ones sent ("sent <hex>...").
 * Built and run by packages/coding-agent/test/fork-desktop-helper-keymap.test.ts.
 */
#define _DEFAULT_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>

#include "virtual-keyboard-unstable-v1-client-protocol.h"
#include "wlr-screencopy-unstable-v1-client-protocol.h"
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"

#define FAKE_MAX 512
static uint32_t compositor_keysyms[FAKE_MAX];
static int keymaps;
static char typed[16384];

/* The fake compositor reads the keymap text the helper wrote: "key <K<i>> {[ 0x<keysym> ]};" maps code i + 1. */
static void fake_keymap(int fd, uint32_t size) {
	char *text = calloc(1, size + 1);
	if (!text || pread(fd, text, size, 0) != (ssize_t)size) exit(2);
	memset(compositor_keysyms, 0, sizeof compositor_keysyms);
	for (char *at = strstr(text, "key <K"); at; at = strstr(at + 1, "key <K")) {
		int index;
		unsigned keysym;
		if (sscanf(at, "key <K%d> {[ 0x%x ]};", &index, &keysym) == 2 && index >= 0 && index < FAKE_MAX)
			compositor_keysyms[index] = keysym;
	}
	free(text);
	keymaps++;
}

static void fake_key(uint32_t code, uint32_t state) {
	if (state != WL_KEYBOARD_KEY_STATE_PRESSED) return;
	char word[16];
	snprintf(word, sizeof word, " %x", code >= 1 && code <= FAKE_MAX ? compositor_keysyms[code - 1] : 0);
	strncat(typed, word, sizeof typed - strlen(typed) - 1);
}

#define zwp_virtual_keyboard_v1_keymap(keyboard, format, fd, size) fake_keymap((fd), (size))
#define zwp_virtual_keyboard_v1_key(keyboard, time, code, state) fake_key((code), (state))
#define zwp_virtual_keyboard_v1_modifiers(keyboard, depressed, latched, locked, group) ((void)0)
static int fake_roundtrip(struct wl_display *unused) { return 0; }
/* The helper's pauses wait for a real compositor; none here. */
static int fake_sleep(const struct timespec *duration, struct timespec *rest) { return 0; }

#define wl_display_roundtrip(display) fake_roundtrip((display))
#define nanosleep(duration, rest) fake_sleep((duration), (rest))
#undef _DEFAULT_SOURCE
#define main desktop_helper_main
#include "../prism-desktop-helper.c"
#undef main

int a11y_run(const char *name, char *rest) { return 0; }

static void batch(uint32_t first) {
	char line[4096] = "keys 0";
	printf("sent");
	for (uint32_t i = 0; i < 200; i++) {
		char word[16];
		snprintf(word, sizeof word, " %x", first + i);
		strcat(line, word);
		printf("%s", word);
	}
	printf("\n");
	typed[0] = 0;
	run(line);
	printf("keymaps %d\ntyped%s\n", keymaps, typed);
}

int main(void) {
	setvbuf(stdout, NULL, _IOLBF, 0);
	/* Unicode keysyms: 200 CJK ideographs, then 200 others; together they exceed the 240 keycodes. */
	batch(0x1004e00);
	batch(0x1004f00);
	return 0;
}
