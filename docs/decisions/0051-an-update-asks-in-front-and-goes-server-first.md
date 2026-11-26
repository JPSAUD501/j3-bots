# 0051: An update asks in front of the app, and goes server first, then the client

**Status:** Accepted

Supersedes the parts of [0041](0041-the-apps-update-themselves-when-they-start.md) about a version found while the app runs, and the shape rule of [0032](0032-updates-are-served-outside-the-protocol.md) for added fields.

## Context

Before this decision a newer release never interrupted the operator. A dot on the Settings button was the whole notice for the server's update, and on the phone a line over the roster said so. Updating the server was one button in Settings → About and updates. The desktop and Android apps updated themselves as they opened, as 0041 set. An operator who never opened Settings kept an old server, and nothing said that the server and the app had to move together.

The owner asked for updates that are understandable and practical. When there is an update, a big dialog should appear in front of the app and ask to update. Following T3 Code, it should update the server and then the client, by default.

T3 Code (**Read** at `59651c1`) opens nothing on its own: a sidebar icon leads to "Update everything". That dialog updates the remote servers, waits for each to hand off, and installs the app last. A server that fails does not stop the app. Running threads are interrupted.

## Decision

**When a newer release is ready for the server this client talks to, or for the app itself, one dialog opens in front of the app on every client. Its "Update now" updates the server first, waits for it to answer on the new version, and only then updates this client. A failure stops the sequence where it happened.**

- **Who sees it.** Only a paired device, which holds the operator's credential. Nothing shows before pairing.
- **What it shows.** It gives the version, one sentence on what "Update now" will do, a few highlights from the release notes, a link to the notes, "Update now" and "Later". The highlights are the bold lead of each item under "What's new" ([the notes template](../releases/TEMPLATE.md)). The server reads them from the release as it checks its feed, and sends them in the update status as `highlights`.
- **What is offered.** The server's release counts only when this client can start its update: a verified, newer release, on a server that can update itself and runs no update now. The app's version counts once it is ready: downloaded and verified in the desktop app, found in the Android app with "Update automatically" off. A deb or Mac build offers "Download" in place of "Update now". In local mode the server is the app's own, so only the app's part is offered.
- **The order.** The server goes first, through its existing update with its snapshot, health check and rollback ([0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md)). The client waits until the update has ended and the server has answered on the version it asked for. Then the client updates:
  - the desktop app checks its feed, downloads, verifies against the signed checksums and restarts ([0034](0034-the-desktop-app-installs-only-a-signed-download.md));
  - the Android app checks, downloads, verifies and installs through its session ([0035](0035-the-android-app-installs-its-update-through-a-session.md));
  - a browser reloads, since the server serves its page.

  With the server current, the app's part runs alone. With nothing newer for the client, the dialog ends saying the server runs the new version.
- **A failure stops it.** A server update that is refused, cannot be reached, rolls back, fails, or goes silent for ten minutes leaves the client untouched. The dialog says why, with the command to run when there is one, and offers "Try again". An app that does not update after its server did offers "Try again" for its part alone.
- **Running work is never cut without the operator's word.** The server refuses with `work-running`, and the dialog offers "Stop and update" or "Later". In local mode the app's restart stops the bots it runs, so the dialog asks there too, counting bots with a turn under way.
- **"Later"** closes the dialog for 24 hours, for the versions on offer. A newer release on either side opens it again sooner. It is kept on the device, as a per-device convenience. A quiet entry point stays: a line in the roster's footer on the web and the desktop, and the line over the roster on the phone. Settings' "Update now" opens the same dialog. While a part runs, the operator can hide the dialog. It comes back when the sequence needs them, so a stalled download never holds the app.
- **"Update automatically" stays for the apps, as they open.** As 0041 set, a version found at launch installs before the operator starts working, and on the phone as the app opens. A version found while the app runs no longer only waits for the quit: the prompt offers it, and "Update now" restarts into it. With "Update automatically" on, it still installs as the app quits if the operator chooses "Later". The server never updates by itself: it always asks, through the prompt.
- **One model decides.** When the dialog opens and what each step does is the pure model in `packages/client-runtime/src/update/prompt.ts`. A runner in the same folder feeds it what the server and the app report, and does what it returns. The web, the desktop and the phone only draw it, and each supplies how its own app updates.
- **The update routes stay frozen.** A field may be added to what they answer only with a decoding default. A client built before the field ignores the key, since Effect Schema drops keys a struct does not name (**Read** in `effect` 4.1.3, `SchemaAST.ts:490`). A client built after reads an older server as sending the default. `highlights` is the first such field. The routes and `UPDATE_API_VERSION` are unchanged, and so is `PROTOCOL_VERSION`.

## Why server first

The update routes answer whatever protocol either side speaks ([0032](0032-updates-are-served-outside-the-protocol.md)). A client can always reach the server's update, and its own update needs no server, so neither order can lock a client out for good. Server first is still the safer default:

- A release that raises the protocol leaves a newer server and an older client for the few seconds it takes the client to follow. The client is already on its way, so the operator never sees the mismatch screen.
- A client updated first would sit on a server that may roll back. It would then be the newer side of a protocol mismatch, with no way back but the server's update, which just failed.
- The server's update can fail and roll back, and the client's rarely does. Doing the uncertain part first means a failure leaves both sides as they were.

The release notes template states the order. The mismatch screen stays for the cases the prompt does not cover: an update another device ran, or a client opened after the server moved.

## What it costs

- **A dialog interrupts.** It opens over whatever the operator is doing, once a day at most for the same release. "Later" is one press.
- **The client waits on the server's slowest step.** The sequence takes as long as the server's download, health check and restart, up to the ten minutes after which it says the update has not finished.
- **Highlights are in English**, as the release notes are written, in both languages' dialogs.
- **A desktop app's own version shows no highlights.** electron-updater's feed is not read for notes. The dialog links to the release page instead.
- **The count of bots at work in local mode is the app's own.** It counts the roster's bots with a turn under way, not the server's `runningWork`, so a background job with no turn shown can be stopped without being counted.

## What was rejected

- **T3 Code's icon with no dialog.** The owner asked for a prompt that cannot be missed.
- **Installing the app even when the server fails, as T3 Code does.** The app would be the newer side of a mismatch with a server that rolled back.
- **Waiting only for the server to hand off, as T3 Code does.** The client would restart before knowing the server came back on the new version, and could not stop on a rollback.
- **Updating the server by itself, like the apps.** A server update stops the bots' work for a minute or two. It rolls back on failure, but the moment is the operator's to choose.
- **A new route for the highlights.** It would add a request and a path for a list a few lines long that belongs to the release the status already names.
