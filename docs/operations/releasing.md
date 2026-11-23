# Releasing J3 Bots

A release is a version tag, with one version for the server, the web client it serves, the desktop app and the Android app. Pushing the tag builds the desktop packages on Linux, macOS and Windows, each with the server runtime its platform runs local mode on, the server's archives on x64 and arm64 Linux and a signed Android APK, and uploads them to a draft GitHub release. A maintainer checks the draft and publishes it. Installed apps are offered a release, and `install.sh` finds it, only once it is published. An AppImage and a Windows install then download it in the background and offer "Restart to update" in Settings → This device; a deb and a Mac build say it is out and link to it ([Clients: desktop](../architecture/clients.md#desktop)).

The desktop builds are unsigned for now; the Android APK is signed with the project's own key. See [Signing](#signing) below.

## What a release contains

The server:

| File | What it is |
| --- | --- |
| `j3-bots-<version>-linux-x64.tar.gz`, `j3-bots-<version>-linux-arm64.tar.gz` | The server, its web client and the Node it runs on ([decision 0015](../decisions/0015-a-release-is-a-self-contained-archive.md)) |
| `SHA256SUMS` | The SHA-256 of both archives and of `install.sh`, as `sha256sum` writes them |
| `install.sh` | The installer: `curl -fsSL https://github.com/JPSAUD501/j3-bots/releases/latest/download/install.sh \| sh`, and for a pre-release `curl -fsSL https://github.com/JPSAUD501/j3-bots/releases/download/v1.4.0-rc.1/install.sh \| sh -s -- --version 1.4.0-rc.1` |

