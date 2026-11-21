# Releasing J3 Bots

A release is a version tag, with one version for the server, the web client it serves and the desktop app. Pushing the tag builds the desktop packages on Linux, macOS and Windows and the server's archives on x64 and arm64 Linux, and uploads them to a draft GitHub release. A maintainer checks the draft and publishes it. Installed apps are offered a release, and `install.sh` finds it, only once it is published. An AppImage and a Windows install then download it in the background and offer "Restart to update" in Settings → This device; a deb and a Mac build say it is out and link to it ([Clients: desktop](../architecture/clients.md#desktop)).

The builds are unsigned for now. Signing is future work: see [Signing](#signing) below.

## What a release contains

The server:

| File | What it is |
| --- | --- |
| `j3-bots-<version>-linux-x64.tar.gz`, `j3-bots-<version>-linux-arm64.tar.gz` | The server, its web client and the Node it runs on ([decision 0015](../decisions/0015-a-release-is-a-self-contained-archive.md)) |
| `SHA256SUMS` | The SHA-256 of both archives and of `install.sh`, as `sha256sum` writes them |
| `install.sh` | The installer: `curl -fsSL https://github.com/JPSAUD501/j3-bots/releases/latest/download/install.sh \| sh`, and for a pre-release `curl -fsSL https://github.com/JPSAUD501/j3-bots/releases/download/v1.4.0-rc.1/install.sh \| sh -s -- --version 1.4.0-rc.1` |

`install.sh` installs the latest release unless `--version` names one: it reads the repository's `releases/latest` page, which never names a pre-release or a draft, and refuses an answer that is not a plain `x.y.z` (**Read** in T3 Code's `scripts/install.sh` at `db51b67`, `:190-197`, which reads the same page). A pre-release is installed only by name, and from its own tag's address: `releases/latest/download/install.sh` answers only once a release that is not a pre-release is published, so until then the per-tag form above is the only one that works. It downloads the archive for the machine's architecture into a private temporary folder and installs it only if its digest is the one in `SHA256SUMS`. The [Raspberry Pi guide](running-on-a-pi.md#install) describes what it installs where.

The desktop app:

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

4. Watch the **Release** workflow in the repository's Actions tab. Its first job creates a draft release for the tag, saying the builds are unsigned, and marks it a pre-release when the version has a suffix. Then one job per desktop platform builds the web client and the app and packages it with the tag's version, and one job per Linux architecture builds the server's archive with the tag's version and runs the same smoke as CI on it: the archive with no Node on `PATH`, and `install.sh` from a local mirror. Another job writes `SHA256SUMS`. A last job checks that the release is still a draft and uploads every package, feed file, archive, `SHA256SUMS` and `install.sh` to it. The platform jobs take about 10 to 20 minutes (**Assumed**: not yet run on GitHub's runners).
5. Open the draft under Releases. Check that it has every file in the tables above, then add what changed to its description.
6. Publish it. Leave a pre-release marked as one. Apps on a release version read GitHub's latest release, which skips pre-releases, and look in it for `latest-linux.yml`, `latest-mac.yml` or `latest.yml`; a pre-release published as a release has them too, so every installed app would take it as an update (**Read** in electron-updater 6.8.9, `providers/GitHubProvider.js`, `getLatestTagName`, and `AppUpdater.js`, which turns pre-releases on only for an app that runs one). The workflow refuses to upload to a draft whose pre-release mark disagrees with its tag, as one drafted by hand before the tag was pushed can.

Installed apps check at start and every six hours, so most see a release within six hours of its publication. Until the first release is published, their check fails and Settings says it couldn't get the latest version.

## If something goes wrong

- **A package or server job failed.** Fix the cause on `main`, delete the draft release and the tag (`git push --delete origin v1.4.0`, then `git tag -d v1.4.0`), and tag again. Never move a published tag: installed apps may already have the version it named.
- **A published release is broken.** Publish a newer version that fixes it. electron-updater does not downgrade, so withdrawing the release only stops apps that have not downloaded it yet.
- **The tag is not a version.** The workflow's first job refuses any tag that is not `v` and a semver version (no leading zeros, no empty part in the suffix), before anything is built.

## What the workflow may do

`.github/workflows/release.yml` runs only when a tag matching `v*` is pushed: never on a pull request, so code from a fork never runs in it. It is the only workflow with `contents: write`, and only two of its jobs have it, neither of which checks out or runs code from the repository: the one that creates the draft, and the one that uploads to it, which takes the files the other jobs built as artifacts and refuses to upload to a release that is no longer a draft. The jobs that install dependencies and build have `contents: read`, as every other workflow does. Each job that builds hands its files over as an artifact named `release-<something>` and is in the upload job's `needs`, which otherwise starts without waiting for it and leaves its files out: the desktop jobs, the server jobs, and the one that writes `SHA256SUMS`, which reads the archives and runs none of them. A job added later is added there too. The upload job refuses two files with the same name. The workflow uses the run's own `GITHUB_TOKEN` and no other secret. Its actions are pinned by commit, as in every workflow.

## Signing

Nothing is signed yet, and the workflow holds no signing secret.

- **macOS** needs an Apple Developer ID certificate and notarization. Without them, Gatekeeper blocks the first open (right-click → Open, or System Settings → Privacy & Security, lets the operator through), and Squirrel.Mac, which installs updates on macOS, needs a signed app (**Assumed**, from Electron's documentation), so the app does not install updates there: it says when one is out. The build is signed ad hoc only (`identity: "-"`), which Apple Silicon needs to run it at all (**Assumed**: not yet tried on a Mac).
- **Windows** needs a code signing certificate (an OV certificate, or Azure Trusted Signing, which T3 Code uses). Without one, SmartScreen warns before the first install, and electron-updater cannot check that an update comes from the same publisher (see [Security: desktop updates](../architecture/security.md#desktop-updates)).
- **Linux** packages are not signed by convention; the feed's checksums are what electron-updater checks.

Adding signing means secrets in the release workflow, used only by the jobs that build, and `publisherName` in the Windows build so that electron-updater verifies an update's signature before installing it.

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

## Building packages locally

```sh
pnpm --filter @j3-bots/desktop package
```

builds the web client and the app, then the packages for the platform it runs on, into `apps/desktop/release/`, without publishing anything. A Linux AppImage needs no FUSE 2: the build uses the static AppImage runtime, as T3 Code does. Each package is 100 to 130 MB.

To try an update without publishing, build two versions against a feed on loopback. Copy `apps/desktop/electron-builder.yml`, change its `publish` to `{ provider: generic, url: http://127.0.0.1:<port>/ }`, and build with `--config <that copy> -c.extraMetadata.version=<version>`. Serve the newer build's `.AppImage` and `.yml` from that port with any static HTTP server, and start the older AppImage. A version with a suffix reads a feed named after it: `0.0.2-test` writes `test-linux.yml`.
