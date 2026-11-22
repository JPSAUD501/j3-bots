# 0017: The Android app is an APK on the release, signed with the project's key

**Status:** Accepted

## Context

The mobile app ran only as a development build, which needs Metro on the machine that built it. An operator who wants it on their phone needs a build that runs on its own, from somewhere they can get it. J3 Bots has no Google Play listing, no Expo account and no Firebase project.

Android installs an APK over an installed app only when both carry the same application id and are signed with the same key, and the new one's version code is not lower. The first APK anyone installs fixes the id and the key for every later one: changing either makes a different app, which a phone takes only after the old one is uninstalled, with its pairing, drafts and unsent messages.

## Decision

**Each release carries one APK**, `j3-bots-<version>-android-arm64.apk`, built by the release workflow from the tag ([Releasing](../operations/releasing.md)): the production variant (`APP_VARIANT=production`, "J3 Bots", `dev.j3bots.mobile`), with its JavaScript bundled, for arm64 only, since that is what phones run.

**It is signed with one key the project keeps**, in four repository secrets the release workflow's Android job alone reads. The keystore is decoded on the runner only for the build that signs with it. The repository holds no signing config: the Android Gradle Plugin's injected signing properties take the place of the generated project's release signing config.

**Its version code is the workflow's run number**, which grows with each run, so every release's APK installs over the one before.

## Consequences

- `dev.j3bots.mobile` and the key are fixed once a release with the APK is published. Losing the key means every phone uninstalls before the next release; a leaked key lets anyone sign an update the phone accepts. The key is backed up outside the repository.
- One secret in a workflow that otherwise uses only `GITHUB_TOKEN`. Only a pushed `v*` tag runs the job, so no pull request, and no fork's code, reaches it.
- No push notifications in this APK: they need an Expo project and a Firebase project.
- A version code from the run number says nothing about the version: a release built later has a higher code than one built earlier, whatever their versions, so a phone accepts an older version built later.
- The operator installs from the browser and allows installs from it once; the phone does not update the app on its own.

## Rejected

**Google Play.** It needs a developer account, a listing and review for each release, and Play App Signing holds the key. It stays possible later with the same id, if the key is uploaded to Play.

**An EAS build.** It needs an Expo account, and the key would be held by Expo or uploaded to it.

**A version code from the version**, such as `major * 10000 + minor * 100 + patch`. A pre-release's suffix (`-rc.1`, `-beta.2`) has no place in such a number without limits on what a tag may say.
