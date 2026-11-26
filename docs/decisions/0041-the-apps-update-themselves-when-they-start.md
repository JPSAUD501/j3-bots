# 0041: The apps update themselves when they start

**Status:** Accepted; what happens to a version found while the app runs is [0051](0051-an-update-asks-in-front-and-goes-server-first.md)'s

Supersedes the part of [0034](0034-the-desktop-app-installs-only-a-signed-download.md) that left installing to the operator's "Restart to update".

## Context

Until 0.6.0 a desktop app that installs its own updates (an AppImage, a Windows install) checked at launch and every six hours, downloaded a newer version in the background, checked it against the release's signed `SHA256SUMS` ([0034](0034-the-desktop-app-installs-only-a-signed-download.md)), and then only offered "Restart to update". It never restarted by itself, nor installed as it quit. An operator who never pressed the button kept the old version for as long as they kept the app open, and opened it again on the old version the next day, with the new one downloaded and waiting.

The owner wants an update applied as soon as the app is opened, with no button to press to finish it. What stays is what made the button safe: nothing installs that did not match the signed checksums, nothing installs while the page reports a save under way, and the server the app runs on this computer is stopped before an install and started again if the install fails.

## Decision

**Where a build can install its own updates, an update the app finds as it starts is installed before the operator starts working, and one it finds while it runs is installed as it quits. The operator can turn this off ("Update automatically", on by default), which brings back the restart they ask for.**

- **At launch, before the page opens.** The launch's check waits up to five seconds for the release and its feed. If it finds a newer version in that time, the page shows only that the app is updating to it, with the download's progress, and the app downloads it, checks it against the signed checksums, and restarts into it with no click. If the check finds nothing, fails, or takes longer, the page opens as usual and says nothing more than it did before. A version found in time is not held to the five seconds, but its download is: one that goes 30 seconds without progress, or takes more than five minutes in all, opens the page as usual and goes on in the background, to install as the app quits. electron-updater sets no timeout that Electron's requests honour, so without this a connection that stays open and sends nothing would hold the updating screen on every launch. A download that fails, or one that does not match, opens the page as usual too.
- **The bots on this computer start after it.** In local mode the app starts its server once the launch's update is over, so an update at launch never starts the bots' work only to stop it, and an app that installs nothing first starts it as before, before the page loads.
- **While it runs, never mid-use.** What the six-hourly check, or a check the operator asks for, finds downloads and is checked in the background, then waits. The update prompt then offers it, and its "Update now" restarts into it ([0051](0051-an-update-asks-in-front-and-goes-server-first.md)). Settings says it is ready and installs when the app quits, and "Restart to update" stays there. An operator who chooses "Later" gets it as the app quits. As the app quits (Quit from the tray or the menu, or the window closing where that quits the app), after the quit has stopped the server, the app starts the install without starting the new version: the Windows installer runs once the app has exited, and an AppImage is replaced in place. An app that does not get to quit cleanly (killed, or ended by a shutdown) finds the same download in electron-updater's cache at its next launch, which installs it.
- **The app installs as it quits, not electron-updater.** electron-updater's own install on quit takes any download it completed, before the app has checked it, so it stays off; the app's `quit` handler installs only a version the model holds as matched.
- **A restart the page asks for, as after a keyring is unlocked, goes into the waiting version** rather than starting the old one beside its installer.
- **Builds that cannot install themselves are unchanged.** A deb and an unsigned Mac build keep saying a newer version is out, with a link to it; the app never asks for root. The setting is not shown there.
- **One model decides.** When the app installs is the pure state model `apps/desktop/src/updates.ts`, which the updater feeds and obeys.

## What it costs

- **A launch can take longer.** Every launch of a build that installs updates waits for its check, up to five seconds where the network is slow; on a working network it answers in well under a second. A launch that finds a version takes as long as the download, up to five minutes, during which the app cannot be used: there is no way past the updating screen but waiting.
- **An update can surprise.** The operator no longer chooses the moment; a version with a regression arrives without a click. The channel stays their choice, and a fix comes as a newer version as before.
- **A quit with a version waiting takes a moment more** on Windows, where the installer runs after the app exits, and the next start is the new version's first.

## What was rejected

- **Installing as soon as a download matches, while the app runs.** It would restart the app under the operator's hands, which the owner did not ask for and which the save rule would only delay.
- **electron-updater's `autoInstallOnAppQuit`.** It installs whatever it downloaded, before the signed checksums are checked.
- **Waiting at launch with no bound.** An unreachable feed would keep the app from opening at all.
- **Opening the page while the launch's update downloads, with a notice.** The operator would start working in a version about to go away, and in local mode the bots would start work the restart then stops.
