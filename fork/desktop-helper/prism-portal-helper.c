/*
 * prism-portal-helper: mouse, keyboard and screen capture of the user's own desktop through the desktop portal
 * (RemoteDesktop with libei, ScreenCast with PipeWire), for GNOME, KDE and the other desktops whose portal offers
 * them. Hyprland goes through prism-desktop-helper instead.
 *
 * The desktop asks the user the first time (which screen, allow remote interaction); when the user lets it remember
 * the choice, the restore token printed at start avoids the dialog next time. The desktop shows its own sharing
 * indicator, with a stop button.
 *
 * Environment:
 *   PRISM_PORTAL_RESTORE_TOKEN   the token of the previous run
 *   PRISM_PORTAL_APP_ID          app id registered with the portal (needs <app id>.desktop); GNOME binds global
 *                                shortcuts only for a registered app
 *   PRISM_TAKE_BACK_SHORTCUT     preferred trigger of the take-back shortcut, in the portal's syntax (CTRL+SHIFT+q),
 *                                bound through the GlobalShortcuts portal; without it, no shortcut
 *
 * First line: "ok <width> <height> <restore token or -> <shortcut as the desktop shows it, or ->", or "error ...".
 * Then the commands of prism-desktop-helper (size, move, button, click, scroll, keys, capture), plus:
 *   cursor                            ok <x> <y>: where the pointer is, in capture pixels
 * Keys are looked up in the desktop's keyboard layout: a character the layout cannot type is refused.
 *
 * Exit status: 3 when the sharing ends (the desktop's stop button), 4 when the user presses the take-back shortcut,
 * 1 on an error, 0 at the end of the input.
 */
// Not _GNU_SOURCE: with it, glibc 2.38+ headers bind sscanf and strtoul to versions that older systems lack.
#define _DEFAULT_SOURCE
#define GLIB_VERSION_MIN_REQUIRED GLIB_VERSION_2_64
#define GLIB_VERSION_MAX_ALLOWED GLIB_VERSION_2_64
#include <errno.h>
#include <gio/gio.h>
#include <gio/gunixfdlist.h>
#include <glib-unix.h>
#include <libei.h>
#include <linux/input-event-codes.h>
#include <pipewire/pipewire.h>
#include <spa/buffer/meta.h>
#include <spa/param/video/format-utils.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <xkbcommon/xkbcommon.h>

#define EXIT_SHARING_ENDED 3
#define EXIT_TAKEN_BACK 4
#define PORTAL "org.freedesktop.portal.Desktop"
#define PORTAL_PATH "/org/freedesktop/portal/desktop"
#define SHORTCUT_ID "take-back"

static GDBusConnection *bus;
static char *sender_part;
static unsigned token_count;

static struct ei *ei;
static struct ei_device *absolute, *keyboard, *buttons, *wheel;
static bool absolute_ready, keyboard_ready, buttons_ready, wheel_ready;
static uint32_t ei_sequence = 1;
static char *mapping_id;
static struct xkb_context *xkb;
static struct xkb_keymap *keymap;
static xkb_layout_index_t layout_group;

static struct pw_thread_loop *pw_loop;
static struct pw_stream *stream;
static struct spa_hook stream_listener;
/* Written by the PipeWire thread, read under the thread loop's lock. */
static struct spa_video_info_raw video;
static uint8_t *frame;
static uint32_t frame_width, frame_height;
static bool have_frame, have_cursor, stream_failed;
static int32_t cursor_x, cursor_y;
/* Monotonic times: of the last image, and of the agent's last input (main thread). */
static gint64 frame_time, input_time;

static void pause_ms(int ms) {
	struct timespec t = {ms / 1000, (long)(ms % 1000) * 1000000L};
	nanosleep(&t, NULL);
}

static gboolean on_waited(gpointer data) {
	*(bool *)data = true;
	return G_SOURCE_REMOVE;
}

/*
 * Waits ms while the GLib loop runs, between the events of a command: the take-back shortcut and the end of the
 * sharing are handled within a batch of keys, not after it. The command itself
 * cannot start again meanwhile: GLib does not dispatch the input watch from inside its own callback.
 */
static void wait_ms(int ms) {
	bool done = false;
	GSource *timer = g_timeout_source_new((guint)ms);
	g_source_set_callback(timer, on_waited, &done, NULL);
	g_source_attach(timer, NULL);
	while (!done) g_main_context_iteration(NULL, TRUE);
	g_source_destroy(timer);
	g_source_unref(timer);
}

static void answer(const char *format, ...) __attribute__((format(printf, 1, 2)));
static void answer(const char *format, ...) {
	va_list args;
	va_start(args, format);
	vprintf(format, args);
	va_end(args);
	putchar('\n');
	fflush(stdout);
}

static void fail(const char *format, ...) __attribute__((format(printf, 1, 2), noreturn));
static void fail(const char *format, ...) {
	va_list args;
	va_start(args, format);
	fputs("error ", stdout);
	vprintf(format, args);
	va_end(args);
	putchar('\n');
	fflush(stdout);
	exit(1);
}

/* ---- Portal requests: each method answers through a Request object's Response signal. ---- */

struct response {
	bool done;
	guint32 code;
	GVariant *results;
};

static void on_response(GDBusConnection *c, const char *sender, const char *path, const char *iface,
		const char *signal, GVariant *parameters, gpointer data) {
	struct response *r = data;
	g_variant_get(parameters, "(u@a{sv})", &r->code, &r->results);
	r->done = true;
}

