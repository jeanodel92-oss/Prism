/*
 * prism-desktop-helper: mouse, keyboard and screen capture for the agent's own desktop.
 *
 * Prism starts it with WAYLAND_DISPLAY pointing at the separate compositor. Node cannot pass a file
 * descriptor over a Unix socket, and both the virtual keyboard's keymap and the capture buffer need one,
 * hence this small client. It needs only libwayland-client at run time.
 *
 * PRISM_DESKTOP_OUTPUT names the screen to drive and capture (wl_output name, e.g. eDP-1); without it, the
 * first screen. On the user's own desktop (Hyprland), Prism names the screen the user is on.
 *
 * One command per line on stdin, one answer per line on stdout: "ok [values]" or "error <message>".
 *   size                              ok <width> <height>
 *   move <x> <y>
 *   button <left|right|middle> <down|up>
 *   click <x> <y> <left|right|middle> <count>
 *   scroll <x> <y> <dx> <dy>          wheel steps; positive dy scrolls down
 *   keys <mods> <keysym>...           hex keysyms, each pressed and released while <mods> are held
 *                                     (bit mask: shift 1, ctrl 4, alt 8, super 64)
 *   capture <path>                    ok <width> <height>; writes width * height RGBA pixels to <path>
 *   a11y-wait, elements, do, focus, settext: the accessibility tree of the agent's desktop (prism-a11y.c)
 *
 * With PRISM_A11Y (the agent's own desktop, never the user's), it also follows the compositor's windows
 * (wlr-foreign-toplevel): elements lists them first, and focus refuses an element whose window is not in front.
 */
// Not _GNU_SOURCE: with it, glibc 2.38+ headers bind sscanf and strtoul to versions that older systems lack.
// memfd_create is called through syscall() for the same reason.
#define _DEFAULT_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/input-event-codes.h>
#include <linux/memfd.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>

#include "virtual-keyboard-unstable-v1-client-protocol.h"
#include "wlr-foreign-toplevel-management-unstable-v1-client-protocol.h"
#include "wlr-screencopy-unstable-v1-client-protocol.h"
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"

static int shared_memory(const char *name) {
	return (int)syscall(SYS_memfd_create, name, MFD_CLOEXEC);
}

static struct wl_display *display;
static struct wl_seat *seat;
static struct wl_shm *shm;
static struct wl_output *output;
static struct zwlr_virtual_pointer_manager_v1 *pointer_manager;
static struct zwp_virtual_keyboard_manager_v1 *keyboard_manager;
static struct zwlr_screencopy_manager_v1 *screencopy_manager;
static struct zwlr_virtual_pointer_v1 *pointer;
static struct zwp_virtual_keyboard_v1 *keyboard;
static uint32_t pointer_version;
static int32_t width, height;

/* The keymap holds one keycode per keysym used so far; it is sent again when a new keysym appears. */
#define MAX_KEYS 240
static uint32_t keysyms[MAX_KEYS];
static int key_count;
static int keymap_sent_count = -1;

static uint32_t now_ms(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (uint32_t)(t.tv_sec * 1000 + t.tv_nsec / 1000000);
}

static void pause_ms(int ms) {
	struct timespec t = {ms / 1000, (long)(ms % 1000) * 1000000L};
	nanosleep(&t, NULL);
}

/* Every screen, to pick the one PRISM_DESKTOP_OUTPUT names. */
#define MAX_OUTPUTS 16
static struct screen {
	struct wl_output *output;
	int32_t width, height;
	char name[64];
} screens[MAX_OUTPUTS];
static int screen_count;

static void output_geometry(void *data, struct wl_output *o, int32_t x, int32_t y, int32_t pw, int32_t ph,
		int32_t subpixel, const char *make, const char *model, int32_t transform) {}
static void output_mode(void *data, struct wl_output *o, uint32_t flags, int32_t w, int32_t h, int32_t refresh) {
	struct screen *screen = data;
	if (flags & WL_OUTPUT_MODE_CURRENT) {
		screen->width = w;
		screen->height = h;
	}
}
static void output_done(void *data, struct wl_output *o) {}
static void output_scale(void *data, struct wl_output *o, int32_t factor) {}
static void output_name(void *data, struct wl_output *o, const char *name) {
	struct screen *screen = data;
	snprintf(screen->name, sizeof screen->name, "%s", name);
}
static void output_description(void *data, struct wl_output *o, const char *description) {}
static const struct wl_output_listener output_listener = {
	.geometry = output_geometry,
	.mode = output_mode,
	.done = output_done,
	.scale = output_scale,
	.name = output_name,
	.description = output_description,
};

