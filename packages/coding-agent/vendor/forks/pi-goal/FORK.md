# pi-goal, Prism fork

Fork (QA of fork.8, UX-17) of the published npm package `@narumitw/pi-goal` 0.54.8
(`sha512-ba165WkOdBEQNYgjTa2MHgRtOh/hTLveObPzdoE29FOrfktymcBlayEHoXd9Jjw44VQ8bX7cq6V57zp0rJLVgQ==`,
https://github.com/narumiruna/pi-extensions, `packages/pi-goal/`, MIT). The files are the
published package with small patches in `dist/`, each marked `// prism-fork`; `src/` is the
published source, unchanged and not loaded.

Its dependencies resolve from `../../node_modules/` (see `../../README.md`).

## Changes from 0.54.8

| Change | Files | Why |
|---|---|---|
| Each menu definition goes through `globalThis[Symbol.for("prism.translateMenu")]` before `pi-tui-kit` draws it | `dist/chunks/menu-7W5HGHFO.ts`, `dist/chunks/settings-ui-T77VFPTK.ts` (`defineMenu`) | The Goal menu showed "No goal is currently set" and its choices in English in a French profile (owner's report, 2026-10-27). Prism translates the shown texts (`src/fork/menu-i18n.ts`); ids and values read back stay the plug-in's |
| `ui.confirm`, `ui.editor`, `ui.input` and `ui.notify` go through `globalThis[Symbol.for("prism.translateUi")]` (`prismUi`) | `dist/index.ts`, `dist/chunks/menu-7W5HGHFO.ts`, `dist/chunks/settings-ui-T77VFPTK.ts`, `dist/chunks/chunk-RNWM7MOG.ts` (`notifyTerminal`) | Same report: the Goal dialogs and notifications. A prefilled editor text is the user's and is not translated |
| `package.json`: `@narumitw/pi-tui-kit` pinned to the vendored 0.59.0 (was `^0.59.0`) | `package.json` | The repository requires exact versions (`npm run check`) |
| The Goal menu and its settings open when `globalThis[Symbol.for("prism.hasInteractiveClient")]` says a person can answer, not only in the terminal | `dist/chunks/menu-7W5HGHFO.ts` (`showGoalManager`), `dist/chunks/settings-ui-T77VFPTK.ts` (`showGoalSettings`) | fork.10: the Prism window (RPC with views) gets the same menu; pi-tui-kit already draws it there with dialogs. Unset, the test stays `ctx.mode === "tui"` |
| `formatStatus` words the status line through `globalThis[Symbol.for("prism.translateUi")]` (`prismStatus`): each status is one exact catalog key with named slots (`{turns}`, `{limit}`, `{budget}`, `{duration}`, `{reason}`, `{automatic}`) filled with the published values | `dist/chunks/chunk-7FMBWODN.ts` (`formatStatus`) | fork.10 (R4.14): the Goal status showed "active 2m · automatic 3/25" in a French profile, in the terminal footer and the window. Prism tells a finished goal from its translated word (`GOAL_DONE_STATUSES`, `src/fork/prism/modes.ts`) |
| `serializeGoalState` saves a copy of the goal (`structuredClone`) | `dist/chunks/chunk-7FMBWODN.ts` | Code review of 2026-11-09, CR-128: the saved entry was the live goal, so its usage counters changed in memory after it was written and an export no longer matched the session file |

Without Prism (the symbols unset), every patched call behaves as published; the copy above applies either way.

## Updating

Diff the new published package against the 0.54.8 tarball, apply the upstream changes to this
copy, and re-apply every `// prism-fork` patch.
