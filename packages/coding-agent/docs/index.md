# Prism

Prism is a free and open source coding agent for Linux, for local or remote models. It works in your terminal, in a window of its own, and from the Prism app on your Android phone. Give it a goal and a working folder, and it can inspect files, run commands, edit content, and work through multi-step tasks, within permissions and a sandbox you control.

Prism runs on Linux x64. There is no build for macOS, Windows or ARM computers; the phone app exists for Android only.

Use Prism for software development, research notes, writing projects, data files, or hobby work. You can use Prism as is, prompt it to adapt itself to your workflow, or build other applications powered by Prism using the SDK.

## Start using Prism

New to Prism? Follow the [Quickstart](quickstart.md) to install Prism, connect a model, and complete your first task.

If Prism is already installed, choose what you want to do:

- [Use Prism interactively](usage.md) to add files, run commands, direct ongoing work, and export results.
- [Choose a model](models.md) or connect a subscription, API key, local model, or compatible endpoint.
- [Continue or branch a session](sessions.md) to resume work or explore another approach without losing history.
- [Configure Prism](configuration.md) for your preferences, working folders, instructions, and reusable resources.
- [Understand how Prism works](how-pi-works.md), including tools, context, sessions, and the agent loop.
- Open [Prism's window](window.md), link the [Android app](phone.md), or let the agent use [your browser](browser.md).
- [Schedule tasks](scheduled-tasks.md) that run on their own, and keep Prism [up to date](updates.md).
- Check your setup with [/doctor](doctor.md) when something goes wrong.

## Customize Prism

Prism can reuse prompts, load specialized instructions, add executable integrations, change its terminal interface, connect model services, and distribute these resources as packages.
Use the [Quickstart customization chooser](quickstart.md#choose-how-to-customize-prism) to select the smallest mechanism that meets your need.

## Automate or embed Prism

- Use [automation without the interface](automation.md) for print, JSON, RPC, SDK, and permission behavior.
- Use [print mode](cli.md#invocation-and-output) for one-off and scripted tasks.
- Use [JSON event stream mode](json.md) to consume structured events from one run.
- Use [RPC mode](rpc.md) to control a separate Prism process.
- Use the [TypeScript SDK](sdk.md) to run Prism inside an application.

## Find reference and setup information

Use the reference pages to look up [CLI options](cli.md), [settings](settings.md), [providers](providers.md), [keybindings](keybindings.md), and [environment variables](environment-variables.md).

For platform-specific help, see [Terminal Setup](terminal-setup.md), [tmux](tmux.md), or [Containerization](containerization.md). [Windows](windows.md) and [Termux on Android](termux.md) describe pi, the agent Prism is built on: Prism publishes no build for them.

## Work safely

Every tool call goes through the [permission gate](permissions.md), and in the `safe`, `ask` and `broad` modes the agent's shell commands run in a [sandbox](sandbox.md): they can change only the project, cannot read your credentials, and reach only the hosts you allow. Extensions, MCP servers and the file tools still run with your account's permissions, and project trust only controls which project resources load. Review [Security](security.md) before using untrusted files, repositories, extensions, or unattended automation.