static uint32_t min_version(uint32_t a, uint32_t b) { return a < b ? a : b; }

/*
 * The compositor's windows. A dialog missing from the accessibility tree still takes the keys (LibreOffice's welcome,
 * at its first start, while the tree called the Calc window active): only the compositor knows the window in front.
 * Followed on the agent's own desktop only: on the user's, the titles are the user's.
 */
#define MAX_TOPLEVELS 64
static struct zwlr_foreign_toplevel_manager_v1 *toplevel_manager;
static struct toplevel {
	struct zwlr_foreign_toplevel_handle_v1 *handle;
	char title[256];
	char app_id[128];
	int active, minimized;
} toplevels[MAX_TOPLEVELS];

/* Tabs and line breaks would split the listing's lines. */
static void copy_line(char *to, size_t size, const char *from) {
	snprintf(to, size, "%s", from ? from : "");
	for (char *p = to; *p; p++)
		if (*p == '\t' || *p == '\n' || *p == '\r') *p = ' ';
}

static void toplevel_title(void *data, struct zwlr_foreign_toplevel_handle_v1 *h, const char *title) {
	struct toplevel *t = data;
	copy_line(t->title, sizeof t->title, title);
}
static void toplevel_app_id(void *data, struct zwlr_foreign_toplevel_handle_v1 *h, const char *app_id) {
	struct toplevel *t = data;
	copy_line(t->app_id, sizeof t->app_id, app_id);
}
static void toplevel_output_enter(void *data, struct zwlr_foreign_toplevel_handle_v1 *h, struct wl_output *o) {}
static void toplevel_output_leave(void *data, struct zwlr_foreign_toplevel_handle_v1 *h, struct wl_output *o) {}
static void toplevel_state(void *data, struct zwlr_foreign_toplevel_handle_v1 *h, struct wl_array *states) {
	struct toplevel *t = data;
	t->active = t->minimized = 0;
	uint32_t *state;
	wl_array_for_each(state, states) {
		if (*state == ZWLR_FOREIGN_TOPLEVEL_HANDLE_V1_STATE_ACTIVATED) t->active = 1;
		if (*state == ZWLR_FOREIGN_TOPLEVEL_HANDLE_V1_STATE_MINIMIZED) t->minimized = 1;
	}
}
static void toplevel_done(void *data, struct zwlr_foreign_toplevel_handle_v1 *h) {}
static void toplevel_closed(void *data, struct zwlr_foreign_toplevel_handle_v1 *h) {
	struct toplevel *t = data;
	zwlr_foreign_toplevel_handle_v1_destroy(h);
	memset(t, 0, sizeof *t);
}
static void toplevel_parent(void *data, struct zwlr_foreign_toplevel_handle_v1 *h,
		struct zwlr_foreign_toplevel_handle_v1 *parent) {}
static const struct zwlr_foreign_toplevel_handle_v1_listener toplevel_listener = {
	.title = toplevel_title,
	.app_id = toplevel_app_id,
	.output_enter = toplevel_output_enter,
	.output_leave = toplevel_output_leave,
	.state = toplevel_state,
	.done = toplevel_done,
	.closed = toplevel_closed,
	.parent = toplevel_parent,
};

static void manager_toplevel(void *data, struct zwlr_foreign_toplevel_manager_v1 *m,
		struct zwlr_foreign_toplevel_handle_v1 *handle) {
	for (int i = 0; i < MAX_TOPLEVELS; i++) {
		if (toplevels[i].handle) continue;
		toplevels[i].handle = handle;
		zwlr_foreign_toplevel_handle_v1_add_listener(handle, &toplevel_listener, &toplevels[i]);
		return;
	}
	zwlr_foreign_toplevel_handle_v1_destroy(handle);
}
static void manager_finished(void *data, struct zwlr_foreign_toplevel_manager_v1 *m) {
	zwlr_foreign_toplevel_manager_v1_destroy(m);
	toplevel_manager = NULL;
}
static const struct zwlr_foreign_toplevel_manager_v1_listener manager_listener = {
	.toplevel = manager_toplevel,
	.finished = manager_finished,
};