`install.sh` installs the latest release unless `--version` names one: it reads the repository's `releases/latest` page, which never names a pre-release or a draft, and refuses an answer that is not a plain `x.y.z` (**Read** in T3 Code's `scripts/install.sh` at `db51b67`, `:190-197`, which reads the same page). A pre-release is installed only by name, and from its own tag's address: `releases/latest/download/install.sh` answers only once a release that is not a pre-release is published, so until then the per-tag form above is the only one that works. It downloads the archive for the machine's architecture into a private temporary folder and installs it only if its digest is the one in `SHA256SUMS`. [Installing J3 Bots](install.md#install) describes what it installs where.

The desktop app:

| Platform | Packages | Feed | Updates itself |
| --- | --- | --- | --- |
| Linux x64 | `J3-Bots-x86_64.AppImage`, `j3-bots_<version>_amd64.deb` | `latest-linux.yml` | The AppImage does: it is replaced in place. The deb does not: installing it takes root, which the app never asks for, so it links to the release |
| macOS x64 and arm64 | `J3-Bots-<version>-<arch>-unsigned.dmg` and `.zip`, with a `.blockmap` each | `latest-mac.yml` | No: macOS installs an update only for a signed app. The app links to the release, and each new version is downloaded by hand |
| Windows x64 | `J3-Bots-Setup-<version>-unsigned.exe` and its `.blockmap` | `latest.yml` | Yes. Windows SmartScreen warns before the first install of an unsigned installer |

Each desktop package for a platform the app runs local mode on carries the server runtime for it, in its resources as `server-runtime/` ([decision 0015](../decisions/0015-a-release-is-a-self-contained-archive.md)): the AppImage and the deb (`linux-x64`), the Windows installer (`win32-x64`), and the arm64 dmg and zip (`darwin-arm64`). The x64 Mac build carries none: on an Intel Mac the app only connects to a server. The runtime is the server archive's folder without `web/`, since the app brings its own web client, and without the `sh` launcher, since the app starts Node itself:

```
server-runtime/
  node/bin/node         the Node release package.json pins; node/node.exe on Windows
  server/               the server bundle, with its prompt files
  release.json          version (the app's), platform, Node release and engine
  LICENSE
  APP-STORE-PERMISSION
  THIRD_PARTY_NOTICES   Node, and what the server bundle holds
```

`pnpm release --server-runtime` builds it into `dist/release/server-runtime/<platform>/`, and each platform's `extraResources` in `apps/desktop/electron-builder.yml` copies it into the package. electron-builder only warns when such a folder is missing, so a build hook, `apps/desktop/scripts/afterPack.ts`, fails the build of a package that lacks the runtime its platform needs, carries one of another version or platform, or carries one where local mode does not run. The engine is not in it: the server downloads it on its first start. The runtime on disk is 155 MB for Linux, 152 MB for macOS and 105 MB for Windows, almost all of it Node. Copied out of the AppImage and started with no Node on `PATH`, its server answered `/health` 0.3 s after it started, and had downloaded the engine and started it 8.2 s after (**Verified** on a Linux x64 VM).

What the runtime adds to each package (1 MB is 1,000,000 bytes):

| Package | Without it (`v0.2.0`) | With it | Added |
| --- | --- | --- | --- |
| `J3-Bots-x86_64.AppImage` | 121.5 MB | 169.0 MB | 47.5 MB |
| `j3-bots_<version>_amd64.deb` | 103.2 MB | 140.0 MB | 36.8 MB |
| `J3-Bots-Setup-<version>-unsigned.exe` | 123.8 MB | 152.2 MB | 28.4 MB |
| `J3-Bots-<version>-arm64-unsigned.dmg` | 135.0 MB | 180.9 MB | 46.0 MB |
| `J3-Bots-<version>-arm64-unsigned.zip` | 130.6 MB | 174.7 MB | 44.0 MB |
| `J3-Bots-<version>-x64-unsigned.dmg`, `.zip` | 140.3 MB, 136.0 MB | the same | none |

**Verified**: the sizes without it are `v0.2.0`'s, built from the commit before the runtime was added; the sizes with it are that commit's packages with the runtime, built on a Linux x64 VM and by CI on GitHub's macOS and Windows runners.

The feed files are electron-updater's: the version, each file's name, size and SHA-512. Installed apps read them from the latest published release. A pre-release has the same three names (**Verified** on Linux: a build for GitHub of `0.1.0-beta.1` wrote `latest-linux.yml`), so what keeps it from apps on a release version is only its pre-release mark. The block maps let an app download only what changed; the AppImage carries its own. The macOS and Windows files are named as the build configuration asks (**Verified** on GitHub's runners: `v0.1.0` built `J3-Bots-0.1.0-arm64-unsigned.dmg` and `J3-Bots-0.1.0-arm64-unsigned.zip`, the same for x64, each with its `.blockmap`, `J3-Bots-Setup-0.1.0-unsigned.exe` with its `.blockmap`, `latest-mac.yml` and `latest.yml`). The app they hold has not been run on macOS or Windows. The AppImage's name carries no version so that electron-updater replaces it in place: when the file's name has a version, it deletes that file and installs the new version under the release's name (**Read** in electron-updater 6.8.9, `AppImageUpdater.js:72-115`).

The Android app:

| File | What it is |
| --- | --- |
| `j3-bots-<version>-android-arm64.apk` | The app's production variant (`APP_VARIANT=production`: "J3 Bots", `dev.j3bots.mobile`), with its JavaScript bundled, for arm64 phones, signed with the release key ([Android signing](#android-signing)), whose certificate's SHA-256 is `bfd3b598e6bd1c1ccdc969076a4254fd5a3696bddd5092df44b2bb51581431ff` |

**Verified** on the published `j3-bots-0.1.0-rc.1-android-arm64.apk`, with build-tools 37.0.0: `apksigner verify --print-certs` verifies it, with schemes v2 and v3 and one signer, whose certificate's SHA-256 is the one above, and `aapt2 dump badging` reads package `dev.j3bots.mobile`, label "J3 Bots", version name `0.1.0-rc.1`, version code 10,001, and native code for `arm64-v8a` only.

The APK carries the release's version as its version name, and a version code made from it (`apps/mobile/src/androidVersionCode.ts`). Android installs an APK over the app only when its version code is not lower than the installed one's, so the code grows with the version:

```
major * 1,000,000 + minor * 10,000 + patch * 100 + stage
```

The stage is `n` for a release candidate `-rc.n` and 99 for the release, so `1.5.0-rc.2` is 1,050,002, below `1.5.0`, 1,050,099, and a hotfix `1.4.1`, 1,040,199, stays below `1.5.0` whenever it is tagged. **Verified** on the Pixel 8 emulator: `0.1.0` (10,099) installed over `0.1.0-rc.1` (10,001) and kept its pairing, and `0.1.0-rc.1` over `0.1.0` was refused as a downgrade. The minor and the patch go up to 99, a release candidate up to `rc.98`, and the major up to 2099, which keeps the code under 2,100,000,000, the largest Google Play takes. A version outside these, or with another pre-release label such as `-beta.1`, has no version code, so a release is `x.y.z` or `x.y.z-rc.n` within these limits: the workflow's first job refuses any other tag before anything is built. It checks the tag in the shell, since it may write and so runs no code from the repository; its check and `androidVersionCode` each name the other, and a change to one is made to both.

It is built without an Expo or a Firebase project, so it cannot turn push notifications on. It holds no development client: the generated project compiles `expo-dev-launcher` and `expo-dev-menu` for a release build from their stubs, which start no launcher, open no menu and never reach Metro (**Read** in `expo-dev-launcher` 58.0.21 and `expo-dev-menu` 58.0.13, `android/build.gradle`: their `release` source sets are `src/disableInRelease`, and the launcher's and the menu's own dependencies are `debugImplementation` only). The release build also runs R8, which the generated project turns on (`android.enableMinifyInReleaseBuilds`). `SHA256SUMS` does not list it: it covers what `install.sh` checks, and Android checks the APK's signature itself. [Clients: installing the Android app](../architecture/clients.md#installing-the-android-app) describes the install.

## Cutting a release

1. Pick the version. It is [semver](https://semver.org): `1.4.0` for a release, `1.4.0-rc.1` for a pre-release. The release takes only these two forms, with a major version up to 2099, a minor and a patch up to 99 and a release candidate up to `rc.98`, the versions the Android app can number ([its version code](#what-a-release-contains)). The tag is the version with a `v`: `v1.4.0`.
2. Make sure the commit to release is on `main` and its CI passed.
3. Tag it and push the tag:

   ```sh
   git tag -a v1.4.0 -m "J3 Bots 1.4.0"
   git push origin v1.4.0
   ```

4. Watch the **Release** workflow in the repository's Actions tab. Its first job refuses a tag the Android app cannot number and stops when `ANDROID_CERT_SHA256` is not a SHA-256, then creates a draft release for the tag, saying the builds are unsigned, and marks it a pre-release when the version has a suffix. Then one job per desktop platform builds the server runtime for its platform, the web client and the app, packages them with the tag's version and checks the packaged runtime with `scripts/check-server-runtime.ts`: its files and `release.json` carry the tag's version, its Node is the pinned one, its server prints `j3-bots v<version>` and starts, answering `/health`, then stops with code 0 when its stdin ends, as the desktop app stops it. One job per Linux architecture builds the server's archive with the tag's version and runs the same smoke as CI on it: the archive with no Node on `PATH`, and `install.sh` from a local mirror, one job builds the APK unsigned, and another signs it. The signing job fails at once when any of the [four signing secrets](#android-signing) is missing. Another job writes `SHA256SUMS`. A last job checks that the release is still a draft and uploads every package, feed file, archive, the APK, `SHA256SUMS` and `install.sh` to it. A run takes about 12 minutes from the tag's push to the upload (**Verified** for `v0.1.0-rc.1` on GitHub's runners). For it and for `v0.1.0`, all ten jobs passed, and each draft had every file in the tables above, 20 of them.
5. Open the draft under Releases. Check that it has every file in the tables above, then add what changed to its description.
6. Publish it. Leave a pre-release marked as one. Apps on a release version read GitHub's latest release, which skips pre-releases, and look in it for `latest-linux.yml`, `latest-mac.yml` or `latest.yml`; a pre-release published as a release has them too, so every installed app would take it as an update (**Read** in electron-updater 6.8.9, `providers/GitHubProvider.js`, `getLatestTagName`, and `AppUpdater.js`, which turns pre-releases on only for an app that runs one). The workflow refuses to upload to a draft whose pre-release mark disagrees with its tag, as one drafted by hand before the tag was pushed can.

Installed apps check at start and every six hours, so most see a release within six hours of its publication. Until the first release is published, their check fails and Settings says it couldn't get the latest version.

## If something goes wrong

- **A package or server job failed.** Fix the cause on `main`, delete the draft release and the tag (`git push --delete origin v1.4.0`, then `git tag -d v1.4.0`), and tag again. Never move a published tag: installed apps may already have the version it named.
- **A published release is broken.** Publish a newer version that fixes it. electron-updater does not downgrade, so withdrawing the release only stops apps that have not downloaded it yet.
- **The tag is not a version.** The workflow's first job refuses any tag that is not `v` and `x.y.z` or `x.y.z-rc.n` within the limits above (no leading zeros), before anything is built. It also stops when the repository variable `ANDROID_CERT_SHA256` is not a SHA-256, before it writes the draft's notes, which give it.
- **The Android sign job failed, and its retry is more than 7 days after the build.** The unsigned APK it signs is an artifact kept for 7 days. Once it has expired, "Re-run failed jobs" fails to download it: use "Re-run all jobs", which builds it again.

## What the workflow may do

`.github/workflows/release.yml` runs only when a tag matching `v*` is pushed: never on a pull request, so code from a fork never runs in it. It is the only workflow with `contents: write`, and only two of its jobs have it, neither of which checks out or runs code from the repository: the one that creates the draft, and the one that uploads to it, which takes the files the other jobs built as artifacts and refuses to upload to a release that is no longer a draft. The jobs that install dependencies and build have `contents: read`, as every other workflow does. Each job that builds hands its files over as an artifact named `release-<something>` and is in the upload job's `needs`, which otherwise starts without waiting for it and leaves its files out: the desktop jobs, the server jobs, `android-sign`, which signs what `android` built, and the one that writes `SHA256SUMS`, which reads the archives and runs none of them. A job added later is added there too. The upload job refuses two files with the same name. Every job but one uses the run's own `GITHUB_TOKEN` and no other secret.

The Android app is built and signed by two jobs, so that the key never meets code from the repository or its dependencies:

- **`android`** builds the APK unsigned (`plugins/unsignedRelease.js`) and holds no secret. Gradle runs build scripts and plugins from `node_modules` and downloads from Maven repositories, and a process started by `pnpm install` or `expo prebuild` could outlive its step, so this job is never given the key. It hands the APK to the next job as `android-unsigned`, an artifact `publish` does not take.
- **`android-sign`** is the only job that reads a secret. Its four secrets are in the `android-signing` environment, which admits only `v*` tags: neither a pull request nor a branch can reach them, and whoever may push a `v*` tag can use the key. The repository's "release tags" ruleset lets only admins create, update or delete one. It checks nothing out, installs nothing and runs nothing from the repository or the build: it downloads the unsigned APK, writes the keystore to the runner's temporary folder, readable by its user only, and signs with the runner image's own `apksigner`, which reads the passwords from its environment, never its command line. The keystore is deleted in the next step, which runs even when signing failed. The job then fails unless `apksigner verify` verifies the APK and every signature it carries is made with one certificate, whose SHA-256 is the repository variable `ANDROID_CERT_SHA256`: the digests it prints, one for each signature scheme, must come to exactly one distinct value, that one. It also fails unless `zipalign -c -P 16 4` finds the native libraries aligned to 16 KB pages. It hands the APK to `publish` as `release-android`.

**Separate jobs protect the key, not what it signs.** The sign job signs whatever `android` built: a compromised build dependency in a real release still gets its APK signed with the release key, and the signed APK can be downloaded as the run's `release-android` artifact before the draft is published. The same compromise would reach the desktop packages and the server archives, which are not signed at all. So the gate for every file of a release is the maintainer's review of the draft before publishing it; an approval on the sign job would check nothing that review does not.

No step prints a secret: the sign job prints only the certificate's DN and SHA-256, which are public. The actions are pinned by commit, as in every workflow.

The Android jobs keep no cache. GitHub lets a run read only the caches of its own ref and of the default branch, and this workflow runs only on tags, so a cache a release saved would be read by nothing but a retry of that same tag.

## Signing

The desktop builds are unsigned; only the Android APK is signed.

- **macOS** needs an Apple Developer ID certificate and notarization. Without them, Gatekeeper blocks the first open (right-click → Open, or System Settings → Privacy & Security, lets the operator through), and Squirrel.Mac, which installs updates on macOS, needs a signed app (**Assumed**, from Electron's documentation), so the app does not install updates there: it says when one is out. The build is signed ad hoc only (`identity: "-"`), which Apple Silicon needs to run it at all (**Assumed**: not yet tried on a Mac).
- **Windows** needs a code signing certificate (an OV certificate, or Azure Trusted Signing, which T3 Code uses). Without one, SmartScreen warns before the first install, and electron-updater cannot check that an update comes from the same publisher (see [Security: desktop updates](../architecture/security.md#desktop-updates)).
- **Linux** packages are not signed by convention; the feed's checksums are what electron-updater checks.

Adding signing means secrets in the release workflow, read only by a job that signs and runs no code from the repository or the build, as [Android signing](#android-signing) does, and `publisherName` in the Windows build so that electron-updater verifies an update's signature before installing it.

### Android signing

Android installs an update only when it is signed with the same key as the installed app. The release workflow signs with one key, held in four secrets of the repository's `android-signing` environment, which only the sign job reads:

| Secret | What it holds |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The keystore file, in base64 |
| `ANDROID_KEYSTORE_PASSWORD` | The keystore's password |
| `ANDROID_KEY_ALIAS` | The key's alias in the keystore |
| `ANDROID_KEY_PASSWORD` | The key's password. A PKCS12 keystore, which `keytool` makes by default, has one password for both, so this is the keystore's password again |

Beside them, the repository variable `ANDROID_CERT_SHA256` holds the release certificate's SHA-256, in lowercase hex without colons, as `apksigner verify --print-certs` prints it: `bfd3b598e6bd1c1ccdc969076a4254fd5a3696bddd5092df44b2bb51581431ff`. It is public. The sign job refuses an APK with a signature made with any other certificate, and anyone can compare a downloaded APK with it ([Clients: installing the Android app](../architecture/clients.md#installing-the-android-app)).

The generated project would sign a release build with the debug key; `plugins/unsignedRelease.js` takes that signing config away, so Gradle writes `app-release-unsigned.apk`, and the repository holds no signing config and no key.

A maintainer creates the key once, on their own machine, outside any checkout:

```sh
keytool -genkeypair -v -storetype PKCS12 -keystore j3-bots-release.jks \
  -alias j3-bots -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=J3 Bots"
base64 -w 0 j3-bots-release.jks > j3-bots-release.jks.base64   # macOS: base64 -i j3-bots-release.jks -o j3-bots-release.jks.base64
```

`keytool` asks for the password. The key is valid for 100 years, so it never expires under the app.

Then, in the repository's settings, create the environment (Environments → New environment): name it `android-signing`, and under Deployment branches and tags allow only tags matching `v*`. Since that lets anyone who may push a `v*` tag use the key, add a tag ruleset too (Rules → Rulesets → New tag ruleset): name it "release tags", target tags matching `v*`, restrict creations, updates and deletions, and let only the Repository admin role bypass it. Set the four secrets in the environment, then the variable, with `gh`, which reads a secret from its input without echoing it:

```sh
gh secret set ANDROID_KEYSTORE_BASE64 --env android-signing < j3-bots-release.jks.base64
gh secret set ANDROID_KEYSTORE_PASSWORD --env android-signing   # asks for the value
gh secret set ANDROID_KEY_ALIAS --env android-signing --body j3-bots
gh secret set ANDROID_KEY_PASSWORD --env android-signing        # the keystore's password again
gh variable set ANDROID_CERT_SHA256 --body "$(keytool -exportcert -keystore j3-bots-release.jks -alias j3-bots | sha256sum | cut -d' ' -f1)"
rm j3-bots-release.jks.base64
```

`keytool -exportcert` writes the certificate in DER, whose SHA-256 is the digest `apksigner` prints (**Verified**: they matched for a test key). The secrets belong in the environment only: a repository secret of the same name would be readable by any job of any workflow.

**Keep the keystore and its password backed up outside the repository**, in a password manager or an encrypted backup. A leaked key lets anyone sign an APK a phone takes as an update. `.gitignore` keeps `*.jks` and `*.keystore` files out of commits.

**A key can be replaced, but only by its holder.** APK Signature Scheme v3 lets a new key take over on Android 9 and later: `apksigner rotate` writes a lineage, signed with the old key, that vouches for the new one, and releases from then on are signed with the new key and that lineage. Phones on Android 7 and 8, which the app still supports (`minSdk` 24), check only the original key, so it keeps signing for them, and `apksigner` by default applies the new key only from Android 13, through scheme v3.1 (**Read** in Android's documentation of `apksigner` and of the APK signature schemes). Every step of a rotation needs the old key. **Losing it cannot be undone**: no release can then be installed over an installed app, and every phone has to uninstall the app, which deletes its pairing, drafts and unsent messages, before it installs the next one.

## Trying an install locally

`J3_RELEASE_BASE_URL` points `install.sh` at a mirror of the release page that serves `latest` and `download/v<version>/<file>`. The mirror serves both the archive and the `SHA256SUMS` it is checked against, so the check proves the download is the mirror's, not that the release is genuine: the override trusts the mirror as the publisher, and is for tests and self-hosted mirrors.

```sh
pnpm release
version=0.0.0   # what the archive's name says
mkdir -p mirror/download/v$version
cp dist/release/j3-bots-$version-linux-*.tar.gz scripts/install.sh mirror/download/v$version/
(cd mirror/download/v$version && sha256sum -- *.tar.gz install.sh > SHA256SUMS)
printf '{"tag_name":"v%s"}' "$version" > mirror/latest
```

Serve `mirror/` from a port with any static HTTP server, then, as the user to install for:

```sh
curl -fsSL http://127.0.0.1:<port>/download/v$version/install.sh | J3_RELEASE_BASE_URL=http://127.0.0.1:<port> sh
```

`j3-bots uninstall --delete-data` removes it again, data included. CI does the same without the service, in the server's release smoke (`apps/server/smoke/install.test.ts`).

## The upgrade check

`apps/server/upgrade-check` moves one install between two release archives, A and B, through the service, as an operator would, and checks that nothing the operator sees is lost on the way:

1. It installs A with `install.sh` from a local mirror, with the service, for a scratch `HOME`. That `HOME` is the installer's and the `j3-bots` command's, so the install, the command and the data directory are in it. The unit names the data directory (`J3_HOME`) but not `HOME`, so the service runs with the user manager's `HOME`: the engine's `--base-dir` and the harnesses' homes are under the data directory, so nothing the service writes leaves it. Before the first start it writes a `config.json` with free ports and `scriptedAgent` set, so the service's bots run their turns on the scripted agent, with no model. The unit goes where this user's systemd manager reads units; the check refuses to run where a `j3-bots` unit exists already.
2. A device pairs through the admin socket and `/api/pair`. It creates two bots, a room and a webhook routine, and runs a reply, an approval (allowed once), a question (answered), a reply in the room and one run of the routine.
3. It runs `j3-bots update` to B, `j3-bots update --rollback` to A and `j3-bots update` to B again. After each it compares what the device reads (the roster, every entry of both conversations and of the room, the routine and its runs) with what that release should show: after the rollback, A's view from before the first update; after each update, the view of the release it left. It checks the snapshot the update took, which names both releases and their engines, and the migration the engine reports its database holds: the rollback puts A's back, and the second update the same as the first. It checks what the update or the rollback promises once it has finished: `versions/` holds A and B and nothing else, `backups/` at most two snapshots and the lock, and the engine's runtime folder the engines both releases pin, read from disk since a failure to prune only warns; no snapshot is marked as a rollback not finished, `backups/update.lock` is free, the command and the unit run the same release, and `j3-bots doctor` reports Configuration, Snapshot, Server, Engine, Service, Command and Pairing and passes every check of the install but the scripted agent's, which warns. Its checks of the machine itself, its user and the harnesses it has, are left out. The second update must take a snapshot of its own. Then the bot takes one more turn, which must run in the main session it had, in the same engine thread, with no rotation and no session lost; the other bot, which takes no turn, keeps its main session as it was.
4. `j3-bots uninstall --delete-data` removes it all, and the check sees no unit left.

To run it, build two archives that differ in version. A and B may come from different commits, as long as both have `scriptedAgent` (a release refuses a `config.json` key it does not know, so A must include the commit that added it, `d290b1c`) and both speak this checkout's client protocol: the check talks to both with this checkout's contracts and its scripted agent. To move the engine too, build A with an earlier commit's `engine.json`, which names the engine a release pins and its digests:

```sh
git show <earlier commit>:engine.json > engine.json   # leave it out to keep this commit's pin
(cd apps/server && npm pkg set version=0.0.1)
pnpm exec node scripts/build-release.ts --out /tmp/releases
git checkout engine.json
(cd apps/server && npm pkg set version=0.0.2)
pnpm exec node scripts/build-release.ts --out /tmp/releases
git checkout apps/server/package.json
J3_UPGRADE_FROM=/tmp/releases/j3-bots-0.0.1-linux-x64.tar.gz \
J3_UPGRADE_TO=/tmp/releases/j3-bots-0.0.2-linux-x64.tar.gz \
  pnpm --filter @j3-bots/server upgrade-check
```

It needs a systemd user manager and the network, to download the engine. It installs a real service under the user who runs it, so run it on a machine kept for tests.

The **Upgrade check** workflow (`.github/workflows/upgrade-check.yml`) runs it on demand on x64 and arm64 runners, with both archives built from the commit it runs on, and A pinned to the engine of the commit its `from-engine` input names, if it names one. It lets the runner's user linger to get a systemd user manager. It reads the repository and uses no secret.

## Building packages locally

```sh
pnpm --filter @j3-bots/desktop package
```

builds the web client, the app and the server runtime for the platform it runs on (`pnpm release --server-runtime`), then the packages for that platform, into `apps/desktop/release/`, without publishing anything. It runs on Linux x64, Windows x64 and Apple Silicon, the platforms a runtime is built for; on an Intel Mac, `electron-builder --publish never` alone builds the x64 packages, which carry none. A Linux AppImage needs no FUSE 2: the build uses the static AppImage runtime, as T3 Code does. [What a release contains](#what-a-release-contains) gives each package's size.

CI builds the same packages on Linux, macOS and Windows for every pull request, sets the server's version to `0.0.0-ci.<run>` as the release sets the tag's, checks each packaged runtime where it was packaged as the release does, and writes each package's size to the job's summary (`.github/workflows/ci.yml`, `packages`).

To try an update without publishing, build two versions against a feed on loopback. Copy `apps/desktop/electron-builder.yml`, change its `publish` to `{ provider: generic, url: http://127.0.0.1:<port>/ }`, and build with `--config <that copy> -c.extraMetadata.version=<version>`. Serve the newer build's `.AppImage` and `.yml` from that port with any static HTTP server, and start the older AppImage. A version with a suffix reads a feed named after it: `0.0.2-test` writes `test-linux.yml`.

## Building the APK locally

The same two steps as the release jobs, with a key of your own (any keystore will do for a phone that has no release installed) and the ABI of the device: `arm64-v8a` for a phone, `x86_64` for an emulator. `apksigner` and `zipalign` are in the Android SDK's `build-tools/<version>/`.

```sh
cd apps/mobile
APP_VARIANT=production pnpm exec expo prebuild --platform android --clean --no-install
cd android
APP_VARIANT=production ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
KS_PASS=<password> apksigner sign --ks <keystore> --ks-key-alias <alias> \
  --ks-pass env:KS_PASS --key-pass env:KS_PASS \
  --out j3-bots.apk app/build/outputs/apk/release/app-release-unsigned.apk
```

`APP_VARIANT` is needed for the Gradle build too: it bundles the app's config with the JavaScript. Run `pnpm android` afterwards to go back to the development variant, whose prebuild replaces the native project.
