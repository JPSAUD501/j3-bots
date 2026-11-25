# 0035: The Android app installs its own update through an installer session, after checking it

**Status:** Proposed

## Context

The Android app is an APK on each release, signed with the project's key ([decision 0017](0017-the-android-app-is-a-signed-apk-on-the-release.md)), and until now the operator installed each new one by hand from the browser. A release now carries `SHA256SUMS`, signed with the release key, which lists the APK's SHA-256 ([decision 0032](0032-updates-are-served-outside-the-protocol.md)). So the app can find, download, check and install its own update, as the server and the desktop app do.

Android gives an app two ways to hand an APK to the system installer:

- an intent: `ACTION_VIEW` (or `ACTION_INSTALL_PACKAGE`, deprecated since Android 10) on a `content:` URI that a `FileProvider` serves from the app's files. The installer opens the file through that URI, asks the operator, and installs. The app hears nothing back: not whether it was installed, refused or cancelled.
- a `PackageInstaller` session: the app writes the APK's bytes into a session the system holds, then commits it. The system asks the operator to confirm, then reports the outcome to the app through a `PendingIntent`: installed, cancelled, refused because of a conflict (another signer, a lower version code), incompatible with the phone, out of room, or blocked by a policy.

Both need `REQUEST_INSTALL_PACKAGES` and the operator's "Install unknown apps" permission for J3 Bots, and in both Android itself refuses an APK signed with another key than the installed app's, or with a lower version code. The app is not on Google Play, so neither runs into Play's rules (**Read**: Android's `PackageInstaller` and `Intent.ACTION_INSTALL_PACKAGE` reference). That a session reports the outcome, and that Android refuses another signer at the install and takes an equal version code, is **Verified** on an Android 16 emulator ([Updating the Android app](../architecture/clients.md#updating-the-android-app)).

## Decision

**The app installs its update through a `PackageInstaller` session, and commits the session only when the bytes it wrote are the ones the release signed.**

- **Check before anything is installed.** The app reads its channel's releases, and offers one only when it is newer than the app and its `SHA256SUMS` verifies with the release key carried in the app (`@j3-bots/release`, with `@noble/curves` for Ed25519, since Android has no Ed25519 before 13 and Hermes has no `crypto`). It downloads the APK into its own cache, checks the file's SHA-256 against the verified list, and checks that the APK is this app (same package, the release's version name) and not older (version name and version code).
- **The bytes Android installs are the bytes that were checked.** The native module copies the file into the session and hashes it as it writes, and commits only when that digest is the listed one; otherwise it abandons the session. Nothing that changes the file between the check and the install can change what is installed.
- **It updates itself as it opens, unless the operator says otherwise.** "Update automatically", on by default, makes the check the app runs as it opens, or comes back after an hour or more, download, check and install a release it finds with no tap, and commit the session with `setRequireUserAction(USER_ACTION_NOT_REQUIRED)` on Android 12 and later, so that Android installs it without asking where it allows that (Consequences). Each check tries once: a failed or refused install says so and waits for the next opening or the operator. Turned off, the app offers the release and waits for the operator's tap, and Android asks them to confirm. This is the Android half of decision 0041, the apps update themselves when they start.
- **The outcome comes back.** The session's status tells the app whether the install went through, was cancelled or was refused, and why. The app says so in words, and deletes the downloaded file after an install or a refusal. A cancelled one keeps the checked file, so trying again does not download it again. The cache is emptied at the next start in any case.
- **Only the update folder.** The module installs, hashes or reads only files in the app's own update folder, and refuses any other path.
- **Play, later.** The app reads which package installed it (`getInstallSourceInfo`, or `getInstallerPackageName` before Android 11). An app installed by Google Play is updated by Play, so it opens its page there instead. This is a one-line branch until the app is on Play.

## Consequences

- One small native module of the app's own (`apps/mobile/modules/app-update`), in Kotlin, beside the JavaScript that checks the release.
- The app knows how an install ended, so its words and its cleanup are exact.
- A session for an update of the app itself ends the app's process when it succeeds, so "installed" is seldom heard: the app learns it at its next start, from its own version.
- Android installs an unattended update without asking only on its own conditions (**Read**: Android's `PackageInstaller.SessionParams.setRequireUserAction` reference): Android 12 or later; the installer holds "Install unknown apps" and declares `UPDATE_PACKAGES_WITHOUT_USER_ACTION`, an install-time permission the module's manifest asks for; the installer is the installed app's installer of record, its update owner, or the app updating itself; and the app targets a recent enough SDK (Android 10's on Android 12, rising by one each release to Android 15's on Android 17). J3 Bots updates itself and targets Android 16's SDK, React Native's default (**Read**: `react-native` 0.88.1, `gradle/libs.versions.toml`), so on Android 12 to 17 it should qualify whoever installed it first, the browser included, unless a store enforces its own update ownership. None of this ran on a phone yet: it is **Assumed** until it does. Where Android does not grant it, it asks as before, and the reference warns that the SDK bar keeps rising, so the app always handles the confirmation.
- A confirmation, when Android asks for one, may come while the operator is in another app, and Android does not let an app in the background open a dialog. The module keeps that confirmation and shows it when the app comes back.
- An update without a confirmation ends the app's process while the operator may be using it, shortly after it opens. The roster's update notice says it is updating and that the app closes to finish. Drafts and settings survive an update, so nothing typed is lost; the operator opens the app again.
- No `FileProvider` and no provider paths to keep narrow: no other app is given a URI into the app's files.
- The operator still allows "Install unknown apps" for J3 Bots once, in Android's settings. The app explains it before sending them there, and goes on with the install when they come back.

## Rejected

**An intent on a `FileProvider` URI.** It is the shorter path, but the app never learns whether the install went through, so it can neither say so nor know when to delete the file. And the installer reads the file after the app checked it: a file changed in between would be installed unchecked. Android's signer check would still refuse a file signed with another key, so this is about checking what the app says it checked, not about a different signer getting in.

**Letting Android's signer check stand alone**, without `SHA256SUMS`. It proves that the project's key signed the APK, not that this release did: an older signed APK could be served as a new one. A lower version code is refused, but the same one is not, and the release's signed list is what the server and the desktop app trust too.
