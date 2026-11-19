/*
 * Test of the accessibility walk of prism-desktop-helper on a deep tree, without
 * libatspi: the walk's source is included with libatspi's functions replaced by a fake tree. One application, one
 * window, then a chain of <levels> nested fillers ending in a button. The walk recursed once per level, a few KiB of
 * stack each: 4 000 levels stopped the helper.
 *
 * usage: a11y-deep <levels> <listing path>   prints the helper's reply to "elements" ("ok <count> [truncated]").
 * Built and run by packages/coding-agent/test/fork-audit-fork12-lot3-a11y-depth.test.ts.
 */
#include "../prism-a11y.c"

/* Node i: 0 the desktop, 1 the application, 2 the window, 3 to last - 1 fillers, last the button. */
static char *nodes;
static int last;

int toplevels_list(FILE *out) {
	return 0;
}

const char *front_title(void) {
	return "";
}

static int index_of(Obj *node) {
	return (int)((char *)node - nodes);
}

static Obj *fake_desktop(int i) {
	return nodes;
}

static int fake_child_count(Obj *node, GError **error) {
	return index_of(node) < last ? 1 : 0;
}

static Obj *fake_child_at(Obj *node, int i, GError **error) {
	return nodes + index_of(node) + 1;
}

static char *fake_name(Obj *node, GError **error) {
	int i = index_of(node);
	return strdup(i == last ? "DEEP-LEAF" : i == 2 ? "Deep" : i == 1 ? "app" : "");
}

static char *fake_role(Obj *node, GError **error) {
	int i = index_of(node);
	return strdup(i == last ? "push button" : i == 2 ? "frame" : "filler");
}

static Obj *fake_state_set(Obj *node) {
	return nodes;
}

static int fake_state_contains(Obj *set, int state) {
	return state == STATE_SHOWING || state == STATE_VISIBLE || state == STATE_SENSITIVE;
}

static Obj *fake_none(Obj *node) {
	return NULL;
}

static GArray *fake_relations(Obj *node, GError **error) {
	return NULL;
}

static void fake_unref(void *object) {}

int main(int argc, char **argv) {
	if (argc != 3) return 2;
	last = atoi(argv[1]) + 3;
	nodes = calloc((size_t)last + 1, 1);
	at.get_desktop = fake_desktop;
	at.child_count = fake_child_count;
	at.child_at = fake_child_at;
	at.name = fake_name;
	at.role_name = fake_role;
	at.state_set = fake_state_set;
	at.state_contains = fake_state_contains;
	at.action_iface = fake_none;
	at.text_iface = fake_none;
	at.component_iface = fake_none;
	at.table_iface = fake_none;
	at.relation_set = fake_relations;
	at.unref = fake_unref;
	at.g_free = free;
	loaded = 1;
	int ok = command_elements(argv[2]);
	free(nodes);
	return ok ? 0 : 1;
}
