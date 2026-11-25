# Let the Agent Use Your Browser

With the `browser` module, the agent opens and uses web pages in your own browser, through the Prism browser extension: it reads pages, clicks, types, scrolls and takes screenshots. It works only in tabs it opened itself; your other tabs stay out of its reach. You are signed in to your own sites in that browser, so ask it only for what you would do yourself.

## Turn it on

1. Turn on the module: **/settings › Modules › Your browser (Prism extension)**, or `"+builtin:browser"` in the `extensions` setting. It is off by default.
2. Run `/browser setup`. The guided setup:
   - asks which installed browser to use: Firefox and the browsers built on it (Zen, LibreWolf, Waterfox), or Chrome and the browsers built on Chromium (Chromium, Brave, Vivaldi, Edge, Opera);
   - declares Prism's native host to that browser, so the extension can reach Prism (and, for a Flatpak browser, asks before allowing it to start Prism outside its sandbox);
   - opens the extension's store page: [addons.mozilla.org](https://addons.mozilla.org) for the Firefox family, the Chrome Web Store for the Chromium family, or explains how to load it from a folder for a browser without the store;
   - waits for the extension to connect, then opens, reads and closes a tab of its own to check the link.

The agent's first use of the browser asks you, even in `broad` mode.

When the agent needs the browser and none is linked (it is closed, for example), Prism starts the browser you set up, on your usual profile, and waits up to 20 seconds for the extension to connect before going on. Without a browser set up, it asks you to run `/browser setup`.

## Commands

| Command | What it does |
|---|---|
| `/browser` | The linked browsers and their state |
| `/browser setup` | The guided setup; also to link another browser |
| `/browser resume` | Give control back after you stopped it from the browser |
| `/browser firefox` | Restart Firefox with remote control, for real clicks and keys instead of clicks by script |

## Control and limits

- **Stop it from the browser.** In the Chromium family, closing the "started debugging this browser" bar stops the agent's control at once, including an action under way; `/browser resume` gives it back.
- **Network.** Each page the agent opens goes through Prism's network questions: a site never allowed asks you, and a redirect to another site is checked again.
- **Pages it made.** To check a page it wrote, the agent opens a project file by its path or a `file://` URL, or a server it started (`npm run dev` as a background task) at `http://localhost:<port>`. Prism serves the file on `127.0.0.1` behind a secret only the agent's tab gets, and relays the server from the session's own network to the same port on your machine while the session lasts. Without the sandbox, a server a running background task listens on is opened as it is. Files outside the project folder and protected files (`.env`, keys) are refused. What such a page loads or sends once open is not filtered, as for any page.
- **Page content is data.** Text in a page can try to steer the model. Prism's [injection warning](permissions.md#prompt-injection-warning) checks what the tool returns; it reduces the risk without removing it.
- **Outside the sandbox.** The browser runs as you, with your sessions and cookies. The [sandbox](sandbox.md) does not cover it.
- **Version.** Prism tells you when the installed extension is not the version it expects.
