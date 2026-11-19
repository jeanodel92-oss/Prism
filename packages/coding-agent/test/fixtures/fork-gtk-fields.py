# a GTK 3 window with fields for fork-desktop-a11y.test.ts. A file name field that already holds a name,
# a long text, and a notes area on several lines whose text is written to argv[1] at each change, so the test reads
# the line breaks the accessibility tree flattens.
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402

out = sys.argv[1]
window = Gtk.Window(title="Fields")
window.connect("destroy", Gtk.main_quit)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
name = Gtk.Entry()
name.set_text("pain lait oeufs.txt")
name.get_accessible().set_name("File name")
long = Gtk.Entry()
long.set_text("x" * 400)
long.get_accessible().set_name("Long")
notes = Gtk.TextView()
notes.get_accessible().set_name("Notes")


def save(buffer):
    with open(out, "w", encoding="utf-8") as file:
        file.write(buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), True))


notes.get_buffer().connect("changed", save)
for widget in (name, long, notes):
    box.pack_start(widget, False, False, 4)
window.add(box)
window.show_all()
Gtk.main()
