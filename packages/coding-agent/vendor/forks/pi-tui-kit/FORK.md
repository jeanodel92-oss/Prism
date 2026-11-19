# Prism adapter for pi-tui-kit 0.59.0

The original package stays unchanged under `vendor/node_modules/@narumitw/pi-tui-kit`.
Prism's built-in extension loader aliases this package to `index.js`; external extensions keep their own resolution.

The adapter re-exports that package and wraps only `runMenu` for RPC clients that advertise `nativeMenus`.
It sends the actual screen definitions through `ctx.ui.custom`, validates input against those definitions,
then returns choices to the original dialog runtime. Setting values selected directly by the GUI replace
the runtime's cyclic value before the original action runs. No plugin action or navigation state is copied.
Other clients and the terminal use the original runtime unchanged.

Nested menus share cancellation for their command context: closing a child panel must not reopen its parent.
The original context is preserved in action and state callbacks. Menu and screen ids let the GUI retain focus and
search while the runtime refreshes the same screen, then reset them on a new opening; graphical views are marked so the interaction
surface replaces an answered screen without replaying the panel's appearance.
