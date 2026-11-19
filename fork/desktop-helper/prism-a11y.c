/*
 * The accessibility tree of the agent's own desktop, for
 * prism-desktop-helper: the elements of its windows (role, name, state, text) and actions on them by reference,
 * which need no screen position (under Wayland, programs give positions in their own window only).
 *
 * libatspi is loaded when first needed, not linked: without it, the helper still drives the desktop. It is used only
 * when PRISM_A11Y is set: Prism sets it with AT_SPI_BUS_ADDRESS, the accessibility bus of the agent's desktop.
 * Without that address, libatspi would find the user's own accessibility bus, and every program of theirs.
 *
 *   a11y-wait <ms>             ok once the desktop's accessibility registry answers
 *   elements <path>            ok <count> [truncated]; writes one element per line to <path>, with references
 *                              that never repeat in a run, valid until the next elements:
 *                              compositor's   T <tab> <1 if in front, else 0> <tab> <app id> <tab> <title>, first
 *                              window lines   W <tab> <ref> <tab> <application> <tab> <role> <tab> <title> <tab> <states>
 *                              element lines  E <tab> <ref> <tab> <depth> <tab> <role> <tab> <name> <tab> <states> <tab> <text>
 *                              (in a text, \n is a line break and \\ a backslash)
 *   do <ref>                   ok <action>; runs the element's main action (click, press, activate…)
 *   focus <ref>                ok once the element has the keyboard focus in the window in front; keys typed
 *                              next go there (an error otherwise: they would go to another window)
 *   settext <ref> <text>       ok; replaces the text of an editable element (\n: line break, \\: backslash)
 */
#define _DEFAULT_SOURCE
#include <dlfcn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* The AT-SPI D-Bus specification's values (atspi-constants.h), stable across versions. */
enum {
	STATE_ACTIVE = 1,
	STATE_CHECKED = 4,
	STATE_COLLAPSED = 5,
	STATE_DEFUNCT = 6,
	STATE_EDITABLE = 7,
	STATE_EXPANDED = 10,
	STATE_FOCUSED = 12,
	STATE_MODAL = 16,
	STATE_PRESSED = 20,
	STATE_SELECTED = 23,
	STATE_SENSITIVE = 24,
	STATE_SHOWING = 25,
	STATE_VISIBLE = 30,
	STATE_INDETERMINATE = 32,
};
/* AtspiCoordType */
enum { COORD_WINDOW = 1 };

typedef struct {
	uint32_t domain;
	int code;
	char *message;
} GError;
typedef void Obj;
/* GLib's GArray: what atspi_accessible_get_relation_set returns. */
typedef struct {
	char *data;
	unsigned len;
} GArray;
/* AtspiRelationType */
enum { RELATION_LABELLED_BY = 2 };

/* The compositor's windows (prism-desktop-helper.c). */
int toplevels_list(FILE *out);
const char *front_title(void);

static struct {
	int (*init)(void);
	void (*set_timeout)(int, int);
	Obj *(*get_desktop)(int);
	int (*child_count)(Obj *, GError **);
	Obj *(*child_at)(Obj *, int, GError **);
	char *(*name)(Obj *, GError **);
	char *(*role_name)(Obj *, GError **);
	Obj *(*state_set)(Obj *);
	int (*state_contains)(Obj *, int);
	Obj *(*action_iface)(Obj *);
	int (*n_actions)(Obj *, GError **);
	char *(*action_name)(Obj *, int, GError **);
	int (*do_action)(Obj *, int, GError **);
	Obj *(*text_iface)(Obj *);
	int (*char_count)(Obj *, GError **);
	char *(*get_text)(Obj *, int, int, GError **);
	Obj *(*editable_iface)(Obj *);
	int (*set_text)(Obj *, const char *, GError **);
	Obj *(*component_iface)(Obj *);
	int (*grab_focus)(Obj *, GError **);
	void *(*get_extents)(Obj *, int, GError **);
	GArray *(*relation_set)(Obj *, GError **);
	int (*relation_type)(Obj *);
	int (*relation_targets)(Obj *);
	Obj *(*relation_target)(Obj *, int);
	char *(*array_free)(GArray *, int);
	Obj *(*table_iface)(Obj *);
	int (*table_rows)(Obj *, GError **);
	int (*table_columns)(Obj *, GError **);
	Obj *(*table_cell_at)(Obj *, int, int, GError **);
	Obj *(*at_point)(Obj *, int, int, int, GError **);
	Obj *(*cell_iface)(Obj *);
	int (*cell_position)(Obj *, int *, int *, GError **);
	void (*unref)(void *);
	void (*g_free)(void *);
	void (*error_free)(GError *);
} at;

