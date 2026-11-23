# Diagnostics

## /doctor and prism doctor

`/doctor` checks the local setup and reports each check as correct, a problem, or not tested, with what it observed, the likely cause and what to do:

- global and project settings, `models.json`, and the global and project permission files: present and readable;
- the agent directory and the session directory;
- the keyring: whether credentials go to the system keyring or to `auth.json`;
- extensions that failed to load, recent crashes, stored model capabilities;
- the current model, its server and the last model request.

```text
/doctor                 the report
/doctor details         the report with the technical detail of each check
/doctor export <file>   save the report as JSON
```

When Prism no longer starts, run the same checks from a shell. `prism doctor` reads files only: it does not load extensions, run migrations or open the interface.

```bash
prism doctor
prism doctor details
prism doctor export report.json
```

`prism doctor` exits with code 1 when it finds a problem. An exported report masks recognized secrets and your home folder, and is written with mode `0600`; read it before sharing it.

## When Prism does not start or misbehaves

- `prism --safe` starts without discovered extensions, skills, prompt templates, themes or context files, when one of them prevents startup. The permission gate stays on.
- `prism --offline` turns off startup network access.
- `prism update --rollback` goes back to the previous release after an update that causes trouble; see [Updates](updates.md).
- The window does not open: its messages are in `~/.prism/agent/gui.log`; `prism --tui` opens the terminal. See [Prism's Window](window.md).
- A model is missing from `/model`: its provider has no usable credentials. Run `/login` again.
- A display problem in the terminal: `/debug` writes the screen and the session's messages to `~/.prism/agent/prism-debug.log`. Read that file before sharing it.

<a id="report-a-problem"></a>

## Report a problem

Open an issue in Prism's repository, with the bug report template. The [Source code](https://prism.odelserver.space/source/) page of Prism's site links to the repository. Give what you did, what happened and what you expected, the output of `prism --version`, and, when it helps, a report from `prism doctor export <file>` after reading it.

Security problems are not reported in issues: see [Report a security issue](security.md#report-a-security-issue).