static char *new_token(void) {
	return g_strdup_printf("prism%u_%u", (unsigned)getpid(), ++token_count);
}

/* Calls a method whose options hold handle_token = token, then waits for its answer (the user may take a while). */
static GVariant *portal_request(const char *iface, const char *method, const char *token, GVariant *args,
		guint32 *code, GError **error) {
	char *path = g_strdup_printf("/org/freedesktop/portal/desktop/request/%s/%s", sender_part, token);
	struct response r = {0};
	guint subscription = g_dbus_connection_signal_subscribe(bus, PORTAL, "org.freedesktop.portal.Request",
		"Response", path, NULL, G_DBUS_SIGNAL_FLAGS_NONE, on_response, &r, NULL);
	g_free(path);
	GVariant *handle = g_dbus_connection_call_sync(bus, PORTAL, PORTAL_PATH, iface, method, args,
		G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE, -1, NULL, error);
	if (!handle) {
		g_dbus_connection_signal_unsubscribe(bus, subscription);
		return NULL;
	}
	g_variant_unref(handle);
	while (!r.done) g_main_context_iteration(NULL, TRUE);
	g_dbus_connection_signal_unsubscribe(bus, subscription);
	*code = r.code;
	return r.results;
}

/* A method that answers with a file descriptor (ConnectToEIS, OpenPipeWireRemote). */
static int portal_fd(const char *iface, const char *method, const char *session, GError **error) {
	GUnixFDList *fds = NULL;
	GVariant *result = g_dbus_connection_call_with_unix_fd_list_sync(bus, PORTAL, PORTAL_PATH, iface, method,
		g_variant_new("(oa{sv})", session, NULL), G_VARIANT_TYPE("(h)"), G_DBUS_CALL_FLAGS_NONE, -1, NULL, &fds,
		NULL, error);
	if (!result) return -1;
	gint32 index;
	g_variant_get(result, "(h)", &index);
	g_variant_unref(result);
	int fd = g_unix_fd_list_get(fds, index, error);
	g_object_unref(fds);
	return fd;
}

static guint32 portal_property(const char *iface, const char *name) {
	GVariant *result = g_dbus_connection_call_sync(bus, PORTAL, PORTAL_PATH, "org.freedesktop.DBus.Properties",
		"Get", g_variant_new("(ss)", iface, name), G_VARIANT_TYPE("(v)"), G_DBUS_CALL_FLAGS_NONE, -1, NULL, NULL);
	if (!result) return 0;
	GVariant *value;
	g_variant_get(result, "(v)", &value);
	guint32 number = g_variant_is_of_type(value, G_VARIANT_TYPE_UINT32) ? g_variant_get_uint32(value) : 0;
	g_variant_unref(value);
	g_variant_unref(result);
	return number;
}

static void on_session_closed(GDBusConnection *c, const char *sender, const char *path, const char *iface,
		const char *signal, GVariant *parameters, gpointer data) {
	exit(EXIT_SHARING_ENDED);
}

static void release_held(void);

static void on_shortcut(GDBusConnection *c, const char *sender, const char *path, const char *iface,
		const char *signal, GVariant *parameters, gpointer data) {
	const char *session, *id;
	g_variant_get(parameters, "(&o&sta{sv})", &session, &id, NULL, NULL);
	if (strcmp(id, SHORTCUT_ID) || strcmp(session, data)) return;
	/* Taken back in the middle of a command: what the agent holds down is let go, then nothing more is sent. */
	release_held();
	exit(EXIT_TAKEN_BACK);
}

/* CreateSession of a portal interface: the session's object path. */
static char *create_session(const char *iface, GError **error) {
	char *token = new_token(), *session_token = new_token();
	GVariantBuilder options;
	g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
	g_variant_builder_add(&options, "{sv}", "handle_token", g_variant_new_string(token));
	g_variant_builder_add(&options, "{sv}", "session_handle_token", g_variant_new_string(session_token));
	guint32 code = 0;
	GVariant *results = portal_request(iface, "CreateSession", token, g_variant_new("(a{sv})", &options), &code, error);
	g_free(token);
	g_free(session_token);
	if (!results) return NULL;
	char *session = NULL;
	if (code == 0) g_variant_lookup(results, "session_handle", "s", &session);
	g_variant_unref(results);
	if (!session) g_set_error(error, G_IO_ERROR, G_IO_ERROR_FAILED, "the desktop refused the session");
	return session;
}