static int loaded; /* 0 not tried, 1 ready, -1 unavailable */
static const char *why = "";

#define MAX_REFS 4000
#define MAX_NODES 20000
#define WALK_MS 8000
#define TEXT_CHARS 300
static Obj *refs[MAX_REFS + 1];
/* The window of each listed element (an index of refs). */
static int window_of[MAX_REFS + 1];
static int ref_count;
/* The first reference of the latest listing is ref_base + 1: an older one is refused, never taken for another. */
static long ref_base;

static int reply(const char *format, ...) __attribute__((format(printf, 1, 2)));
static int reply(const char *format, ...) {
	va_list args;
	va_start(args, format);
	vprintf(format, args);
	va_end(args);
	putchar('\n');
	fflush(stdout);
	return 1;
}

static int load(void) {
	if (loaded) return loaded;
	loaded = -1;
	if (!getenv("PRISM_A11Y") || !getenv("AT_SPI_BUS_ADDRESS")) {
		why = "this desktop has no accessibility bus of its own";
		return loaded;
	}
	void *lib = dlopen("libatspi.so.0", RTLD_NOW | RTLD_LOCAL);
	if (!lib) {
		why = "libatspi is not installed (package at-spi2-core or libatspi2.0-0)";
		return loaded;
	}
	struct {
		void **slot;
		const char *symbol;
	} symbols[] = {
		{(void **)&at.init, "atspi_init"},
		{(void **)&at.set_timeout, "atspi_set_timeout"},
		{(void **)&at.get_desktop, "atspi_get_desktop"},
		{(void **)&at.child_count, "atspi_accessible_get_child_count"},
		{(void **)&at.child_at, "atspi_accessible_get_child_at_index"},
		{(void **)&at.name, "atspi_accessible_get_name"},
		{(void **)&at.role_name, "atspi_accessible_get_role_name"},
		{(void **)&at.state_set, "atspi_accessible_get_state_set"},
		{(void **)&at.state_contains, "atspi_state_set_contains"},
		{(void **)&at.action_iface, "atspi_accessible_get_action_iface"},
		{(void **)&at.n_actions, "atspi_action_get_n_actions"},
		{(void **)&at.action_name, "atspi_action_get_action_name"},
		{(void **)&at.do_action, "atspi_action_do_action"},
		{(void **)&at.text_iface, "atspi_accessible_get_text_iface"},
		{(void **)&at.char_count, "atspi_text_get_character_count"},
		{(void **)&at.get_text, "atspi_text_get_text"},
		{(void **)&at.editable_iface, "atspi_accessible_get_editable_text_iface"},
		{(void **)&at.set_text, "atspi_editable_text_set_text_contents"},
		{(void **)&at.component_iface, "atspi_accessible_get_component_iface"},
		{(void **)&at.grab_focus, "atspi_component_grab_focus"},
		{(void **)&at.get_extents, "atspi_component_get_extents"},
		{(void **)&at.relation_set, "atspi_accessible_get_relation_set"},
		{(void **)&at.relation_type, "atspi_relation_get_relation_type"},
		{(void **)&at.relation_targets, "atspi_relation_get_n_targets"},
		{(void **)&at.relation_target, "atspi_relation_get_target"},
		{(void **)&at.array_free, "g_array_free"},
		{(void **)&at.table_iface, "atspi_accessible_get_table_iface"},
		{(void **)&at.table_rows, "atspi_table_get_n_rows"},
		{(void **)&at.table_columns, "atspi_table_get_n_columns"},
		{(void **)&at.table_cell_at, "atspi_table_get_accessible_at"},
		{(void **)&at.at_point, "atspi_component_get_accessible_at_point"},
		{(void **)&at.cell_iface, "atspi_accessible_get_table_cell"},
		{(void **)&at.cell_position, "atspi_table_cell_get_position"},
		{(void **)&at.unref, "g_object_unref"},
		{(void **)&at.g_free, "g_free"},
		{(void **)&at.error_free, "g_error_free"},
	};
	for (size_t i = 0; i < sizeof symbols / sizeof symbols[0]; i++) {
		*symbols[i].slot = dlsym(lib, symbols[i].symbol);
		if (!*symbols[i].slot) {
			why = "libatspi lacks a function Prism needs";
			return loaded;
		}
	}
	at.init();
	/* A program that hangs costs one second per call, not the default 25. */
	at.set_timeout(1000, 1000);
	loaded = 1;
	return loaded;
}

