# pi-context-inspector, Prism fork

Fork (QA of fork.10) of the published npm package `pi-context-inspector` 1.3.0
(`sha512-TBvV074bPlWoHRaY871anQTR2izUmAqCzTf2YTAj8gc556aql9PZ8/ZLj5bsHxM8L9OAk1jJfI8i1LXKD+upag==`,
https://github.com/yuriteixeira/pi-context-inspector, MIT). The files are the published package
with small patches, each marked `// prism-fork:`. It was vendored unchanged under
`../../node_modules/pi-context-inspector/` before this fork.

Its dependencies resolve from `../../node_modules/` (see `../../README.md`).

## Changes from 1.3.0

| Change | Files | Why |
|---|---|---|
| The Stats tab stacks the category breakdown above the grid when both do not fit side by side in the overlay (the tab does not scroll: a short terminal cuts the grid, not the figures) | `src/stats-tab-content.ts` (`renderContent`) | At 60 columns the rows with the grid and the breakdown were wider than the overlay: their end and the right border were cut (owner's report, 2026-11-06) |
| Every content line is cut to the overlay's inner width before its border is drawn | `src/utils.ts` (`createBorderHelpers`, `row`) | Whatever a tab draws, the right border stays in place |
| `package.json`: development dependencies pinned to the versions they named (`@types/node` 26.6.2, `typescript` 7.0.2, `vitest` 5.0.1; were `^`) | `package.json` | The repository requires exact versions (`npm run check`); they are not installed or shipped |
| Prism's context gauge opens /context, so the Stats tab shows how auto-compaction runs in the session (Prism's line replaces "Auto-compact starts after…", which ignored whether it is on and Prism's threshold), and `c` compacts now, `s` opens auto-compaction's settings; read from `Symbol.for("prism.context")`, published by Prism (`src/fork/context-bridge.ts`), absent elsewhere | `src/stats-tab-content.ts` (`StatsCompaction`, `handleInput`, `renderContent`), `src/index.ts` (the command's handler) | Owner's QA of fork.10, 2026-11-07: the gauge and /context are one screen with compaction's actions, in the terminal as in the window |
| The footer's figures on the left are left out when they and the keys do not fit on the row | `src/tabbed-overlay.ts` (`render`) | At 60 columns the keys (`q close`, Prism's `c` and `s`) were cut; the Stats tab shows the same figures |
| The published unit tests removed | `src/editor-colors.test.ts`, `src/external-editor.test.ts`, `src/scrollable-tab-content.test.ts`, `src/tabbed-overlay.test.ts` | They import `vitest`, which the plug-in does not declare at run time (`npm run check`), and nothing ran them here. Prism's tests: `test/fork-vendored.test.ts`, `test/fork-context-inspector-narrow.test.ts` |
| The numbered text of the Messages, Full and Tools tabs is drawn without the terminal controls it holds (OSC, CSI other than colours, DCS, C1); the editor and the copy keep the exact text | `src/index.ts` (`buildNumberedLines`) | Codex review of 2026-11-09 (CR-163): an assistant reply or an MCP tool description starting with an OSC 52 sequence reached the terminal through /context |
| The Stats tab counts the context the model receives (`buildSessionContext`), not the raw branch, and its buffer is the room above Prism's auto-compaction threshold (`threshold` on `Symbol.for("prism.context")`; none when auto-compaction is off; the default reserve without Prism) | `src/index.ts` (`buildTokenBreakdown`, the command's handler, `PrismContext`) | Codex review of 2026-11-09 (CR-083, CR-084): a compacted or removed tool result still filled the Tools part, and the buffer ignored the configured threshold |

## Updating

Diff the new published package against the 1.3.0 tarball, apply the upstream changes to this
copy, and re-apply every `// prism-fork:` patch.
