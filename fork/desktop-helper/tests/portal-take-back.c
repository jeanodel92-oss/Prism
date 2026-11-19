/*
 * Test of prism-portal-helper's take-back during a batch of keys, without a
 * portal: the helper's source is included with libei's sending calls replaced by a log, and the take-back signal is
 * delivered by a GLib timer on the same loop as the portal's D-Bus signal would be.
 *
 * usage: portal-take-back DELAY_MS   types 200 characters with Shift held, takes the desktop back after DELAY_MS
 * Prints one line per key event ("key <evdev code> down|up"), "ok" when the batch ended, and at exit
 * "events <count> ms <elapsed>". Exit status: the helper's (4 when taken back), 77 without an xkb keymap.
 * Built and run by packages/coding-agent/test/fork-portal-take-back.test.ts.
 */
#define _DEFAULT_SOURCE
/* As the helper sets them, so that its own definitions repeat these. */
#define GLIB_VERSION_MIN_REQUIRED GLIB_VERSION_2_64
#define GLIB_VERSION_MAX_ALLOWED GLIB_VERSION_2_64
#include <gio/gio.h>
#include <libei.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static int events;
static gint64 started;

static void fake_key(uint32_t code, bool down) {
	events++;
	printf("key %u %s\n", code, down ? "down" : "up");
}

static void fake_button(uint32_t code, bool down) {
	events++;
	printf("button %u %s\n", code, down ? "down" : "up");
}

#define ei_device_keyboard_key(device, code, down) fake_key((code), (down))
#define ei_device_button_button(device, code, down) fake_button((code), (down))
#define ei_device_frame(device, time) ((void)0)
#define ei_now(context) ((uint64_t)0)
#define ei_dispatch(context) ((void)0)
#define ei_get_event(context) ((struct ei_event *)NULL)
/* glibc's headers turned it into 1; the helper defines it again, empty. */
#undef _DEFAULT_SOURCE
#define main portal_helper_main
#include "../prism-portal-helper.c"
#undef main

static void report(void) {
	printf("events %d ms %lld\n", events, (long long)((g_get_monotonic_time() - started) / 1000));
	fflush(stdout);
}

static gboolean take_back(gpointer data) {
	GVariant *parameters = g_variant_ref_sink(
		g_variant_new("(osta{sv})", "/test/session", SHORTCUT_ID, (guint64)0, NULL));
	on_shortcut(NULL, NULL, NULL, NULL, NULL, parameters, "/test/session");
	g_variant_unref(parameters);
	return G_SOURCE_REMOVE;
}

int main(int argc, char **argv) {
	struct xkb_context *context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
	struct xkb_rule_names names = {.layout = "us"};
	keymap = context ? xkb_keymap_new_from_names(context, &names, XKB_KEYMAP_COMPILE_NO_FLAGS) : NULL;
	if (!keymap) {
		puts("no xkb keymap");
		return 77;
	}
	keyboard_ready = true;
	setvbuf(stdout, NULL, _IOLBF, 0);
	atexit(report);
	started = g_get_monotonic_time();
	g_timeout_add((guint)(argc > 1 ? atoi(argv[1]) : 50), take_back, NULL);
	/* Shift (modifier bit 1) held over 200 "a". */
	GString *line = g_string_new("keys 1");
	for (int i = 0; i < 200; i++) g_string_append(line, " 61");
	run(line->str);
	for (;;) g_main_context_iteration(NULL, TRUE);
}