/* Writes "T <tab> <1 if in front, else 0> <tab> <app id> <tab> <title>" per shown window; -1 without the protocol. */
int toplevels_list(FILE *out) {
	if (!toplevel_manager || wl_display_roundtrip(display) < 0) return -1;
	int count = 0;
	for (int i = 0; i < MAX_TOPLEVELS; i++) {
		struct toplevel *t = &toplevels[i];
		if (!t->handle || t->minimized) continue;
		fprintf(out, "T\t%d\t%s\t%s\n", t->active, t->app_id, t->title);
		count++;
	}
	return count;
}

/* The title of the window in front, "" when none is; NULL when the compositor does not say. */
const char *front_title(void) {
	if (!toplevel_manager || wl_display_roundtrip(display) < 0) return NULL;
	for (int i = 0; i < MAX_TOPLEVELS; i++)
		if (toplevels[i].handle && toplevels[i].active) return toplevels[i].title;
	return "";
}

static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
	if (!strcmp(interface, wl_seat_interface.name) && !seat) {
		seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
	} else if (!strcmp(interface, wl_shm_interface.name)) {
		shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
	} else if (!strcmp(interface, wl_output_interface.name) && screen_count < MAX_OUTPUTS) {
		struct screen *screen = &screens[screen_count++];
		screen->output = wl_registry_bind(registry, name, &wl_output_interface, min_version(version, 4));
		wl_output_add_listener(screen->output, &output_listener, screen);
	} else if (!strcmp(interface, zwlr_virtual_pointer_manager_v1_interface.name)) {
		pointer_version = min_version(version, 2);
		pointer_manager = wl_registry_bind(registry, name, &zwlr_virtual_pointer_manager_v1_interface, pointer_version);
	} else if (!strcmp(interface, zwp_virtual_keyboard_manager_v1_interface.name)) {
		keyboard_manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
	} else if (!strcmp(interface, zwlr_foreign_toplevel_manager_v1_interface.name) && getenv("PRISM_A11Y") &&
		!toplevel_manager) {
		toplevel_manager =
			wl_registry_bind(registry, name, &zwlr_foreign_toplevel_manager_v1_interface, min_version(version, 3));
		zwlr_foreign_toplevel_manager_v1_add_listener(toplevel_manager, &manager_listener, NULL);
	} else if (!strcmp(interface, zwlr_screencopy_manager_v1_interface.name)) {
		screencopy_manager =
			wl_registry_bind(registry, name, &zwlr_screencopy_manager_v1_interface, min_version(version, 3));
	}
}
static void global_remove(void *data, struct wl_registry *registry, uint32_t name) {}
static const struct wl_registry_listener registry_listener = {global, global_remove};

int a11y_run(const char *name, char *rest);

static int answer(const char *format, ...) __attribute__((format(printf, 1, 2)));
static int answer(const char *format, ...) {
	va_list args;
	va_start(args, format);
	vprintf(format, args);
	va_end(args);
	putchar('\n');
	fflush(stdout);
	return 0;
}

static int flush(void) {
	if (wl_display_roundtrip(display) < 0) {
		answer("error the desktop closed the connection");
		exit(1);
	}
	return 0;
}

static int button_code(const char *name) {
	if (!strcmp(name, "left")) return BTN_LEFT;
	if (!strcmp(name, "right")) return BTN_RIGHT;
	if (!strcmp(name, "middle")) return BTN_MIDDLE;
	return -1;
}

static int in_screen(long x, long y) { return x >= 0 && y >= 0 && x < width && y < height; }

static void move_to(long x, long y) {
	zwlr_virtual_pointer_v1_motion_absolute(pointer, now_ms(), (uint32_t)x, (uint32_t)y, (uint32_t)width,
		(uint32_t)height);
	zwlr_virtual_pointer_v1_frame(pointer);
	flush();
}