/* The take-back shortcut; the trigger as the desktop shows it, or NULL. */
static char *bind_shortcut(const char *trigger) {
	GError *error = NULL;
	char *session = create_session("org.freedesktop.portal.GlobalShortcuts", &error);
	if (!session) {
		g_clear_error(&error);
		return NULL;
	}
	char *token = new_token();
	GVariantBuilder shortcuts, properties, options;
	g_variant_builder_init(&properties, G_VARIANT_TYPE_VARDICT);
	g_variant_builder_add(&properties, "{sv}", "description",
		g_variant_new_string("Take your desktop back from Prism's agent"));
	g_variant_builder_add(&properties, "{sv}", "preferred_trigger", g_variant_new_string(trigger));
	g_variant_builder_init(&shortcuts, G_VARIANT_TYPE("a(sa{sv})"));
	g_variant_builder_add(&shortcuts, "(sa{sv})", SHORTCUT_ID, &properties);
	g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
	g_variant_builder_add(&options, "{sv}", "handle_token", g_variant_new_string(token));
	guint32 code = 0;
	GVariant *results = portal_request("org.freedesktop.portal.GlobalShortcuts", "BindShortcuts", token,
		g_variant_new("(oa(sa{sv})sa{sv})", session, &shortcuts, "", &options), &code, &error);
	g_free(token);
	char *shown = NULL;
	if (results && code == 0) {
		GVariant *bound = g_variant_lookup_value(results, "shortcuts", G_VARIANT_TYPE("a(sa{sv})"));
		GVariantIter iter;
		const char *id;
		GVariant *props;
		if (bound) {
			g_variant_iter_init(&iter, bound);
			while (!shown && g_variant_iter_next(&iter, "(&s@a{sv})", &id, &props)) {
				if (!strcmp(id, SHORTCUT_ID) && !g_variant_lookup(props, "trigger_description", "s", &shown))
					shown = g_strdup(trigger);
				g_variant_unref(props);
			}
			g_variant_unref(bound);
		}
	}
	if (results) g_variant_unref(results);
	g_clear_error(&error);
	if (!shown) {
		g_free(session);
		return NULL;
	}
	/* The session stays open: the shortcut works while it does. */
	g_dbus_connection_signal_subscribe(bus, PORTAL, "org.freedesktop.portal.GlobalShortcuts", "Activated",
		PORTAL_PATH, NULL, G_DBUS_SIGNAL_FLAGS_NONE, on_shortcut, session, NULL);
	return shown;
}

/* ---- libei: the desktop's virtual pointer and keyboard for this session. ---- */

static void load_keymap(struct ei_device *device) {
	struct ei_keymap *k = ei_device_keyboard_get_keymap(device);
	if (!k || ei_keymap_get_type(k) != EI_KEYMAP_TYPE_XKB) return;
	size_t size = ei_keymap_get_size(k);
	char *text = mmap(NULL, size, PROT_READ, MAP_PRIVATE, ei_keymap_get_fd(k), 0);
	if (text == MAP_FAILED) return;
	if (keymap) xkb_keymap_unref(keymap);
	keymap = xkb_keymap_new_from_buffer(xkb, text, strnlen(text, size), XKB_KEYMAP_FORMAT_TEXT_V1, 0);
	munmap(text, size);
}

static void ready(struct ei_device *device, bool state) {
	if (device == absolute) absolute_ready = state;
	if (device == keyboard) keyboard_ready = state;
	if (device == buttons) buttons_ready = state;
	if (device == wheel) wheel_ready = state;
}

static void keep(struct ei_device **slot, struct ei_device *device) {
	if (*slot) return;
	*slot = ei_device_ref(device);
}

static void pump_ei(void) {
	ei_dispatch(ei);
	struct ei_event *event;
	while ((event = ei_get_event(ei))) {
		struct ei_device *device = ei_event_get_device(event);
		switch (ei_event_get_type(event)) {
		case EI_EVENT_DISCONNECT:
			exit(EXIT_SHARING_ENDED);
		case EI_EVENT_SEAT_ADDED:
			ei_seat_bind_capabilities(ei_event_get_seat(event), EI_DEVICE_CAP_POINTER_ABSOLUTE, EI_DEVICE_CAP_BUTTON,
				EI_DEVICE_CAP_SCROLL, EI_DEVICE_CAP_KEYBOARD, NULL);
			break;
		case EI_EVENT_DEVICE_ADDED:
			if (ei_device_has_capability(device, EI_DEVICE_CAP_POINTER_ABSOLUTE)) keep(&absolute, device);
			if (ei_device_has_capability(device, EI_DEVICE_CAP_KEYBOARD) && !keyboard) {
				keep(&keyboard, device);
				load_keymap(device);
			}
			/* Buttons and wheel on the absolute pointer when it has them, else on another device. */
			if (ei_device_has_capability(device, EI_DEVICE_CAP_BUTTON) &&
				(!buttons || ei_device_has_capability(device, EI_DEVICE_CAP_POINTER_ABSOLUTE))) {
				if (buttons) ei_device_unref(buttons);
				buttons = ei_device_ref(device);
			}
			if (ei_device_has_capability(device, EI_DEVICE_CAP_SCROLL) &&
				(!wheel || ei_device_has_capability(device, EI_DEVICE_CAP_POINTER_ABSOLUTE))) {
				if (wheel) ei_device_unref(wheel);
				wheel = ei_device_ref(device);
			}
			break;
		case EI_EVENT_DEVICE_REMOVED:
			ready(device, false);
			break;
		case EI_EVENT_DEVICE_RESUMED:
			ei_device_start_emulating(device, ei_sequence++);
			ready(device, true);
			break;
		case EI_EVENT_DEVICE_PAUSED:
			ready(device, false);
			break;
		case EI_EVENT_KEYBOARD_MODIFIERS:
			layout_group = ei_event_keyboard_get_xkb_group(event);
			break;
		default:
			break;
		}
		ei_event_unref(event);
	}
}

static gboolean on_ei(int fd, GIOCondition condition, gpointer data) {
	pump_ei();
	return G_SOURCE_CONTINUE;
}

/* The region of the absolute pointer that shows the captured screen, in the desktop's coordinates. */
static struct ei_region *screen_region(void) {
	struct ei_region *region, *first = NULL;
	for (size_t i = 0; (region = ei_device_get_region(absolute, i)); i++) {
		const char *id = ei_region_get_mapping_id(region);
		if (mapping_id && id && !strcmp(id, mapping_id)) return region;
		if (!first) first = region;
	}
	return first;
}