static long now_ms(void) {
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec * 1000L + t.tv_nsec / 1000000;
}

static void forget(GError **error) {
	if (*error) at.error_free(*error);
	*error = NULL;
}

/* Tabs, newlines and the object replacement character (U+FFFC, an embedded child) become spaces. */
static void clean(char *s) {
	unsigned char *p = (unsigned char *)s;
	for (; *p; p++) {
		if (*p == '\t' || *p == '\n' || *p == '\r') *p = ' ';
		else if (p[0] == 0xEF && p[1] == 0xBF && p[2] == 0xBC) p[0] = p[1] = p[2] = ' ';
	}
}

/* A text kept on one line of the listing: \n for a line break, \\ for a backslash, a tab as a space, \r dropped;
 * the object replacement character becomes a space. */
static void escape_text(const char *s, char *out, size_t size) {
	size_t used = 0;
	for (const unsigned char *p = (const unsigned char *)s; *p && used + 3 < size; p++) {
		if (*p == '\n' || *p == '\\') {
			out[used++] = '\\';
			out[used++] = *p == '\n' ? 'n' : '\\';
		} else if (*p == '\r') {
			continue;
		} else if (*p == '\t') {
			out[used++] = ' ';
		} else if (p[0] == 0xEF && p[1] == 0xBF && p[2] == 0xBC) {
			out[used++] = ' ';
			p += 2;
		} else {
			out[used++] = (char)*p;
		}
	}
	out[used] = 0;
}

static char *own(char *s) {
	if (!s) return strdup("");
	char *copy = strdup(s);
	at.g_free(s);
	clean(copy);
	return copy;
}

static void states(Obj *set, char *out, size_t size) {
	static const struct {
		int state;
		const char *word;
	} words[] = {
		{STATE_ACTIVE, "active"},     {STATE_FOCUSED, "focused"},   {STATE_CHECKED, "checked"},
		{STATE_INDETERMINATE, "mixed"}, {STATE_PRESSED, "pressed"}, {STATE_SELECTED, "selected"},
		{STATE_EXPANDED, "expanded"}, {STATE_COLLAPSED, "collapsed"}, {STATE_EDITABLE, "editable"},
		{STATE_MODAL, "modal"},
	};
	out[0] = 0;
	size_t used = 0;
	for (size_t i = 0; i < sizeof words / sizeof words[0]; i++) {
		if (!at.state_contains(set, words[i].state)) continue;
		used += snprintf(out + used, used < size ? size - used : 0, "%s%s", used ? "," : "", words[i].word);
	}
	if (!at.state_contains(set, STATE_SENSITIVE) && used < size)
		snprintf(out + used, size - used, "%sdisabled", used ? "," : "");
}

/*
 * The name an element without one takes from what labels it ("labelled-by"): GTK 4's menu items have no name, their
 * label is only there, unnamed, with its text (measured on GTK 4.22, a GtkPopoverMenu). Empty when nothing labels it.
 */
