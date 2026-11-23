# Prism

Prism is a free and open source coding agent for Linux, for local or remote models. It runs in your terminal, in a window of its own, and from the Prism app on your Android phone. Give it a goal and a working folder: it can inspect files, run commands, edit content and carry out multi-step tasks, within the permissions and the sandbox you control.

Prism runs on Linux x64. There is no version for macOS, Windows or ARM computers; the phone app exists on Android only.

Ask Prism to create the prompt templates, skills, extensions and themes you need, or install a Prism package. Use Prism directly, automate it in print, JSON or RPC mode, or build applications with the TypeScript SDK.

Prism is built on [pi](https://github.com/earendil-works/pi) by Earendil Works. It is not affiliated with Earendil or pi's maintainers.

## Getting started

Install Prism on Linux x64:

```bash
curl -fsSL https://prism.odelserver.space/install.sh | sh
```

The [download page](https://prism.odelserver.space/downloads/) lists the other channels: `.deb` and `.rpm` repositories, the canary channel, the browser extension and the Android app.

Start Prism in the directory where you want it to work:

```bash
cd /path/to/project
prism
```

For a built-in AI provider, run `/login` inside Prism to connect a subscription or API key. Then give Prism a task.

See the [documentation](docs/index.md) for full setup and usage instructions; inside Prism, `/docs` opens it.

## Development

Prism's source code is linked from the [Source code](https://prism.odelserver.space/source/) page of its site. From a clone of the repository:

```bash
npm ci --ignore-scripts
./pi-test.sh
```

`pi-test.sh` runs Prism from the sources. It can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read `CONTRIBUTING.md` at the root of the repository before opening an issue or pull request, and `SECURITY.md` to report a vulnerability.

## License

Prism's code is under the GNU General Public License, version 3 or later. The code that comes from pi keeps its MIT license. `REUSE.toml` at the root of the repository says which applies to each file.
