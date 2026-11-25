# rpiv-ask-user-question, Prism fork

Fork (roadmap V2.1) of the published npm package `@juicesharp/rpiv-ask-user-question` 2.12.0
(`sha512-DilWc7u25SwnK6ytuAWOTerP0AmOEfK4HXpgS1oEzkgv9d5g5T+PbLG+zcLn18M3B/J3poMG14iydG5O6iBsnw==`,
https://github.com/juicesharp/rpiv-mono, `packages/rpiv-ask-user-question/`, MIT). The files
are the published package with small patches, each marked `// prism-fork:`.

Its dependencies resolve from `../../node_modules/` (see `../../README.md`).

## Changes from 2.12.0

| Change | Files | Why |
|---|---|---|
| The hint and heading constants move, unchanged, from `view/dialog-builder.ts` to a new leaf module; `dialog-builder.ts` re-exports them; `tab-content-strategy.ts` imports them from the leaf, and only the `DialogState` type from `dialog-builder.ts` | `view/dialog-constants.ts` (new), `view/dialog-builder.ts`, `view/tab-content-strategy.ts` | `dialog-builder.ts` imports `tab-content-strategy.ts`, which imported values back from it. Native ESM handles that cycle. Prebundled with esbuild (`fork/scripts/prebundle-vendored.mjs`), modules behind the dynamic import of `state/questionnaire-session.js` become lazy `init_*()` functions, async because `state/i18n-bridge.ts` has a top-level await, and the two inits awaited each other forever: the first `ask_user_question` call hung before showing its dialog, with no error, and froze the other tool calls of its batch (reported on 2026-10-13). |
| `package.json`: `@juicesharp/rpiv-config` pinned to the vendored 2.12.0 (was `^2.12.0`) | `package.json` | The repository requires exact versions (`npm run check`) |
| The tool passes its `AbortSignal` to `ctx.ui.custom` (option added by Prism, V2.2); a questionnaire closed by the abort returns a cancelled result saying the user interrupted the turn, instead of falling back to the RPC dialogs | `ask-user-question.ts` | Aborting the turn (Esc) left the questionnaire open and the call pending |
| Loading the questionnaire module is limited to 10 s; past that, the existing `session_load_failed` envelope tells the model to ask in plain text | `ask-user-question.ts` (`loadQuestionnaireSession`) | A load that never settles (the V2.1 cycle, or any other) hung the call with no error |
| Without `@juicesharp/rpiv-i18n`, the i18n bridge words each English fallback through `globalThis[Symbol.for("prism.translateUi")]` at call time; the RPC preview heading goes through the bridge (`rpc.preview_heading`) with the option label inserted as it is | `state/i18n-bridge.ts`, `rpc-fallback.ts` (`buildPreviewBlock`) | fork.10 (R4.14): the dialog (hints, review, "Type something.", RPC prompts) stayed in English in a French profile, since Prism does not ship the optional SDK. Unset, the published English |
| The RPC dialogs (`runRpcQuestionnaire`, `DialogUI`) take the turn's `AbortSignal` and pass it to `ui.select` and `ui.input` | `rpc-fallback.ts`, `ask-user-question.ts` | Stop left the question open in the Prism window, a panel nobody waited for (fork.10.5, 2026-11-07) |
| The RPC dialogs offer "← Previous question" on a single-select question after the first, and, with several questions, a review of the answers before they are sent, each open to change (as the TUI's Submit tab); a question reopened from the review and dismissed keeps its answer | `rpc-fallback.ts` (`runRpcQuestionnaire`, `askSingleSelect`) | Owner's QA of fork.12.5 (2026-11-24): in the Prism window and on the phone, once an option was chosen there was no way back |
| The model's question, header, labels, descriptions and previews lose their terminal controls (OSC, CSI other than colours, DCS, C1) when the parameters are normalized; the answers are the text the user saw | `tool/normalize-params.ts` (`normalizeStringFields`) | Codex review of 2026-11-09 (CR-163): an OSC 52 sequence in the first option reached the terminal as soon as the questionnaire opened |

## Updating

Diff the new published package against the 2.12.0 tarball, apply the upstream changes to
this copy, and re-apply every `// prism-fork:` patch, or drop the fork if upstream broke the
cycle. `fork/scripts/prebundle-vendored.mjs` fails the build when a bundle contains a cycle of
async inits, and `test/fork-vendored.test.ts` calls the tool from the prebundle with a time
limit.