static void press(int code, int down) {
	zwlr_virtual_pointer_v1_button(pointer, now_ms(), (uint32_t)code,
		down ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
	zwlr_virtual_pointer_v1_frame(pointer);
	flush();
}

static void scroll_axis(uint32_t axis, long steps) {
	if (!steps) return;
	uint32_t time = now_ms();
	if (pointer_version >= 2) {
		zwlr_virtual_pointer_v1_axis_source(pointer, WL_POINTER_AXIS_SOURCE_WHEEL);
		zwlr_virtual_pointer_v1_axis_discrete(pointer, time, axis, wl_fixed_from_int((int)steps * 15), (int32_t)steps);
	} else {
		zwlr_virtual_pointer_v1_axis(pointer, time, axis, wl_fixed_from_int((int)steps * 15));
	}
	zwlr_virtual_pointer_v1_frame(pointer);
	flush();
}

static int send_keymap(void) {
	size_t size = 0;
	char *text = NULL;
	FILE *f = open_memstream(&text, &size);
	if (!f) return -1;
	fprintf(f, "xkb_keymap {\nxkb_keycodes \"prism\" {\nminimum = 8;\nmaximum = %d;\n", 9 + MAX_KEYS);
	for (int i = 0; i < key_count; i++) fprintf(f, "<K%d> = %d;\n", i, i + 9);
	fprintf(f, "};\nxkb_types \"prism\" { include \"complete\" };\n");
	fprintf(f, "xkb_compatibility \"prism\" { include \"complete\" };\nxkb_symbols \"prism\" {\n");
	for (int i = 0; i < key_count; i++) fprintf(f, "key <K%d> {[ 0x%x ]};\n", i, keysyms[i]);
	fprintf(f, "};\n};\n");
	fclose(f);
	int fd = shared_memory("prism-keymap");
	if (fd < 0) {
		free(text);
		return -1;
	}
	ssize_t written = write(fd, text, size + 1);
	free(text);
	if (written != (ssize_t)(size + 1)) {
		close(fd);
		return -1;
	}
	zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, (uint32_t)(size + 1));
	close(fd);
	flush();
	/* The compositor applies a new keymap after a short while; keys sent before are lost. */
	pause_ms(100);
	keymap_sent_count = key_count;
	return 0;
}

/* The keycode (evdev numbering) of a keysym, adding it to the keymap when needed. */
static int keycode_for(uint32_t keysym) {
	for (int i = 0; i < key_count; i++)
		if (keysyms[i] == keysym) return i + 1;
	if (key_count == MAX_KEYS) {
		key_count = 0;
		/* fork: a new keymap may reach the old one's size; it must be sent. */
		keymap_sent_count = -1;
	}
	keysyms[key_count++] = keysym;
	return key_count;
}

static void command_keys(char *rest) {
	char *save = NULL;
	char *token = strtok_r(rest, " ", &save);
	if (!token) {
		answer("error keys needs modifiers and keysyms");
		return;
	}
	uint32_t mods = (uint32_t)strtoul(token, NULL, 10);
	uint32_t list[256];
	int n = 0;
	while ((token = strtok_r(NULL, " ", &save)) && n < 256) list[n++] = (uint32_t)strtoul(token, NULL, 16);
	if (!n) {
		answer("error keys needs at least one keysym");
		return;
	}
	if (n > MAX_KEYS) {
		answer("error too many keys at once");
		return;
	}
	/* A long text may need more keycodes than the keymap holds: start a new keymap then. */
	int needed = 0;
	for (int i = 0; i < n; i++) {
		int known = 0;
		for (int k = 0; k < key_count; k++) known |= keysyms[k] == list[i];
		needed += !known;
	}
	if (key_count + needed > MAX_KEYS) {
		key_count = 0;
		/* fork: the new keymap can have as many keys as the one the compositor
		 * holds; comparing sizes alone then skipped sending it and the codes typed the old keymap's characters. */
		keymap_sent_count = -1;
	}
	int codes[256];
	for (int i = 0; i < n; i++) codes[i] = keycode_for(list[i]);
	if (keymap_sent_count != key_count && send_keymap() < 0) {
		answer("error could not send the keymap: %s", strerror(errno));
		return;
	}
	if (mods) {
		zwp_virtual_keyboard_v1_modifiers(keyboard, mods, 0, 0, 0);
		flush();
	}
	for (int i = 0; i < n; i++) {
		zwp_virtual_keyboard_v1_key(keyboard, now_ms(), (uint32_t)codes[i], WL_KEYBOARD_KEY_STATE_PRESSED);
		flush();
		pause_ms(8);
		zwp_virtual_keyboard_v1_key(keyboard, now_ms(), (uint32_t)codes[i], WL_KEYBOARD_KEY_STATE_RELEASED);
		flush();
		pause_ms(8);
	}
	if (mods) {
		zwp_virtual_keyboard_v1_modifiers(keyboard, 0, 0, 0, 0);
		flush();
	}
	answer("ok");
}

struct capture {
	uint32_t format, width, height, stride;
	int have_buffer, done, failed, y_invert;
};

