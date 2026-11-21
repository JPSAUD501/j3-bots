# Releasing the desktop app

A release of the desktop app is a version tag. Pushing one builds the packages on Linux, macOS and Windows and uploads them to a draft GitHub release. A maintainer checks the draft and publishes it. Installed apps are offered a release only once it is published. An AppImage and a Windows install then download it in the background and offer "Restart to update" in Settings → This device; a deb and a Mac build say it is out and link to it ([Clients: desktop](../architecture/clients.md#desktop)).

The builds are unsigned for now. Signing is future work: see [Signing](#signing) below.

## What a release contains

| Platform | Packages | Feed | Updates itself |
| --- | --- | --- | --- |
| Linux x64 | `J3-Bots-x86_64.AppImage`, `j3-bots_<version>_amd64.deb` | `latest-linux.yml` | The AppImage does: it is replaced in place. The deb does not: installing it takes root, which the app never asks for, so it links to the release |
| macOS x64 and arm64 | `J3-Bots-<version>-<arch>-unsigned.dmg` and `.zip`, with a `.blockmap` each | `latest-mac.yml` | No: macOS installs an update only for a signed app. The app links to the release, and each new version is downloaded by hand |
| Windows x64 | `J3-Bots-Setup-<version>-unsigned.exe` and its `.blockmap` | `latest.yml` | Yes. Windows SmartScreen warns before the first install of an unsigned installer |

The feed files are electron-updater's: the version, each file's name, size and SHA-512. Installed apps read them from the latest published release. A pre-release has the same three names (**Verified** on Linux: a build for GitHub of `0.1.0-beta.1` wrote `latest-linux.yml`), so what keeps it from apps on a release version is only its pre-release mark. The block maps let an app download only what changed; the AppImage carries its own. The macOS and Windows files are named as the build configuration asks (**Assumed**: not yet built). The AppImage's name carries no version so that electron-updater replaces it in place: when the file's name has a version, it deletes that file and installs the new version under the release's name (**Read** in electron-updater 6.8.9, `AppImageUpdater.js:72-115`).

## Cutting a release

1. Pick the version. It is [semver](https://semver.org): `1.4.0` for a release, `1.4.0-beta.1` for a pre-release. The tag is the version with a `v`: `v1.4.0`.
2. Make sure the commit to release is on `main` and its CI passed.
3. Tag it and push the tag:

   ```sh
   git tag -a v1.4.0 -m "J3 Bots 1.4.0"
   git push origin v1.4.0
   ```

4. Watch the **Release** workflow in the repository's Actions tab. Its first job creates a draft release for the tag, saying the builds are unsigned, and marks it a pre-release when the version has a suffix. Then one job per platform builds the web client and the app and packages it with the tag's version. A last job checks that the release is still a draft and uploads every package and feed file to it. The platform jobs take about 10 to 20 minutes (**Assumed**: not yet run on GitHub's runners).
5. Open the draft under Releases. Check that it has every file in the table above, then add what changed to its description.
6. Publish it. Leave a pre-release marked as one. Apps on a release version read GitHub's latest release, which skips pre-releases, and look in it for `latest-linux.yml`, `latest-mac.yml` or `latest.yml`; a pre-release published as a release has them too, so every installed app would take it as an update (**Read** in electron-updater 6.8.9, `providers/GitHubProvider.js`, `getLatestTagName`, and `AppUpdater.js`, which turns pre-releases on only for an app that runs one). The workflow refuses to upload to a draft whose pre-release mark disagrees with its tag, as one drafted by hand before the tag was pushed can.

Installed apps check at start and every six hours, so most see a release within six hours of its publication. Until the first release is published, their check fails and Settings says it couldn't get the latest version.

## If something goes wrong

- **A package job failed.** Fix the cause on `main`, delete the draft release and the tag (`git push --delete origin v1.4.0`, then `git tag -d v1.4.0`), and tag again. Never move a published tag: installed apps may already have the version it named.
- **A published release is broken.** Publish a newer version that fixes it. electron-updater does not downgrade, so withdrawing the release only stops apps that have not downloaded it yet.
- **The tag is not a version.** The workflow's first job refuses any tag that is not `v` and a semver version (no leading zeros, no empty part in the suffix), before anything is built.

## What the workflow may do

`.github/workflows/release.yml` runs only when a tag matching `v*` is pushed: never on a pull request, so code from a fork never runs in it. It is the only workflow with `contents: write`, and only two of its jobs have it, neither of which checks out or runs code from the repository: the one that creates the draft, and the one that uploads to it, which takes the files the other jobs built as artifacts and refuses to upload to a release that is no longer a draft. The jobs that install dependencies and build have `contents: read`, as every other workflow does. A job added later, such as one that builds the server's archives, hands its files over as an artifact named `release-<something>` and is added to the upload job's `needs`, which otherwise starts without waiting for it and leaves its files out; the upload job refuses two files with the same name. The workflow uses the run's own `GITHUB_TOKEN` and no other secret. Its actions are pinned by commit, as in every workflow.

## Signing

Nothing is signed yet, and the workflow holds no signing secret.

- **macOS** needs an Apple Developer ID certificate and notarization. Without them, Gatekeeper blocks the first open (right-click → Open, or System Settings → Privacy & Security, lets the operator through), and Squirrel.Mac, which installs updates on macOS, needs a signed app (**Assumed**, from Electron's documentation), so the app does not install updates there: it says when one is out. The build is signed ad hoc only (`identity: "-"`), which Apple Silicon needs to run it at all (**Assumed**: not yet tried on a Mac).
- **Windows** needs a code signing certificate (an OV certificate, or Azure Trusted Signing, which T3 Code uses). Without one, SmartScreen warns before the first install, and electron-updater cannot check that an update comes from the same publisher (see [Security: desktop updates](../architecture/security.md#desktop-updates)).
- **Linux** packages are not signed by convention; the feed's checksums are what electron-updater checks.

Adding signing means secrets in the release workflow, used only by the jobs that build, and `publisherName` in the Windows build so that electron-updater verifies an update's signature before installing it.

## Building packages locally

```sh
pnpm --filter @j3-bots/desktop package
```

builds the web client and the app, then the packages for the platform it runs on, into `apps/desktop/release/`, without publishing anything. A Linux AppImage needs no FUSE 2: the build uses the static AppImage runtime, as T3 Code does. Each package is 100 to 130 MB.

To try an update without publishing, build two versions against a feed on loopback. Copy `apps/desktop/electron-builder.yml`, change its `publish` to `{ provider: generic, url: http://127.0.0.1:<port>/ }`, and build with `--config <that copy> -c.extraMetadata.version=<version>`. Serve the newer build's `.AppImage` and `.yml` from that port with any static HTTP server, and start the older AppImage. A version with a suffix reads a feed named after it: `0.0.2-test` writes `test-linux.yml`.