static char *label_of(Obj *node) {
	GError *error = NULL;
	GArray *relations = at.relation_set(node, &error);
	forget(&error);
	char *found = NULL;
	if (!relations) return strdup("");
	Obj **items = (Obj **)relations->data;
	for (unsigned r = 0; r < relations->len; r++) {
		if (!found && at.relation_type(items[r]) == RELATION_LABELLED_BY) {
			int targets = at.relation_targets(items[r]);
			for (int i = 0; i < targets && !found; i++) {
				Obj *target = at.relation_target(items[r], i);
				if (!target) continue;
				char *name = own(at.name(target, &error));
				forget(&error);
				if (!name[0]) {
					free(name);
					name = NULL;
					Obj *text = at.text_iface(target);
					if (text) {
						int count = at.char_count(text, &error);
						forget(&error);
						char *s = count > 0 ? at.get_text(text, 0, count < TEXT_CHARS ? count : TEXT_CHARS, &error) : NULL;
						forget(&error);
						if (s) name = own(s);
						at.unref(text);
					}
				}
				if (name && name[0]) found = name;
				else free(name);
				at.unref(target);
			}
		}
		at.unref(items[r]);
	}
	at.array_free(relations, 1);
	return found ? found : strdup("");
}

/* Roles that only group others: listed only when they carry an action. */
static int container(const char *role) {
	static const char *roles[] = {"filler", "panel", "section", "scroll pane", "viewport", "layered pane",
		"split pane", "internal frame", "redundant object", "unknown", "invalid", "grouping", "block quote",
		"form", "landmark", "article", "table row", "tool bar", "menu bar", "page tab list", "tree", "table",
		"list", "tree table", "status bar", "glass pane", "option pane", "root pane", "desktop frame", "canvas",
		"description list", "footer", "header", "info bar", "content deletion", "content insertion", "mark",
		"suggestion", "embedded", "image map", "drawing area"};
	for (size_t i = 0; i < sizeof roles / sizeof roles[0]; i++)
		if (!strcmp(role, roles[i])) return 1;
	return 0;
}

static struct walk {
	FILE *out;
	int nodes;
	long deadline;
	int truncated;
	int window;
	/* Inside a large table: its cells without text, focus or selection are left out. */
	int sparse;
	/* How many visits are under way, one inside the other; and whether a subtree deeper than MAX_NESTING was left
	 * out. */
	int nesting;
	int deep;
} walk;

static int keep(Obj *node) {
	if (ref_count >= MAX_REFS) {
		walk.truncated = 1;
		return 0;
	}
	refs[++ref_count] = node;
	window_of[ref_count] = walk.window ? walk.window : ref_count;
	return ref_count;
}

/* Roles worth listing without a name: what can be clicked or changed. */
static int control(const char *role) {
	static const char *roles[] = {"push button", "button", "toggle button", "check box", "radio button", "menu item",
		"check menu item", "radio menu item", "link", "page tab", "combo box", "list item", "table cell",
		"tree item", "slider", "spin button", "icon", "menu", "switch"};
	for (size_t i = 0; i < sizeof roles / sizeof roles[0]; i++)
		if (!strcmp(role, roles[i])) return 1;
	return 0;
}

static int quiet(const char *role) {
	return !strcmp(role, "text") || !strcmp(role, "label") || !strcmp(role, "static") || !strcmp(role, "paragraph");
}

/* A table with more children than this is walked by the cells on the screen only (LibreOffice Calc: 2^31 - 1). */
#define LARGE_TABLE 5000
#define REGION_ROWS 100
#define REGION_COLUMNS 50

typedef struct {
	int x, y, width, height;
} Rect;

typedef struct {
	int first_row, last_row, first_column, last_column, rows, columns, measured;
} Region;