static void frame_buffer(void *data, struct zwlr_screencopy_frame_v1 *frame, uint32_t format, uint32_t w, uint32_t h,
		uint32_t stride) {
	struct capture *c = data;
	if (c->have_buffer) return;
	if (format != WL_SHM_FORMAT_XRGB8888 && format != WL_SHM_FORMAT_ARGB8888 && format != WL_SHM_FORMAT_XBGR8888 &&
		format != WL_SHM_FORMAT_ABGR8888)
		return;
	c->format = format;
	c->width = w;
	c->height = h;
	c->stride = stride;
	c->have_buffer = 1;
}
static void frame_flags(void *data, struct zwlr_screencopy_frame_v1 *frame, uint32_t flags) {
	((struct capture *)data)->y_invert = flags & ZWLR_SCREENCOPY_FRAME_V1_FLAGS_Y_INVERT;
}
static void frame_ready(void *data, struct zwlr_screencopy_frame_v1 *frame, uint32_t hi, uint32_t lo, uint32_t ns) {
	((struct capture *)data)->done = 1;
}
static void frame_failed(void *data, struct zwlr_screencopy_frame_v1 *frame) {
	((struct capture *)data)->failed = 1;
}
static void frame_damage(void *data, struct zwlr_screencopy_frame_v1 *frame, uint32_t x, uint32_t y, uint32_t w,
		uint32_t h) {}
static void frame_dmabuf(void *data, struct zwlr_screencopy_frame_v1 *frame, uint32_t format, uint32_t w, uint32_t h) {}
static void frame_buffer_done(void *data, struct zwlr_screencopy_frame_v1 *frame) {}
static const struct zwlr_screencopy_frame_v1_listener frame_listener = {
	frame_buffer, frame_flags, frame_ready, frame_failed, frame_damage, frame_dmabuf, frame_buffer_done,
};

static void command_capture(const char *path) {
	if (!screencopy_manager || !shm || !output) {
		answer("error this desktop does not allow screen capture");
		return;
	}
	struct capture c = {0};
	struct zwlr_screencopy_frame_v1 *frame = zwlr_screencopy_manager_v1_capture_output(screencopy_manager, 0, output);
	zwlr_screencopy_frame_v1_add_listener(frame, &frame_listener, &c);
	flush();
	if (!c.have_buffer) {
		zwlr_screencopy_frame_v1_destroy(frame);
		answer("error the desktop offers no supported pixel format");
		return;
	}
	size_t size = (size_t)c.stride * c.height;
	int fd = shared_memory("prism-capture");
	if (fd < 0 || ftruncate(fd, (off_t)size) < 0) {
		if (fd >= 0) close(fd);
		zwlr_screencopy_frame_v1_destroy(frame);
		answer("error could not allocate the capture: %s", strerror(errno));
		return;
	}
	uint8_t *pixels = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (pixels == MAP_FAILED) {
		close(fd);
		zwlr_screencopy_frame_v1_destroy(frame);
		answer("error could not map the capture: %s", strerror(errno));
		return;
	}
	struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, (int32_t)size);
	struct wl_buffer *buffer =
		wl_shm_pool_create_buffer(pool, 0, (int32_t)c.width, (int32_t)c.height, (int32_t)c.stride, c.format);
	wl_shm_pool_destroy(pool);
	close(fd);
	zwlr_screencopy_frame_v1_copy(frame, buffer);
	while (!c.done && !c.failed) {
		if (wl_display_dispatch(display) < 0) {
			answer("error the desktop closed the connection");
			exit(1);
		}
	}
	int ok = c.done;
	if (ok) {
		FILE *out = fopen(path, "wbx");
		if (!out) {
			ok = 0;
			answer("error could not write %s: %s", path, strerror(errno));
		} else {
			uint8_t *row = malloc((size_t)c.width * 4);
			int bgr = c.format == WL_SHM_FORMAT_XRGB8888 || c.format == WL_SHM_FORMAT_ARGB8888;
			for (uint32_t y = 0; row && y < c.height; y++) {
				const uint8_t *src = pixels + (size_t)(c.y_invert ? c.height - 1 - y : y) * c.stride;
				/* Little-endian xRGB is B, G, R, x in memory; xBGR is R, G, B, x. */
				for (uint32_t x = 0; x < c.width; x++) {
					row[x * 4 + 0] = src[x * 4 + (bgr ? 2 : 0)];
					row[x * 4 + 1] = src[x * 4 + 1];
					row[x * 4 + 2] = src[x * 4 + (bgr ? 0 : 2)];
					row[x * 4 + 3] = 255;
				}
				if (fwrite(row, 4, c.width, out) != c.width) ok = 0;
			}
			if (!row) ok = 0;
			free(row);
			if (fclose(out) != 0) ok = 0;
			if (ok) answer("ok %u %u", c.width, c.height);
			else answer("error could not write %s", path);
		}
	} else {
		answer("error the desktop refused the capture");
	}
	munmap(pixels, size);
	wl_buffer_destroy(buffer);
	zwlr_screencopy_frame_v1_destroy(frame);
}

