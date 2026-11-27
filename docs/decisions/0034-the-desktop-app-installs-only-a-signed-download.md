# 0034: The desktop app installs only a download its release signed

**Status:** Accepted

## Context

The desktop app updates itself with electron-updater, which checks a download's SHA-512 against the feed file of the same release (`latest*.yml`). Whoever can publish a release in the repository can change both, so that check proves a download was not damaged, not that the project made it ([Security: desktop updates](../architecture/security.md#desktop-updates)). The builds carry no code signature for now, so on Linux nothing else stands between a release and every installed AppImage, and on Windows electron-updater skips its Authenticode check while no publisher is set.

Every release now publishes `SHA256SUMS` with the release key's signature over it, listing every file of the release, desktop packages included, and the server checks a release against it before it offers it ([decision 0032](0032-updates-are-served-outside-the-protocol.md)). In local mode the app carries the bots' server, so an app update is also the server's update ([decision 0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md)).

## Decision

**After electron-updater downloads a version, and before it is installed or offered, the app checks the file against that version's signed `SHA256SUMS`, with the server's own verifier, and installs or offers nothing it cannot verify.** When a verified version installs, at launch or as the app quits with no click, or when the operator asks, is [0041](0041-the-apps-update-themselves-when-they-start.md).

- **The same check as the server's.** `verifySums` from `@j3-bots/release`: the signature first, by any key in `RELEASE_KEYS`; then that the list is that version's own, so an older release's signed list cannot be replayed for a newer version; then the SHA-256 of the downloaded file against the one the list gives its name.
- **Only a file this platform installs.** The downloaded file must be an AppImage on Linux or an installer on Windows. A feed pointed at another file the release signs, such as `install.sh`, is refused.
- **Nothing short of it.** A release with no `SHA256SUMS` or no signature, one that cannot be fetched, or a file that cannot be read leaves the download neither installed nor offered, and the app says the download didn't match the release's signature. There is no fallback to the SHA-512 alone.
- **The app picks the release, by the server's policy.** The app follows `stable` or `nightly`, its own setting, and before each check picks the newest release that channel offers with the server's `newestOn`, then points electron-updater at that release's folder. It downloads only once the feed file there names that release's version and only files directly in that folder, so an edited feed file cannot send the download to another release, path or host. electron-updater's own GitHub feed takes only releases of the channel it is given, so it would never offer a newer stable release to a nightly build. Its channel setter also turns downgrades on, and the app never calls it: a move to stable keeps a nightly build until a stable release is newer.
- **Within a deadline.** The checksums and their signature must arrive within 30 seconds, and the list of releases too. One that does not refuses the download or fails the check, rather than leaving the app checking with every other update step held.
- **One button in local mode.** The app's update carries the server's, so Settings shows no second button for the server there.

## What it costs

- A release that lacks a signed `SHA256SUMS`, or lists a desktop package wrongly, updates no installed app. It is fixed by publishing a release that has one; until then the apps keep their version and say so.
- Each verified download costs two more requests to GitHub, for `SHA256SUMS` and its signature.
- The check runs on the file in the operator's update cache, which a process running as the operator could replace before the install. Such a process could already change the app itself.

## What was rejected

- **electron-updater's SHA-512 alone**, as before: it trusts whoever can publish a release.
- **Code signing as the only check.** It would tie a build to a publisher on Windows and macOS, but not on Linux, and the builds are not signed yet. It can come later beside this check.
- **Verifying only when the release has a signature, and warning otherwise.** An attacker who can publish a release can also leave the signature out, so a check that can be skipped proves nothing.