/* The row and column of the cell at a point of the table, in its window's coordinates. */
static int cell_at(Obj *component, int x, int y, int *row, int *column) {
	GError *error = NULL;
	Obj *cell = at.at_point(component, x, y, COORD_WINDOW, &error);
	forget(&error);
	if (!cell) return 0;
	Obj *position = at.cell_iface(cell);
	int found = position && at.cell_position(position, row, column, &error) && !error;
	forget(&error);
	if (position) at.unref(position);
	at.unref(cell);
	return found;
}

/*
 * The cells of a large table on the screen: those at its corners give the range. Walking every child instead read
 * 16 384 cells for each row of a Calc sheet, and an elements listing took 5 to 8 s for 2 rows.
 * When the corners cannot be read, the table's top left corner, as large as REGION_ROWS by REGION_COLUMNS.
 */
static int table_region(Obj *node, Obj *table, Region *region) {
	GError *error = NULL;
	region->rows = at.table_rows(table, &error);
	forget(&error);
	region->columns = at.table_columns(table, &error);
	forget(&error);
	if (region->rows <= 0 || region->columns <= 0) return 0;
	region->measured = 0;
	Obj *component = at.component_iface(node);
	if (component) {
		Rect *rect = at.get_extents(component, COORD_WINDOW, &error);
		forget(&error);
		if (rect && rect->width > 2 && rect->height > 2) {
			int r0, c0, r1, c1;
			if (cell_at(component, rect->x + 1, rect->y + 1, &r0, &c0) &&
				cell_at(component, rect->x + rect->width - 2, rect->y + rect->height - 2, &r1, &c1) && r1 >= r0 &&
				c1 >= c0) {
				*region = (Region){r0, r1, c0, c1, region->rows, region->columns, 1};
			}
		}
		if (rect) at.g_free(rect);
		at.unref(component);
	}
	if (!region->measured) {
		region->first_row = region->first_column = 0;
		region->last_row = region->rows - 1;
		region->last_column = region->columns - 1;
	}
	if (region->last_row - region->first_row >= REGION_ROWS) region->last_row = region->first_row + REGION_ROWS - 1;
	if (region->last_column - region->first_column >= REGION_COLUMNS)
		region->last_column = region->first_column + REGION_COLUMNS - 1;
	return 1;
}

/*
 * fork: visit recurses once per level of the tree, a few KiB of stack each. A window
 * of 4 000 nested boxes stopped the helper (stack overflow). Below MAX_NESTING levels, a subtree is left out and the
 * listing says it is truncated; its siblings are still walked.
 */
#define MAX_NESTING 512
static void visit(Obj *node, int depth, const char *above);