static bool in_screen(long x, long y) { return x >= 0 && y >= 0 && x < (long)frame_width && y < (long)frame_height; }

static bool move_to(long x, long y) {
	struct ei_region *region = absolute_ready ? screen_region() : NULL;
	if (!region) return false;
	double rx = ei_region_get_x(region) + x * ei_region_get_width(region) / frame_width;
	double ry = ei_region_get_y(region) + y * ei_region_get_height(region) / frame_height;
	ei_device_pointer_motion_absolute(absolute, rx, ry);
	ei_device_frame(absolute, ei_now(ei));
	input_time = g_get_monotonic_time();
	pump_ei();
	return true;
}

/* What the agent holds down, let go when the user takes the desktop back. */
static int held_button = -1;
static xkb_keycode_t held_keys[8];
static int held_key_count;

static void press(int code, bool down) {
	ei_device_button_button(buttons, (uint32_t)code, down);
	ei_device_frame(buttons, ei_now(ei));
	input_time = g_get_monotonic_time();
	held_button = down ? code : -1;
	pump_ei();
}

static int button_code(const char *name) {
	if (!strcmp(name, "left")) return BTN_LEFT;
	if (!strcmp(name, "right")) return BTN_RIGHT;
	if (!strcmp(name, "middle")) return BTN_MIDDLE;
	return -1;
}

/* ---- Keys: a keysym becomes a key of the desktop's layout, with the modifiers its level needs. ---- */

struct stroke {
	xkb_keycode_t code;
	xkb_mod_mask_t mods;
};

#define MODIFIER_KEYS 5
/* Shift, Control, Alt, Super (the masks of prism-desktop-helper), then AltGr for third-level characters. */
static const uint32_t modifier_keysyms[MODIFIER_KEYS] = {0xffe1, 0xffe3, 0xffe9, 0xffeb, 0xfe03};
static const uint32_t modifier_bits[MODIFIER_KEYS] = {1, 4, 8, 64, 0};

/* The key that types keysym on the first level of the current layout, or 0. */
static xkb_keycode_t plain_key(uint32_t keysym) {
	xkb_keycode_t min = xkb_keymap_min_keycode(keymap), max = xkb_keymap_max_keycode(keymap);
	for (xkb_keycode_t code = min; code <= max; code++) {
		const xkb_keysym_t *syms;
		if (xkb_keymap_key_get_syms_by_level(keymap, code, layout_group, 0, &syms) == 1 && syms[0] == keysym)
			return code;
	}
	return 0;
}

/* The modifiers a key sets (from the keymap itself, whatever its modifier names). */
static xkb_mod_mask_t key_mods(xkb_keycode_t code) {
	if (!code) return 0;
	struct xkb_state *state = xkb_state_new(keymap);
	xkb_state_update_key(state, code, XKB_KEY_DOWN);
	xkb_mod_mask_t mods = xkb_state_serialize_mods(state, XKB_STATE_MODS_DEPRESSED);
	xkb_state_unref(state);
	return mods;
}

static bool same_symbol(xkb_keysym_t a, uint32_t b) {
	if (a == b) return true;
	uint32_t ua = xkb_keysym_to_utf32(a);
	return ua && ua == xkb_keysym_to_utf32(b);
}

/*
 * The key and modifier keys that type keysym: every key is tried with no modifier, Shift, AltGr and both, through a
 * state of the keymap, so the layout's own rules decide.
 */
static bool find_stroke(uint32_t keysym, struct stroke *out, xkb_keycode_t modifier_codes[MODIFIER_KEYS]) {
	xkb_mod_mask_t shift = key_mods(modifier_codes[0]), level3 = key_mods(modifier_codes[4]);
	const xkb_mod_mask_t tries[4] = {0, shift, level3, shift | level3};
	xkb_keycode_t min = xkb_keymap_min_keycode(keymap), max = xkb_keymap_max_keycode(keymap);
	struct xkb_state *state = xkb_state_new(keymap);
	for (int t = 0; t < 4; t++) {
		if (t > 0 && (!tries[t] || (t == 2 && !level3) || (t == 3 && (!shift || !level3)))) continue;
		xkb_state_update_mask(state, tries[t], 0, 0, 0, 0, layout_group);
		for (xkb_keycode_t code = min; code <= max; code++) {
			if (!same_symbol(xkb_state_key_get_one_sym(state, code), keysym)) continue;
			out->code = code;
			out->mods = (t & 1 ? 1u : 0u) | (t & 2 ? 2u : 0u);
			xkb_state_unref(state);
			return true;
		}
	}
	xkb_state_unref(state);
	return false;
}

static void send_key(xkb_keycode_t code, bool down) {
	/* libei numbers keys as evdev does: xkb keycode minus 8. */
	ei_device_keyboard_key(keyboard, code - 8, down);
	ei_device_frame(keyboard, ei_now(ei));
	input_time = g_get_monotonic_time();
	pump_ei();
}

static void key(xkb_keycode_t code, bool down) {
	send_key(code, down);
	if (down && held_key_count < (int)G_N_ELEMENTS(held_keys)) held_keys[held_key_count++] = code;
	if (!down)
		for (int i = held_key_count - 1; i >= 0; i--)
			if (held_keys[i] == code) {
				memmove(&held_keys[i], &held_keys[i + 1], (size_t)(held_key_count - i - 1) * sizeof held_keys[0]);
				held_key_count--;
				break;
			}
	wait_ms(8);
}

static void release_held(void) {
	while (held_key_count > 0) send_key(held_keys[--held_key_count], false);
	if (held_button >= 0) press(held_button, false);
}