static void run(char *line) {
	char *save = NULL;
	char *name = strtok_r(line, " ", &save);
	char *rest = save;
	if (!name) {
		answer("error empty command");
		return;
	}
	long x = 0, y = 0;
	if (!strcmp(name, "size")) {
		answer("ok %d %d", width, height);
	} else if (!strcmp(name, "move")) {
		if (sscanf(rest, "%ld %ld", &x, &y) != 2 || !in_screen(x, y)) {
			answer("error move needs a point inside %dx%d", width, height);
			return;
		}
		move_to(x, y);
		answer("ok");
	} else if (!strcmp(name, "button")) {
		char which[16], state[8];
		int code;
		if (sscanf(rest, "%15s %7s", which, state) != 2 || (code = button_code(which)) < 0 ||
			(strcmp(state, "down") && strcmp(state, "up"))) {
			answer("error button needs left, right or middle, then down or up");
			return;
		}
		press(code, !strcmp(state, "down"));
		answer("ok");
	} else if (!strcmp(name, "click")) {
		char which[16];
		int count, code;
		if (sscanf(rest, "%ld %ld %15s %d", &x, &y, which, &count) != 4 || !in_screen(x, y) ||
			(code = button_code(which)) < 0 || count < 1 || count > 3) {
			answer("error click needs a point inside %dx%d, a button and a count from 1 to 3", width, height);
			return;
		}
		move_to(x, y);
		pause_ms(30);
		for (int i = 0; i < count; i++) {
			press(code, 1);
			pause_ms(20);
			press(code, 0);
			pause_ms(40);
		}
		answer("ok");
	} else if (!strcmp(name, "scroll")) {
		long dx, dy;
		if (sscanf(rest, "%ld %ld %ld %ld", &x, &y, &dx, &dy) != 4 || !in_screen(x, y) || labs(dx) > 100 ||
			labs(dy) > 100) {
			answer("error scroll needs a point inside %dx%d and at most 100 steps", width, height);
			return;
		}
		move_to(x, y);
		pause_ms(30);
		scroll_axis(WL_POINTER_AXIS_VERTICAL_SCROLL, dy);
		scroll_axis(WL_POINTER_AXIS_HORIZONTAL_SCROLL, dx);
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
	} else if (a11y_run(name, rest)) {
	} else {
		answer("error unknown command %s", name);
	}
}

int main(void) {
	display = wl_display_connect(NULL);
	if (!display) {
		answer("error cannot reach the desktop (WAYLAND_DISPLAY)");
		return 1;
	}
	struct wl_registry *registry = wl_display_get_registry(display);
	wl_registry_add_listener(registry, &registry_listener, NULL);
	wl_display_roundtrip(display);
	wl_display_roundtrip(display);
	const char *wanted = getenv("PRISM_DESKTOP_OUTPUT");
	for (int i = 0; i < screen_count && !output; i++) {
		if (wanted && *wanted && strcmp(screens[i].name, wanted)) continue;
		output = screens[i].output;
		width = screens[i].width;
		height = screens[i].height;
	}
	if (wanted && *wanted && !output) {
		answer("error no screen named %s", wanted);
		return 1;
	}
	if (!seat || !output || !pointer_manager || !keyboard_manager) {
		answer("error this desktop lacks a seat, an output, or the virtual pointer and keyboard protocols");
		return 1;
	}
	pointer = pointer_version >= 2
		? zwlr_virtual_pointer_manager_v1_create_virtual_pointer_with_output(pointer_manager, seat, output)
		: zwlr_virtual_pointer_manager_v1_create_virtual_pointer(pointer_manager, seat);
	keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(keyboard_manager, seat);
	flush();
	answer("ok %d %d", width, height);
	char *line = NULL;
	size_t capacity = 0;
	ssize_t length;
	while ((length = getline(&line, &capacity, stdin)) > 0) {
		if (line[length - 1] == '\n') line[length - 1] = 0;
		run(line);
	}
	free(line);
	wl_display_disconnect(display);
	return 0;
}