/* above: the name of the nearest listed element, which a child repeating it only echoes (a button's label). */
static void visit_node(Obj *node, int depth, const char *above) {
	if (++walk.nodes > MAX_NODES || now_ms() > walk.deadline) {
		walk.truncated = 1;
		at.unref(node);
		return;
	}
	GError *error = NULL;
	Obj *set = at.state_set(node);
	int showing = set && at.state_contains(set, STATE_SHOWING) && at.state_contains(set, STATE_VISIBLE);
	if (!showing) {
		if (set) at.unref(set);
		/* A hidden wrapper with one child is passed through: WebKitGTK (the Prism window, Tauri) puts its page,
		 * shown, under fillers and a scroll pane that never say they are. Anything wider stays pruned, so a
		 * hidden tab or panel is not walked. */
		Obj *only = at.child_count(node, &error) == 1 ? at.child_at(node, 0, &error) : NULL;
		forget(&error);
		at.unref(node);
		if (only) visit(only, depth, above);
		return;
	}
	char *role = own(at.role_name(node, &error));
	forget(&error);
	/* Firefox keeps the "showing" state of a page's elements as first read until a client asks where they are:
	 * after a scroll, the rows that left the screen were still listed and the new ones never were. Asking for the
	 * page's position once keeps them current (measured on Firefox 156, a page of 80 rows). */
	if (!strcmp(role, "document web")) {
		Obj *component = at.component_iface(node);
		if (component) {
			void *rect = at.get_extents(component, COORD_WINDOW, &error);
			forget(&error);
			if (rect) at.g_free(rect);
			at.unref(component);
		}
	}
	char *name = own(at.name(node, &error));
	forget(&error);
	if (!name[0]) {
		free(name);
		name = label_of(node);
	}
	int children = at.child_count(node, &error);
	forget(&error);
	Obj *action = at.action_iface(node);
	int actions = action ? at.n_actions(action, &error) : 0;
	forget(&error);
	if (action) at.unref(action);
	int editable = at.state_contains(set, STATE_EDITABLE);
	/* Up to 4 bytes a character, twice that for the escapes, and "…". */
	char text[TEXT_CHARS * 8 + 8] = "";
	/* The text of a leaf or of a field, never of a password field. */
	if ((children <= 0 || editable) && strcmp(role, "password text")) {
		Obj *t = at.text_iface(node);
		if (t) {
			int count = at.char_count(t, &error);
			forget(&error);
			if (count > 0) {
				char *s = at.get_text(t, 0, count < TEXT_CHARS ? count : TEXT_CHARS, &error);
				forget(&error);
				if (s) {
					escape_text(s, text, sizeof text - 4);
					if (count > TEXT_CHARS) strcat(text, "…");
					at.g_free(s);
				}
			}
			at.unref(t);
		}
	}
	/* Text equal to the name says nothing more. */
	if (!strcmp(text, name)) text[0] = 0;
	Region region = {0};
	Obj *table = children > LARGE_TABLE ? at.table_iface(node) : NULL;
	if (table && table_region(node, table, &region)) {
		snprintf(text, sizeof text,
			"%d rows and %d columns; cells of rows %d to %d and columns %d to %d listed%s, those without text left out",
			region.rows, region.columns, region.first_row + 1, region.last_row + 1, region.first_column + 1,
			region.last_column + 1, region.measured ? " (on the screen)" : "");
	} else if (table) {
		at.unref(table);
		table = NULL;
	}
	int named = name[0] || text[0];
	int wanted = editable || (named ? !container(role) || actions > 0 : actions > 0 && control(role));
	if (quiet(role) && !editable && !text[0] && !strcmp(name, above)) wanted = 0;
	if (walk.sparse && !strcmp(role, "table cell") && !text[0] && !at.state_contains(set, STATE_FOCUSED) &&
		!at.state_contains(set, STATE_SELECTED))
		wanted = 0;
	int kept = 0;
	if (wanted) {
		char flags[160];
		states(set, flags, sizeof flags);
		int ref = keep(node);
		if (ref) {
			fprintf(walk.out, "E\t%ld\t%d\t%s\t%s\t%s\t%s\n", ref_base + ref, depth, role, name, flags, text);
			kept = 1;
		}
	}
	at.unref(set);
	free(role);
	if (table) {
		int sparse = walk.sparse;
		walk.sparse = 1;
		for (int r = region.first_row; r <= region.last_row && !walk.truncated; r++) {
			for (int c = region.first_column; c <= region.last_column && !walk.truncated; c++) {
				Obj *cell = at.table_cell_at(table, r, c, &error);
				forget(&error);
				if (cell) visit(cell, kept ? depth + 1 : depth, kept ? name : above);
			}
		}
		walk.sparse = sparse;
		at.unref(table);
		children = 0;
	}
	for (int i = 0; i < children && !walk.truncated; i++) {
		Obj *child = at.child_at(node, i, &error);
		forget(&error);
		if (child) visit(child, kept ? depth + 1 : depth, kept ? name : above);
	}
	free(name);
	if (!kept) at.unref(node);
}

static void visit(Obj *node, int depth, const char *above) {
	if (walk.nesting >= MAX_NESTING) {
		walk.deep = 1;
		at.unref(node);
		return;
	}
	walk.nesting++;
	visit_node(node, depth, above);
	walk.nesting--;
}

static void clear_refs(void) {
	for (int i = 1; i <= ref_count; i++) at.unref(refs[i]);
	ref_base += ref_count;
	ref_count = 0;
}