static void command_keys(char *rest) {
	if (!keyboard_ready || !keymap) {
		answer("error the desktop does not take the agent's keys right now");
		return;
	}
	char *save = NULL;
	char *token = strtok_r(rest, " ", &save);
	if (!token) {
		answer("error keys needs modifiers and keysyms");
		return;
	}
	uint32_t mods = (uint32_t)strtoul(token, NULL, 10);
	static struct stroke strokes[256];
	int n = 0;
	xkb_keycode_t modifier_codes[MODIFIER_KEYS];
	for (int m = 0; m < MODIFIER_KEYS; m++) modifier_codes[m] = plain_key(modifier_keysyms[m]);
	while ((token = strtok_r(NULL, " ", &save)) && n < 256) {
		uint32_t keysym = (uint32_t)strtoul(token, NULL, 16);
		if (!find_stroke(keysym, &strokes[n], modifier_codes)) {
			uint32_t character = xkb_keysym_to_utf32(keysym);
			if (character) answer("error the keyboard layout of this desktop cannot type U+%04X", character);
			else answer("error the keyboard layout of this desktop has no key for keysym 0x%x", keysym);
			return;
		}
		n++;
	}
	if (!n) {
		answer("error keys needs at least one keysym");
		return;
	}
	for (int m = 0; m < MODIFIER_KEYS - 1; m++) {
		if (!(mods & modifier_bits[m])) continue;
		if (!modifier_codes[m]) {
			answer("error the keyboard layout of this desktop has no key for this modifier");
			return;
		}
	}
	for (int m = 0; m < MODIFIER_KEYS - 1; m++)
		if (mods & modifier_bits[m]) key(modifier_codes[m], true);
	for (int i = 0; i < n; i++) {
		bool shift = (strokes[i].mods & 1) && !(mods & 1), level3 = strokes[i].mods & 2;
		if (shift) key(modifier_codes[0], true);
		if (level3) key(modifier_codes[4], true);
		key(strokes[i].code, true);
		key(strokes[i].code, false);
		if (level3) key(modifier_codes[4], false);
		if (shift) key(modifier_codes[0], false);
	}
	for (int m = MODIFIER_KEYS - 2; m >= 0; m--)
		if (mods & modifier_bits[m]) key(modifier_codes[m], false);
	answer("ok");
}

/* ---- PipeWire: the screen's stream; the last frame and the pointer position are kept. ---- */

#define CURSOR_META_SIZE(w, h) \
	((int)(sizeof(struct spa_meta_cursor) + sizeof(struct spa_meta_bitmap) + (size_t)(w) * (h) * 4))

static void on_param_changed(void *data, uint32_t id, const struct spa_pod *param) {
	if (!param || id != SPA_PARAM_Format) return;
	uint32_t media_type, media_subtype;
	if (spa_format_parse(param, &media_type, &media_subtype) < 0 || media_type != SPA_MEDIA_TYPE_video ||
		media_subtype != SPA_MEDIA_SUBTYPE_raw)
		return;
	struct spa_video_info_raw info = {0};
	if (spa_format_video_raw_parse(param, &info) < 0) return;
	video = info;
	uint8_t buffer[1024];
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
	const struct spa_pod *params[2];
	params[0] = spa_pod_builder_add_object(&b, SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers,
		SPA_PARAM_BUFFERS_dataType, SPA_POD_CHOICE_FLAGS_Int((1 << SPA_DATA_MemPtr) | (1 << SPA_DATA_MemFd)));
	params[1] = spa_pod_builder_add_object(&b, SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta, SPA_PARAM_META_type,
		SPA_POD_Id(SPA_META_Cursor), SPA_PARAM_META_size,
		SPA_POD_CHOICE_RANGE_Int(CURSOR_META_SIZE(64, 64), CURSOR_META_SIZE(1, 1), CURSOR_META_SIZE(512, 512)));
	pw_stream_update_params(stream, params, 2);
}

static void on_state_changed(void *data, enum pw_stream_state old, enum pw_stream_state state, const char *error) {
	if (state == PW_STREAM_STATE_ERROR || state == PW_STREAM_STATE_UNCONNECTED) stream_failed = true;
}

static void on_process(void *data) {
	struct pw_buffer *b = NULL, *next;
	while ((next = pw_stream_dequeue_buffer(stream))) {
		if (b) pw_stream_queue_buffer(stream, b);
		b = next;
	}
	if (!b) return;
	struct spa_buffer *buffer = b->buffer;
	struct spa_meta_cursor *cursor = spa_buffer_find_meta_data(buffer, SPA_META_Cursor, sizeof(*cursor));
	if (cursor && spa_meta_cursor_is_valid(cursor)) {
		cursor_x = cursor->position.x;
		cursor_y = cursor->position.y;
		have_cursor = true;
	}
	struct spa_data *d = &buffer->datas[0];
	uint32_t w = video.size.width, h = video.size.height;
	/* A buffer without pixels only moves the pointer. */
	if (d->data && d->chunk->size > 0 && !(d->chunk->flags & SPA_CHUNK_FLAG_CORRUPTED) && w && h) {
		int32_t stride = d->chunk->stride ? d->chunk->stride : (int32_t)(w * 4);
		if ((uint64_t)d->chunk->offset + (uint64_t)stride * (h - 1) + (uint64_t)w * 4 <= d->maxsize) {
			if (w != frame_width || h != frame_height || !frame) {
				free(frame);
				frame = malloc((size_t)w * h * 4);
				frame_width = frame ? w : 0;
				frame_height = frame ? h : 0;
			}
			if (frame) {
				const uint8_t *src = (const uint8_t *)d->data + d->chunk->offset;
				for (uint32_t y = 0; y < h; y++) memcpy(frame + (size_t)y * w * 4, src + (size_t)y * stride, (size_t)w * 4);
				have_frame = true;
				frame_time = g_get_monotonic_time();
			}
		}
	}
	pw_stream_queue_buffer(stream, b);
}

