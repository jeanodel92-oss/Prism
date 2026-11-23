# Scheduled Tasks

A scheduled task runs a prompt in a folder at set times, with no one at the keyboard: nightly tests, a weekly dependency check, a daily summary. `/schedule` creates, pauses, resumes and removes tasks. The window lists them under **Scheduled tasks** in its side menu.

## How a task runs

Each task is a systemd user timer that starts `prism --scheduled <name>`. There is no Prism daemon.

- **Only while you are logged in.** The timer belongs to your user session. Prism does not enable lingering (`loginctl enable-linger`), so a task does not run while you are logged out, and a run due while the computer is off or your session closed does not start on time.
- **A missed run.** When you create the task, you choose whether a run missed while the computer was off is only reported (recommended) or run late, at the next start.
- **No one to ask.** A run cannot ask questions. What the task's scope covers passes; everything else is refused, and the refusals are reported. A run never gets dangerous calls.
- **Credentials.** A run reads the provider's key like an interactive session. A locked keyring makes the run fail: no key is stored in clear for it.
- **Results.** The conversation of each run is kept in its session file. Errors go to the system journal (`journalctl --user -u <unit>`). When a run fails or had actions refused, a desktop notification says so, unless desktop notifications are off. At the next interactive start, Prism lists the runs since you last looked; `/schedule` shows each task's last runs.

## Create a task

`/schedule` › **New scheduled task** asks, in order:

1. what the task should do: the prompt each run gets;
2. its name: lower-case letters, digits and dashes, 40 at most;
3. when: every day, Monday to Friday or every Monday at a time you give, every hour, or any systemd calendar expression (`Mon..Fri 09:00`, `daily`, `*-*-* 06:30`);
4. whether it may change the project's files;
5. whether it may run commands in the [sandbox](sandbox.md), except dangerous ones;
6. the hosts it may connect to (none by default);
7. a time limit and a tool-call limit per run;
8. what to do with a missed run.

Prism then shows everything the task may do, the folder, the next run, the model, and the systemd unit files it will write (in `~/.config/systemd/user`). Nothing is written until you choose **Create the task**. The task's definition is kept in `~/.prism/agent/scheduled/`.

The model can propose a task (`propose_scheduled_task`), but only you create it, on the same confirmation screen.

## Requirements and limits

- systemd with user timers.
- An installed Prism (release or package). A Prism run from its TypeScript sources cannot schedule tasks: an agent could change those sources before the timer runs them.
- A task's scope is fixed when it is created. To change it, remove the task and create it again.
