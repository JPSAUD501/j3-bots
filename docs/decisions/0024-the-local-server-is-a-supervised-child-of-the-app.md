# 0024: The local-mode server is a supervised child of the app

**Status:** Accepted

## Context

Someone with no always-on machine wants the bots on the computer they use, set up by the desktop app alone. The server needs Node 26 and its own native modules, and owns a data home with keys in it. Electron 44 ships Node 24 (**Verified** on Linux: 24.22.1). The app must start the server without the operator installing anything, keep it running while the app is open, stop it cleanly, and never leave one running that nobody can see. The page then has to be signed in to that server without a pairing code, and that credential must never be reachable from the network.

## Decision

**The app starts the release's own server as a child process.** The package carries the release archive without its web client (`resources/server-runtime`: its Node and server bundle). The app copies it to `<userData>/server-runtime/<version>/`, where the version transition keeps the release the data moved from ([decision 0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md)), and spawns `node server/bin.mjs serve` from there, with `J3_HOME=<userData>/server/home`, `J3_HOST` the loopback address or, with phone access on, the address phone access needs ([decision 0036](0036-phone-access-restarts-the-local-server-on-the-network.md)), and `J3_WEB_CLIENT` the app's web build copied to `<userData>/server/web`, which phones load. It does not run from the package: an AppImage's mount goes when the app exits, Windows will not let an update replace a running `node.exe`, and a rollback needs the earlier version after the package was replaced. On Windows it runs from a stable `current/` copy, so the firewall asks once.

**The app is the only supervisor.** Nothing is installed in the system: no service, unit or scheduled task. The app restarts a server that stops on its own (1 s, doubled up to 30 s, reset after a minute of running) and never restarts one that refused to start (exit status 78). On Quit it holds the quit, asks the server to stop, and kills it after 30 seconds. A server is never left running without the app: it is started with `--exit-with-stdin` and stops when its stdin ends, which happens when the app dies, however it dies. A server an earlier run left behind is taken over when it is the release the app would start as it is, and stopped otherwise.

**The admin channel is an inherited pipe** ([decision 0020](0020-the-local-desktop-gets-its-device-through-the-admin-channel.md)). The child gets a pipe on fd 3 (`--admin-fd 3`), which only the app holds. The app reads `/status` on it, trusts a server only when the status names the child's own pid, and asks it there for the page's device (`/local-device`) and for the stop (`/shutdown`). The device's token goes to the page through a bridge call only the top frame may make, and is sealed there as after pairing. Minting needs no code because the pipe is not reachable from the network or by another user.

## Consequences

- The bots stop when the app quits. Closing the window hides the app to the tray instead, so they keep running while the operator is logged in. Starting with the system is the app's own login item, not a service.
- The app's process tree carries the server and the engine, and the operator sees one app. Its logs go to `<userData>/server/server.log`, not to the journal.
- Two Nodes ship in the package: Electron's and the server's. The package grows by the size of the runtime.
- A server the app takes over on Unix is trusted through `<home>/admin.sock`, so the app checks that only this user can open the home before it trusts it. On Windows no `admin.sock` is bound, so a server left behind is ended by the pid the app recorded, after it checks that the process with that pid still has the recorded start time.
- A port chosen at the first start stays in the home's `config.json`, so the origin the page signed in to stays the same. A port taken later by another program makes the start fail until it is freed.

## Rejected

- **Install the service, as the command line does.** It would outlive the app, need a per-OS service manager on each platform, and leave a running server behind when the app is removed. The operator who wants that already has `install.sh`.
- **Run the server in Electron's own Node** (`utilityProcess` or `ELECTRON_RUN_AS_NODE`). Electron's Node is not the version the server is built and tested on, its native modules would need a second build for Electron's ABI, and an Electron update would change the server's runtime under it.
- **A detached server that the app finds again on the next launch.** It would keep running with no window, no tray and no one watching it. The stdin lifeline exists to rule that out.
- **Sign the page in with a pairing code the app reads and types for it.** The code would travel over TCP, and the pairing route's lockout would count the app's own attempts. The pipe is shorter and private.