static int command_elements(char *path) {
	FILE *out = fopen(path, "wx");
	if (!out) return reply("error cannot write %s", path);
	clear_refs();
	toplevels_list(out);
	walk = (struct walk){out, 0, now_ms() + WALK_MS, 0, 0, 0, 0, 0};
	GError *error = NULL;
	Obj *desktop = at.get_desktop(0);
	int apps = desktop ? at.child_count(desktop, &error) : -1;
	forget(&error);
	for (int a = 0; a < apps && !walk.truncated; a++) {
		Obj *app = at.child_at(desktop, a, &error);
		forget(&error);
		if (!app) continue;
		char *app_name = own(at.name(app, &error));
		forget(&error);
		int windows = at.child_count(app, &error);
		forget(&error);
		for (int w = 0; w < windows && !walk.truncated; w++) {
			Obj *window = at.child_at(app, w, &error);
			forget(&error);
			if (!window) continue;
			Obj *set = at.state_set(window);
			/* A window off the screen (minimised, closed but kept) is left out. */
			if (!set || !at.state_contains(set, STATE_SHOWING)) {
				if (set) at.unref(set);
				at.unref(window);
				continue;
			}
			char flags[160];
			states(set, flags, sizeof flags);
			at.unref(set);
			char *role = own(at.role_name(window, &error));
			forget(&error);
			char *title = own(at.name(window, &error));
			forget(&error);
			walk.window = 0;
			int ref = keep(window);
			walk.window = ref;
			if (ref) fprintf(out, "W\t%ld\t%s\t%s\t%s\t%s\n", ref_base + ref, app_name, role, title, flags);
			free(role);
			int children = at.child_count(window, &error);
			forget(&error);
			for (int i = 0; i < children && !walk.truncated; i++) {
				Obj *child = at.child_at(window, i, &error);
				forget(&error);
				if (child) visit(child, 0, title);
			}
			free(title);
			if (!ref) at.unref(window);
		}
		free(app_name);
		at.unref(app);
	}
	if (desktop) at.unref(desktop);
	fclose(out);
	return reply("ok %d%s", ref_count, walk.truncated || walk.deep ? " truncated" : "");
}

/* The index of an element named by its reference, or 0 when unknown or gone. */
static int element(char **rest) {
	char *end;
	long ref = strtol(*rest, &end, 10) - ref_base;
	if (end == *rest || ref < 1 || ref > ref_count) return 0;
	*rest = *end == ' ' ? end + 1 : end;
	Obj *set = at.state_set(refs[ref]);
	int gone = !set || at.state_contains(set, STATE_DEFUNCT);
	if (set) at.unref(set);
	return gone ? 0 : (int)ref;
}

static int has_state(Obj *node, int state) {
	Obj *set = at.state_set(node);
	int has = set && at.state_contains(set, state);
	if (set) at.unref(set);
	return has;
}

static int command_do(Obj *node) {
	static const char *preferred[] = {"click", "press", "activate", "Press", "doDefault", "toggle", "switch",
		"jump", "open", "ShowMenu", "select", "expand or contract"};
	GError *error = NULL;
	Obj *action = at.action_iface(node);
	int count = action ? at.n_actions(action, &error) : 0;
	forget(&error);
	if (count <= 0) {
		if (action) at.unref(action);
		return reply("error this element has no action");
	}
	int chosen = 0;
	char *chosen_name = NULL;
	for (size_t p = 0; p < sizeof preferred / sizeof preferred[0] && !chosen_name; p++) {
		for (int i = 0; i < count && !chosen_name; i++) {
			char *n = at.action_name(action, i, &error);
			forget(&error);
			if (n && !strcmp(n, preferred[p])) {
				chosen = i;
				chosen_name = own(n);
			} else if (n) {
				at.g_free(n);
			}
		}
	}
	if (!chosen_name) {
		chosen_name = own(at.action_name(action, 0, &error));
		forget(&error);
	}
	int done = at.do_action(action, chosen, &error);
	at.unref(action);
	if (!done || error) {
		reply("error the program refused %s%s%s", chosen_name, error ? ": " : "", error ? error->message : "");
		forget(&error);
	} else {
		reply("ok %s", chosen_name);
	}
	free(chosen_name);
	return 1;
}

