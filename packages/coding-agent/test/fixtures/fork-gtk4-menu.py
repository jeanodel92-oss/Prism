# a GTK 4 window with a menu button for fork-desktop-a11y.test.ts. GTK 4 gives its menu items no
# name: their label is only reachable through the "labelled-by" relation (measured on GTK 4.22).
import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gio, Gtk  # noqa: E402


def activate(app):
    window = Gtk.ApplicationWindow(application=app, title="Menus")
    menu = Gio.Menu()
    menu.append("Open File", "app.open")
    section = Gio.Menu()
    section.append("Save As…", "app.saveas")
    section.append("Preferences", "app.prefs")
    menu.append_section(None, section)
    for name in ("open", "saveas", "prefs"):
        app.add_action(Gio.SimpleAction.new(name, None))
    window.set_child(Gtk.MenuButton(menu_model=menu, label="Main menu"))
    window.present()


app = Gtk.Application(application_id="space.odelserver.prism.test.menus")
app.connect("activate", activate)
app.run(None)