static const struct pw_stream_events stream_events = {
	PW_VERSION_STREAM_EVENTS,
	.state_changed = on_state_changed,
	.param_changed = on_param_changed,
	.process = on_process,
};

static void start_stream(int fd, uint32_t node) {
	pw_init(NULL, NULL);
	pw_loop = pw_thread_loop_new("prism-capture", NULL);
	struct pw_context *context = pw_context_new(pw_thread_loop_get_loop(pw_loop), NULL, 0);
	pw_thread_loop_lock(pw_loop);
	if (pw_thread_loop_start(pw_loop) < 0) fail("could not start the capture thread");
	struct pw_core *core = pw_context_connect_fd(context, fd, NULL, 0);
	if (!core) fail("could not reach the desktop's screen stream: %s", strerror(errno));
	stream = pw_stream_new(core, "prism-capture",
		pw_properties_new(PW_KEY_MEDIA_TYPE, "Video", PW_KEY_MEDIA_CATEGORY, "Capture", PW_KEY_MEDIA_ROLE, "Screen",
			NULL));
	pw_stream_add_listener(stream, &stream_listener, &stream_events, NULL);
	uint8_t buffer[1024];
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
	const struct spa_pod *params[1];
	struct spa_rectangle size = SPA_RECTANGLE(1920, 1080), min_size = SPA_RECTANGLE(1, 1),
		max_size = SPA_RECTANGLE(16384, 16384);
	struct spa_fraction rate = SPA_FRACTION(30, 1), min_rate = SPA_FRACTION(0, 1), max_rate = SPA_FRACTION(1000, 1);
	params[0] = spa_pod_builder_add_object(&b, SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat, SPA_FORMAT_mediaType,
		SPA_POD_Id(SPA_MEDIA_TYPE_video), SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
		SPA_FORMAT_VIDEO_format,
		SPA_POD_CHOICE_ENUM_Id(5, SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_BGRx, SPA_VIDEO_FORMAT_RGBx,
			SPA_VIDEO_FORMAT_BGRA, SPA_VIDEO_FORMAT_RGBA),
		SPA_FORMAT_VIDEO_size, SPA_POD_CHOICE_RANGE_Rectangle(&size, &min_size, &max_size),
		SPA_FORMAT_VIDEO_framerate, SPA_POD_CHOICE_RANGE_Fraction(&rate, &min_rate, &max_rate));
	if (pw_stream_connect(stream, PW_DIRECTION_INPUT, node, PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS,
			params, 1) < 0)
		fail("could not open the desktop's screen stream");
	pw_thread_loop_unlock(pw_loop);
}

/*
 * The desktop sends an image when the screen changes, a frame or two after it does: after the agent's input, the
 * capture waits for an image drawn after it, a little while at most (a click that changes nothing sends none). An
 * image within FRESH_US of the input may still show the screen before it.
 */
#define SETTLE_US (300 * 1000)
#define FRESH_US (30 * 1000)

static void command_capture(const char *path) {
	pw_thread_loop_lock(pw_loop);
	while (input_time && frame_time <= input_time + FRESH_US && g_get_monotonic_time() < input_time + SETTLE_US) {
		pw_thread_loop_unlock(pw_loop);
		pause_ms(10);
		pw_thread_loop_lock(pw_loop);
	}
	if (!have_frame) {
		pw_thread_loop_unlock(pw_loop);
		answer("error the desktop has sent no image yet");
		return;
	}
	FILE *out = fopen(path, "wbx");
	if (!out) {
		pw_thread_loop_unlock(pw_loop);
		answer("error could not write %s: %s", path, strerror(errno));
		return;
	}
	uint32_t w = frame_width, h = frame_height;
	bool bgr = video.format == SPA_VIDEO_FORMAT_BGRx || video.format == SPA_VIDEO_FORMAT_BGRA;
	uint8_t *row = malloc((size_t)w * 4);
	bool ok = row != NULL;
	for (uint32_t y = 0; ok && y < h; y++) {
		const uint8_t *src = frame + (size_t)y * w * 4;
		for (uint32_t x = 0; x < w; x++) {
			row[x * 4 + 0] = src[x * 4 + (bgr ? 2 : 0)];
			row[x * 4 + 1] = src[x * 4 + 1];
			row[x * 4 + 2] = src[x * 4 + (bgr ? 0 : 2)];
			row[x * 4 + 3] = 255;
		}
		if (fwrite(row, 4, w, out) != w) ok = false;
	}
	pw_thread_loop_unlock(pw_loop);
	free(row);
	if (fclose(out) != 0) ok = false;
	if (ok) answer("ok %u %u", w, h);
	else answer("error could not write %s", path);
}

/* ---- Commands. ---- */

