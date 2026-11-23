# Environment Variables

Prism uses environment variables in three ways:

- Variables such as `PI_OFFLINE` configure the Prism process.
- Prism sets process markers so child processes can identify Prism as the launching agent.
- Commands run by the LLM-callable shell tools receive `PI_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md#use-an-api-key-from-the-environment).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=pi` is a generic marker that lets tooling identify Prism as the agent that launched the process. It keeps the value `pi`, the name of the agent Prism is built on, so tools that already recognize pi recognize Prism.
- `PI_CODING_AGENT=true` is Prism-specific and lets child processes detect that they run inside Prism.

Child processes inherit both markers. They are not session-specific and are not set automatically when Prism is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current Prism session state:

| Variable | Description |
|----------|-------------|
| `PI_SESSION_ID` | Current session ID |
| `PI_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `PI_PROVIDER` | Currently selected model provider |
| `PI_MODEL` | Currently selected model ID |
| `PI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting Prism. `PI_PROVIDER` and `PI_MODEL` identify the selected Prism model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"
printf 'reasoning=%s session=%s\n' "$PI_REASONING_LEVEL" "$PI_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$PI_SESSION_FILE" ]; then
  tail -n 1 "$PI_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with Prism. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, Prism removes inherited values for these variables so nested Prism processes do not expose stale parent-session metadata.

## Prism Process Configuration

These variables are read by Prism itself. Most keep the `PI_` prefix of pi, the agent Prism is built on, so scripts written for pi keep working. The two directory variables take the command's name: `PRISM_CODING_AGENT_DIR` for the `prism` command, `PI_CODING_AGENT_DIR` when Prism runs from its sources as `pi`.

| Variable | Description |
|----------|-------------|
| `PRISM_CODING_AGENT_DIR` | Override the config directory; default is `~/.prism/agent` |
| `PRISM_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `PI_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `PI_OFFLINE` | Disable automatic network activity, including model catalog refreshes and update checks |
| `PI_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `PI_SHARE_VIEWER_URL` | Override the base URL of the session viewer `/share` links to |
| `PI_RADIUS_GATEWAY` | Override the Radius gateway origin used by Radius relay connections (Radius is pi's own service; Prism's `/login` does not offer it) |
| `PRISM_SECRET_SERVICE` | Set to `off` to keep credentials out of the system keyring: they go to `auth.json`. See [Secrets](security.md#secrets) |
| `PRISM_BASE_URL` | Site the update check reads releases from; default `https://prism.odelserver.space`. The installer (`install.sh`) reads it too |
| `PRISM_REMOTE_DIR` | Folder of the phone link's keys and paired phones; default `~/.prism/remote`. See [Prism on Your Phone](phone.md) |
| `PRISM_GUI_BINARY` | Window program to start instead of the release's own, for development builds. See [Prism's Window](window.md) |
| `PI_EXPERIMENTAL` | Set to `1` to tell extensions that experimental features are on (`areExperimentalFeaturesEnabled()` in the SDK); the footer then shows `xp` |
| `PI_MANAGED_INSTALL_ROOT` | Used by pi's own managed installations; Prism's installer does not set it |
| `PI_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `PI_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `PI_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `PI_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `PI_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and provider-specific configuration are listed in [Providers](providers.md#use-an-api-key-from-the-environment).

Other `PI_*` and `PRISM_*` variables found in the code are used by Prism's own tests and measurements.
