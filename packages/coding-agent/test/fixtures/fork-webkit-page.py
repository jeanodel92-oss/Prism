# a WebKitGTK page in a GTK 3 window, like the Prism window (Tauri): its page sits under wrappers
# that do not say they are shown. fork-desktop-a11y.test.ts lists its elements on the agent's desktop.
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2  # noqa: E402

window = Gtk.Window(title="Web page")
window.set_default_size(640, 400)
view = WebKit2.WebView()
view.load_html('<button>Ping</button> <input aria-label="Name">', "about:blank")
window.add(view)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
