# 0033: A client's update runs in a transient unit, and the home records how it ended

**Status:** Proposed

## Context

[Decision 0032](0032-updates-are-served-outside-the-protocol.md) lets a paired device ask the server to update itself. The update is the transition `j3-bots update` makes ([decision 0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md)): stop the service, take a snapshot, start the new release, wait for it, roll back if it does not get ready. Three things make that hard to start from the server:

- The server it stops is the one that was asked. Anything the server runs as its child is in the service's cgroup, and systemd ends it with the service.
- No process lives through the whole update. The server that started it is gone, and the one that runs afterwards, new or old, knows nothing of it.
- A client loses its connection exactly while the update matters.

## Decision

**The server starts the installed release's own `j3-bots update` as a transient unit of the service's user manager, and the update records its progress and its end in the home, where the next server reads it.**

- **One transition.** The unit runs `j3-bots update --version <V> --run <id>` of the release that runs now, the command an operator runs. Whether it may stop bots' work is the client's answer, kept in the record: the update asks it only once it is ready to stop the service, so work begun after the client asked is stopped only if the client said so. A client's update and a shell's are the same code, and take the same lock.
- **A transient unit.** `systemd-run --user --collect` runs it outside the service's cgroup, as the same user, with the service's environment and `NoNewPrivileges`. It needs a manager that outlives the operator's sessions, so a server without lingering, without `systemd-run`, or not run by the service says it cannot update itself and gives the command that does it by hand. The desktop app's server is updated with the app.
- **A record in the home.** `state/update.json` holds the run: who asked, from and to which release, its stage, and once it ends, how. The server writes it before the unit starts; after that only the run with that id writes it. Whichever release runs next reads it and reports it to every client, so an update's end is never lost with the process that saw it. A run whose unit ended without recording how is reported as `interrupted`, with its journal.
- **Polled, not streamed.** A client follows the run by asking for the status. A stream would end with the restart, and a client already polls the server while it is down.

## What it costs

- A server can update itself only on a systemd install with lingering. Other installs still update by hand, as before.
- A transient unit's command is expanded by systemd, so the server has to escape it; its environment is not, and is passed as it is.
- The record is one more file in the home with a format to keep. A release that cannot read it treats it as no run.

## What was rejected

- **Running the update in the server, or as its child.** The service's stop would kill it in the middle of the transition.
- **`systemd-run --scope`.** A scope belongs to the caller's session and cgroup tree, so it has the same problem.
- **A system unit or a helper with privilege.** The update needs none: everything it touches is the user's.
- **Keeping the result in the server's memory or database.** The server that would hold it is the one the update replaces, and the database may be rolled back with the snapshot.
- **Server-sent events for progress.** The stream ends at the restart, and a client must poll then anyway.