static void run(char *line) {
	char *save = NULL;
	char *name = strtok_r(line, " ", &save);
	char *rest = save ? save : "";
	if (!name) {
		answer("error empty command");
		return;
	}
	long x = 0, y = 0;
	if (!strcmp(name, "size")) {
		answer("ok %u %u", frame_width, frame_height);
	} else if (!strcmp(name, "cursor")) {
		pw_thread_loop_lock(pw_loop);
		bool known = have_cursor;
		int32_t cx = cursor_x, cy = cursor_y;
		pw_thread_loop_unlock(pw_loop);
		if (known) answer("ok %d %d", cx, cy);
		else answer("error the desktop does not tell where the pointer is");
	} else if (!strcmp(name, "move")) {
		if (sscanf(rest, "%ld %ld", &x, &y) != 2 || !in_screen(x, y)) {
			answer("error move needs a point inside %ux%u", frame_width, frame_height);
			return;
		}
		if (!move_to(x, y)) answer("error the desktop does not take the agent's pointer right now");
		else answer("ok");
	} else if (!strcmp(name, "button")) {
		char which[16], state[8];
		int code;
		if (sscanf(rest, "%15s %7s", which, state) != 2 || (code = button_code(which)) < 0 ||
			(strcmp(state, "down") && strcmp(state, "up"))) {
			answer("error button needs left, right or middle, then down or up");
			return;
		}
		if (!buttons_ready) {
			answer("error the desktop does not take the agent's buttons right now");
			return;
		}
		press(code, !strcmp(state, "down"));
		answer("ok");
	} else if (!strcmp(name, "click")) {
		char which[16];
		int count, code;
		if (sscanf(rest, "%ld %ld %15s %d", &x, &y, which, &count) != 4 || !in_screen(x, y) ||
			(code = button_code(which)) < 0 || count < 1 || count > 3) {
			answer("error click needs a point inside %ux%u, a button and a count from 1 to 3", frame_width,
				frame_height);
			return;
		}
		if (!buttons_ready || !move_to(x, y)) {
			answer("error the desktop does not take the agent's pointer right now");
			return;
		}
		wait_ms(30);
		for (int i = 0; i < count; i++) {
			press(code, true);
			wait_ms(20);
			press(code, false);
			wait_ms(40);
		}
		answer("ok");
	} else if (!strcmp(name, "scroll")) {
		long dx, dy;
		if (sscanf(rest, "%ld %ld %ld %ld", &x, &y, &dx, &dy) != 4 || !in_screen(x, y) || labs(dx) > 100 ||
			labs(dy) > 100) {
			answer("error scroll needs a point inside %ux%u and at most 100 steps", frame_width, frame_height);
			return;
		}
		if (!wheel_ready || !move_to(x, y)) {
			answer("error the desktop does not take the agent's pointer right now");
			return;
		}
		wait_ms(30);
		/* One wheel step is 120 in libei's discrete scrolling. */
		ei_device_scroll_discrete(wheel, (int32_t)dx * 120, (int32_t)dy * 120);
		ei_device_frame(wheel, ei_now(ei));
		input_time = g_get_monotonic_time();
		pump_ei();
		answer("ok");
	} else if (!strcmp(name, "keys")) {
		command_keys(rest);
	} else if (!strcmp(name, "capture")) {
		while (*rest == ' ') rest++;
		if (!*rest) {
			answer("error capture needs a path");
			return;
		}
		command_capture(rest);
	} else {
		answer("error unknown command %s", name);
	}
}

static gboolean on_input(GIOChannel *channel, GIOCondition condition, gpointer data) {
	/* Several lines may wait in the channel's buffer: the descriptor would not wake us for them. */
	do {
		char *line = NULL;
		GIOStatus status = g_io_channel_read_line(channel, &line, NULL, NULL, NULL);
		if (status == G_IO_STATUS_EOF || status == G_IO_STATUS_ERROR) exit(0);
		if (!line) break;
		g_strchomp(line);
		run(line);
		g_free(line);
	} while (g_io_channel_get_buffer_condition(channel) & G_IO_IN);
	return G_SOURCE_CONTINUE;
}

/* ---- Start: the sharing session, the input devices, the stream, the shortcut. ---- */

static void add_string(GVariantBuilder *options, const char *key, const char *value) {
	g_variant_builder_add(options, "{sv}", key, g_variant_new_string(value));
}

static void add_uint(GVariantBuilder *options, const char *key, guint32 value) {
	g_variant_builder_add(options, "{sv}", key, g_variant_new_uint32(value));
}

static GVariant *session_step(const char *iface, const char *method, const char *session, GVariantBuilder *options,
		const char *token, bool with_parent) {
	GError *error = NULL;
	guint32 code = 0;
	GVariant *args = with_parent ? g_variant_new("(osa{sv})", session, "", options)
		: g_variant_new("(oa{sv})", session, options);
	GVariant *results = portal_request(iface, method, token, args, &code, &error);
	if (!results) fail("the desktop's portal refused %s: %s", method, error->message);
	if (code == 1) fail("the user declined to share their screen");
	if (code != 0) fail("the desktop's portal could not %s", method);
	return results;
}

