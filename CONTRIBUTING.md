# Contributing to Prism

## Issues

Use one of the issue templates: a bug report or a feature request. Keep it short and concrete: what you did, what
happened, what you expected, and the output of `prism --version`.

Security problems are not reported in issues: see [SECURITY.md](SECURITY.md).

## Pull requests

Open an issue before a pull request that changes behaviour, so the change can be agreed on first. Small fixes
(typos, an obvious bug with its test) can come directly.

- You must understand your change. Code written with an AI assistant is fine; code you cannot explain is not.
- Prism stays model-agnostic: nothing that ships may hardcode a provider, a model, an endpoint or a budget.
- Prefer new files over edits to the code that comes from pi, and keep those edits small: it makes pi's updates
  easier to take.
- Add or adapt a test for each change in behaviour.
- Before you push:

  ```bash
  npm run check   # lint, format and type checks, with no errors or warnings
  ./test.sh       # tests, isolated from your own configuration
  ```

- Commit messages: `{feat,fix,docs,chore}[(scope)]: message`, in English.

## Licence

By contributing, you agree that your contribution is licensed under the GNU General Public License, version 3 or
later, for Prism's code, or under the MIT licence for changes to files that keep pi's licence. `REUSE.toml` says which
applies to each file.
