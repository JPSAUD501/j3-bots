# 0017: The Android app is an APK on the release, signed with the project's key

**Status:** Accepted

## Context

The mobile app ran only as a development build, which needs Metro on the machine that built it. An operator who wants it on their phone needs a build that runs on its own, from somewhere they can get it. J3 Bots has no Google Play listing, no Expo account and no Firebase project.

Android installs an APK over an installed app only when both carry the same application id and are signed with the same key, and the new one's version code is not lower. The first APK anyone installs fixes the id and the key for every later one: changing the id makes a different app, which a phone takes only after the old one is uninstalled, with its pairing, drafts and unsent messages, and a new key is accepted only through a rotation the old key signs.

## Decision

**Each release carries one APK**, `j3-bots-<version>-android-arm64.apk`, built by the release workflow from the tag ([Releasing](../operations/releasing.md)): the production variant (`APP_VARIANT=production`, "J3 Bots", `dev.j3bots.mobile`), with its JavaScript bundled, for arm64 only, since that is what phones run.

**It is signed with one key the project keeps, away from the build.** One job builds the APK unsigned and holds no secret, since Gradle runs code from `node_modules` and from Maven repositories. A second job signs it: the key is four secrets of the `android-signing` environment, which admits only `v*` tags and, for the nightly ([decision 0031](0031-a-release-is-signed-and-a-nightly-is-a-pre-release-of-the-next-patch.md)), `main`, so anyone who may push a `v*` tag or merge to `main` may use the key; the repository's "release tags" ruleset leaves `v*` tags to admins, with no bypass for GitHub Actions, and a nightly's tag is outside `v*`. That job checks nothing out and runs nothing from the repository or the build, only the runner image's `apksigner` and `zipalign`. It refuses an APK unless every signature on it is made with one certificate, the one whose SHA-256 is the repository variable `ANDROID_CERT_SHA256`: the digests `apksigner` prints come to exactly one distinct value, that one. The variable is public, so anyone can check a download against it.

**Its version code comes from the version** (`apps/mobile/src/androidVersionCode.ts`). Up to `0.3.0` it was `major * 1,000,000 + minor * 10,000 + patch * 100 + stage`, where the stage is `n` for `-rc.n` and 99 for the release. That left no room for nightlies, so from `0.3.1` it is `major * 100,000,000 + minor * 1,000,000 + patch * 10,000 + stage`, with room for a nightly's day below the release candidates ([decision 0031](0031-a-release-is-signed-and-a-nightly-is-a-pre-release-of-the-next-patch.md)). Either way, it orders as the versions do whenever they are tagged: a release candidate below its release, a hotfix `1.4.1` below `1.5.0`.

## Consequences

- `dev.j3bots.mobile` and the key are fixed once a release with the APK is published. A leaked key lets anyone sign an update the phone accepts. A lost key cannot be replaced: APK Signature Scheme v3 lets a new key take over on Android 9 and later, but only through a lineage the old key signs, and Android 7 and 8 keep checking the old key. The key is backed up outside the repository.
- Four secrets for one key, in an environment that admits only `v*` tags and `main`, read by a job that runs no project code. No pull request, no other branch and no fork's code reaches them; an admin, the only one who may push a `v*` tag, does, and so does a change merged to `main`.
- The separate jobs protect the key, not what it signs. A compromised build dependency still gets its APK signed with the release key, and the signed APK can be downloaded as an Actions artifact before the release is published. The maintainer's review of the draft is the gate for it, as for every other file of the release; the sign job asks for no approval.
- A tag must be `x.y.z` or `x.y.z-rc.n`, with a minor and a patch up to 99, a release candidate up to `rc.98` and, from `0.3.1`, a major up to 20. Only the nightly names `x.y.z-nightly.YYYYMMDD.run`. The release workflow's first job refuses any other version before anything is built.
- No push notifications in this APK: they need an Expo project and a Firebase project.
- The operator installs the first APK from the browser and allows installs from it once. From 0.3.1 the app installs later releases itself, after checking them against the release's signed `SHA256SUMS` ([decision 0035](0035-the-android-app-installs-its-update-through-a-session.md)).

## Rejected

**Google Play.** It needs a developer account, a listing and review for each release, and Play App Signing holds the key. It stays possible later with the same id, if the key is uploaded to Play.

**An EAS build.** It needs an Expo account, and the key would be held by Expo or uploaded to it.

**Signing in the Gradle build**, with the Android Gradle Plugin's injected signing properties. It needs no second job, but the key and its passwords would be in the process that runs every build script of every dependency.

**The workflow's run number as the version code.** It grows with every run, not with the version: a hotfix tagged after a newer release would get the higher code, and renaming the workflow starts the count again.
