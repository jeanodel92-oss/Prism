# Vendored plugins

Fork (R1.8a). Third-party pi plugins shipped with the harness as built-in extensions
(`builtin:<name>`, see `src/extensions/index.ts`). Each package is the published npm
tarball, unpacked unchanged under `node_modules/<package>/`, so module resolution
works as for an installed package. Licenses and copyright notices are the ones in each
package directory. The build copies this directory next to the binary
(`scripts/build-binaries.sh`).

Do not edit files under `node_modules/`. A fix goes upstream, into a fork module that
wraps the plugin, or into a fork under `forks/` (see below).

## Provenance

Every plugin is now shipped as a fork (below); `node_modules/` holds their dependencies only.

### Forks

Plugins shipped as a modified copy, under `forks/<package>/`, each with a `FORK.md` that
lists every change from the published version. Their dependencies resolve from
`node_modules/` above.

| Package | Base version | Built-in name | Entry | License | Source repository | Base integrity (npm `dist.integrity`) |
|---|---|---|---|---|---|---|
| `@juicesharp/rpiv-ask-user-question` | 2.12.0 | `rpiv-ask-user-question` | `forks/rpiv-ask-user-question/index.ts` | MIT | https://github.com/juicesharp/rpiv-mono (`packages/rpiv-ask-user-question`) | `sha512-DilWc7u25SwnK6ytuAWOTerP0AmOEfK4HXpgS1oEzkgv9d5g5T+PbLG+zcLn18M3B/J3poMG14iydG5O6iBsnw==` |
| `@narumitw/pi-plan-mode` | 0.58.3 | `pi-plan-mode` | `forks/pi-plan-mode/dist/index.ts` | MIT | https://github.com/narumiruna/pi-extensions (`packages/pi-plan-mode`) | `sha512-mC2dOLXrsLedLH4VrX0t3wwdXrr9AccoI8SgvYYn0KewaR6hZ0a6fIyLnReVlnJ4zNcjhdwBKWujrM49EW4zsg==` |
| `@narumitw/pi-lsp` | 0.49.8 | `pi-lsp` | `forks/pi-lsp/dist/index.ts` | MIT | https://github.com/narumiruna/pi-extensions (`packages/pi-lsp`) | `sha512-Djrm0BBmbITmKUv2OtrPUACbP2j1GA7DQ4n/P/mZLf++s6Vv4fMMJUPvrQ01UtnaIQ7XzMCKzWrOyrJatyOGSw==` |
| `@narumitw/pi-goal` | 0.54.8 | `pi-goal` | `forks/pi-goal/dist/index.ts` | MIT | https://github.com/narumiruna/pi-extensions (`packages/pi-goal`) | `sha512-ba165WkOdBEQNYgjTa2MHgRtOh/hTLveObPzdoE29FOrfktymcBlayEHoXd9Jjw44VQ8bX7cq6V57zp0rJLVgQ==` |
| `pi-context-inspector` | 1.3.0 | `pi-context-inspector` | `forks/pi-context-inspector/index.ts` | MIT | https://github.com/yuriteixeira/pi-context-inspector | `sha512-TBvV074bPlWoHRaY871anQTR2izUmAqCzTf2YTAj8gc556aql9PZ8/ZLj5bsHxM8L9OAk1jJfI8i1LXKD+upag==` |

### Dependencies

Packages vendored only because a plugin above imports them. They have no built-in entry.

| Package | Version | Needed by | License | Source repository | Integrity (npm `dist.integrity`) |
|---|---|---|---|---|---|
| `@narumitw/pi-tui-kit` | 0.59.0 | `forks/pi-plan-mode`, `forks/pi-goal` | MIT | https://github.com/narumiruna/pi-extensions (`packages/pi-tui-kit`) | `sha512-KBbOcciJD+HVbeduUwBUiSy2AehMGYeOwiRPXvac5tcjuh3SDoQ+7qsNPt2s/ku6exJKZp0GYtAVsiu5ySddmA==` |
| `@juicesharp/rpiv-config` | 2.12.0 | `rpiv-ask-user-question` | MIT (see below) | https://github.com/juicesharp/rpiv-mono (`packages/rpiv-config`) | `sha512-eGjoCDCKz2JtKIUIpZ2y8CAVjxZYXCKa2D64ByozhkAWVblXsgyFLrQMk5k5Bv5RXRrA3GY66XNG5ExtEuGASA==` |

`@narumitw/pi-tui-kit` declares `highlight.js` and `grok-mermaid`, but only its
`components/syntax-highlighting.js` and `components/mermaid.js` load them, and neither its
entry point nor the plugins above import those modules, so they are not vendored.

Prism's built-in loader resolves `@narumitw/pi-tui-kit` through
`forks/pi-tui-kit/index.js` ([adapter notes](forks/pi-tui-kit/FORK.md)). This adapter
re-exports the unchanged package and presents its structured screens to graphical
clients that opt in. The original runtime still runs every menu action and navigation.
Terminal clients and external extensions keep their previous resolution and runtime.

The `@juicesharp/rpiv-config` tarball has no license file; its README points to the
repository's root `LICENSE`. That file is copied, unchanged, to
`licenses/@juicesharp/rpiv-config/LICENSE` (identical to the `LICENSE` shipped in
`forks/rpiv-ask-user-question`). `@juicesharp/rpiv-i18n`, an optional peer of
`rpiv-ask-user-question`, is not vendored: without it the plugin keeps its English UI.

## Updating a package (for example, a security fix)

1. `npm pack --ignore-scripts <package>@<version>` in an empty temporary directory, and
   compare the printed integrity with `npm view <package>@<version> dist.integrity`.
2. Unpack it next to the current copy and diff the two:
   `mkdir new && tar xzf <file>.tgz -C new --strip-components=1 && diff -r node_modules/<package> new`.
   Read the whole diff, and check that `dependencies` gained nothing that is not vendored here.
3. Replace `node_modules/<package>` with the new directory, and update its row above
   (version, integrity).
4. Rebuild the binary and run the plugin's smoke test.

## Prebundled plugins

The Node install (`fork/scripts/install-local.sh`) also writes one file per plugin listed in
`fork/scripts/prebundle-vendored.mjs` under `vendor/prebundled/<entry>`, and
`src/fork/vendored.ts` loads that file instead of the entry when it exists. The sources above
stay unchanged; only the installed copy gains the bundle. Reason: resolving the plugin's many
`./x.js` imports of TypeScript files costs about 0.1 s at startup (R1.4).