static int command_focus(int ref) {
	Obj *node = refs[ref];
	GError *error = NULL;
	/* Under Wayland a program cannot bring its window to the front: keys would reach the window in front. The
	 * compositor says which one it is; the tree can call a window active while a dialog missing from it has the keys
	 * (LibreOffice's welcome). */
	const char *front = front_title();
	if (front) {
		char *title = own(at.name(refs[window_of[ref]], &error));
		forget(&error);
		int same = !strcmp(title, front);
		free(title);
		if (!same && *front)
			return reply("error the window in front is \"%s\": deal with it first, or click inside this element's window",
				front);
		if (!same) return reply("error its window is not in front: click inside that window first");
	} else if (!has_state(refs[window_of[ref]], STATE_ACTIVE)) {
		return reply("error its window is not in front: click inside that window first");
	}
	if (has_state(node, STATE_FOCUSED)) return reply("ok");
	Obj *component = at.component_iface(node);
	if (!component) return reply("error this element cannot take the focus");
	int done = at.grab_focus(component, &error);
	at.unref(component);
	if (!done || error) {
		/* GTK 4 refuses every focus request from accessibility (measured with GNOME Calculator, GTK 4.22). */
		reply("error the program does not let Prism move its focus: click the field, then type without ref");
		forget(&error);
		return 1;
	}
	/* Programs move the focus on their next turn. */
	for (long deadline = now_ms() + 500; !has_state(node, STATE_FOCUSED); usleep(20000))
		if (now_ms() > deadline) return reply("error the element did not take the focus");
	return reply("ok");
}

/* Commands are one line: in the text, backslash-n is a line break and two backslashes are one. */
static void unescape(char *text) {
	char *out = text;
	for (char *in = text; *in; in++) {
		if (*in == '\\' && (in[1] == 'n' || in[1] == '\\')) *out++ = *++in == 'n' ? '\n' : '\\';
		else *out++ = *in;
	}
	*out = 0;
}

static int command_settext(Obj *node, char *text) {
	GError *error = NULL;
	unescape(text);
	Obj *editable = at.editable_iface(node);
	if (!editable) return reply("error this element is not an editable text");
	int done = at.set_text(editable, text, &error);
	at.unref(editable);
	if (!done || error) {
		reply("error the program refused the text%s%s", error ? ": " : "", error ? error->message : "");
		forget(&error);
		return 1;
	}
	return reply("ok");
}

/* Runs an accessibility command; 0 when name is not one. */
int a11y_run(const char *name, char *rest) {
	int known = !strcmp(name, "a11y-wait") || !strcmp(name, "elements") || !strcmp(name, "do") ||
		!strcmp(name, "focus") || !strcmp(name, "settext");
	if (!known) return 0;
	if (load() < 0) return reply("error %s", why);
	while (rest && *rest == ' ') rest++;
	if (!rest) rest = "";
	if (!strcmp(name, "a11y-wait")) {
		long deadline = now_ms() + atol(rest);
		for (;;) {
			GError *error = NULL;
			Obj *desktop = at.get_desktop(0);
			int apps = desktop ? at.child_count(desktop, &error) : -1;
			int ready = desktop && !error && apps >= 0;
			forget(&error);
			if (desktop) at.unref(desktop);
			if (ready) return reply("ok");
			if (now_ms() > deadline) return reply("error the accessibility registry did not answer");
			usleep(10000);
		}
	}
	if (!strcmp(name, "elements")) {
		if (!*rest) return reply("error elements needs a path");
		return command_elements(rest);
	}
	int ref = element(&rest);
	if (!ref) return reply("error unknown or stale element: list the elements again");
	if (!strcmp(name, "do")) return command_do(refs[ref]);
	if (!strcmp(name, "focus")) return command_focus(ref);
	return command_settext(refs[ref], rest);
}