int main(void) {
	GError *error = NULL;
	bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
	if (!bus) fail("cannot reach the session bus: %s", error->message);
	sender_part = g_strdup(g_dbus_connection_get_unique_name(bus) + 1);
	for (char *c = sender_part; *c; c++)
		if (*c == '.') *c = '_';

	/* The app id must come first: the portal fixes it at the first call. */
	const char *app_id = getenv("PRISM_PORTAL_APP_ID");
	if (app_id && *app_id) {
		GVariant *registered = g_dbus_connection_call_sync(bus, PORTAL, PORTAL_PATH,
			"org.freedesktop.host.portal.Registry", "Register", g_variant_new("(sa{sv})", app_id, NULL), NULL,
			G_DBUS_CALL_FLAGS_NONE, -1, NULL, NULL);
		if (registered) g_variant_unref(registered);
	}

	if (portal_property("org.freedesktop.portal.RemoteDesktop", "version") < 2)
		fail("this desktop's portal cannot share input with the agent (RemoteDesktop 2 or later needed)");
	/* The take-back shortcut before the screen: KDE asks the user to confirm it in a dialog, which must come before the
	 * agent gets their desktop, not after. */
	const char *trigger = getenv("PRISM_TAKE_BACK_SHORTCUT");
	char *shown = trigger && *trigger ? bind_shortcut(trigger) : NULL;
	if (shown)
		for (char *c = shown; *c; c++)
			if (*c == '\n' || *c == '\r') *c = ' ';
	const char *remote = "org.freedesktop.portal.RemoteDesktop", *cast = "org.freedesktop.portal.ScreenCast";
	char *session = create_session(remote, &error);
	if (!session) fail("the desktop's portal refused the session: %s", error->message);
	g_dbus_connection_signal_subscribe(bus, PORTAL, "org.freedesktop.portal.Session", "Closed", session, NULL,
		G_DBUS_SIGNAL_FLAGS_NONE, on_session_closed, NULL, NULL);

	GVariantBuilder options;
	char *token = new_token();
	g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
	add_string(&options, "handle_token", token);
	add_uint(&options, "types", 1 | 2); /* keyboard, pointer */
	add_uint(&options, "persist_mode", 2); /* until the user revokes it */
	const char *restore = getenv("PRISM_PORTAL_RESTORE_TOKEN");
	if (restore && *restore) add_string(&options, "restore_token", restore);
	g_variant_unref(session_step(remote, "SelectDevices", session, &options, token, false));
	g_free(token);

	token = new_token();
	g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
	add_string(&options, "handle_token", token);
	add_uint(&options, "types", 1); /* a monitor */
	g_variant_builder_add(&options, "{sv}", "multiple", g_variant_new_boolean(FALSE));
	/* The pointer's position as metadata: Prism sees when the user moves the mouse, the image stays without it. */
	guint32 cursor_modes = portal_property(cast, "AvailableCursorModes");
	add_uint(&options, "cursor_mode", cursor_modes & 4 ? 4 : 1);
	g_variant_unref(session_step(cast, "SelectSources", session, &options, token, false));
	g_free(token);

	token = new_token();
	g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
	add_string(&options, "handle_token", token);
	GVariant *started = session_step(remote, "Start", session, &options, token, true);
	g_free(token);
	guint32 devices = 0;
	g_variant_lookup(started, "devices", "u", &devices);
	if ((devices & 3) != 3)
		fail("the user shared the screen without allowing remote interaction: the agent cannot use the pointer or keyboard");
	char *new_restore = NULL;
	g_variant_lookup(started, "restore_token", "s", &new_restore);
	GVariant *streams = g_variant_lookup_value(started, "streams", G_VARIANT_TYPE("a(ua{sv})"));
	if (!streams || g_variant_n_children(streams) == 0) fail("the desktop shared no screen");
	guint32 node;
	GVariant *stream_props;
	g_variant_get_child(streams, 0, "(u@a{sv})", &node, &stream_props);
	g_variant_lookup(stream_props, "mapping_id", "s", &mapping_id);

	int eis_fd = portal_fd(remote, "ConnectToEIS", session, &error);
	if (eis_fd < 0) fail("the desktop's portal gave no input connection: %s", error->message);
	int pw_fd = portal_fd(cast, "OpenPipeWireRemote", session, &error);
	if (pw_fd < 0) fail("the desktop's portal gave no screen stream: %s", error->message);

	xkb = xkb_context_new(XKB_CONTEXT_NO_DEFAULT_INCLUDES | XKB_CONTEXT_NO_ENVIRONMENT_NAMES);
	ei = ei_new_sender(NULL);
	ei_configure_name(ei, "Prism agent");
	if (ei_setup_backend_fd(ei, eis_fd) < 0) fail("could not open the desktop's input connection");
	g_unix_fd_add(ei_get_fd(ei), G_IO_IN, on_ei, NULL);
	start_stream(pw_fd, node);

	/* Ready when the pointer and keyboard are given and the first image has come. */
	gint64 deadline = g_get_monotonic_time() + 10 * G_USEC_PER_SEC;
	for (;;) {
		while (g_main_context_iteration(NULL, FALSE)) {}
		pump_ei();
		pw_thread_loop_lock(pw_loop);
		bool image = have_frame, broken = stream_failed;
		pw_thread_loop_unlock(pw_loop);
		if (broken) fail("the desktop's screen stream failed");
		if (image && absolute_ready && keyboard_ready && buttons_ready && keymap) break;
		if (g_get_monotonic_time() > deadline) {
			fail("the desktop did not give %s in time", !image ? "the screen's image"
				: !keymap ? "the keyboard layout" : "the pointer and keyboard");
		}
		pause_ms(10);
	}

	answer("ok %u %u %s %s", frame_width, frame_height, new_restore && *new_restore ? new_restore : "-",
		shown && *shown ? shown : "-");

	GIOChannel *input = g_io_channel_unix_new(0);
	g_io_channel_set_encoding(input, NULL, NULL);
	g_io_add_watch(input, G_IO_IN | G_IO_HUP | G_IO_ERR, on_input, NULL);
	g_main_loop_run(g_main_loop_new(NULL, FALSE));
	return 0;
}
