# 0031: A release is signed, and a nightly is a pre-release of the next patch

**Status:** Accepted

## Context

A server, a desktop app or a phone that updates itself has to know that what it downloads is a release the project made. Until 0.3.1 a release's `SHA256SUMS` listed only the server archives and `install.sh`, and nothing vouched for `SHA256SUMS` itself: whoever could change a file on the release could change its digest beside it. That was acceptable while a person ran `install.sh` or `j3-bots update` by hand. It isn't when one tap on any paired device installs a release.

The update also gets a second channel, nightly: a build of `main` every day it changed, for an operator who wants changes before they reach a stable release. A nightly has to sort with stable releases in every place that compares versions (the server, electron-updater and Android's version code), so that nothing is ever offered as an update when it isn't newer.

## Decision

**One Ed25519 key signs every release's `SHA256SUMS`.** `SHA256SUMS` lists every other file of the release, `<sha256>  <name>` per line as `sha256sum` writes it, from the bytes that are published (the APK's after it's signed). `SHA256SUMS.sig` is the raw Ed25519 signature over the exact bytes of `SHA256SUMS`, in base64. Every verifier checks the signature first and only then reads a digest from the file. The private key is the secret `RELEASE_SIGNING_KEY` of the `release-signing` environment, read by one job, `sign`, which checks out only the public keys, runs only the runner's `openssl` on the bytes, and verifies its own signature before it hands it on, as `android-sign` does for the APK ([decision 0017](0017-the-android-app-is-a-signed-apk-on-the-release.md)). The public keys are committed in `release-keys/`, and everything that verifies (`install.sh`, the server, the apps) embeds them from there, checked by a test. A signature is good when it verifies with any of them, so a new key can be added in one release and used from the next.

**A nightly is `<next patch>-nightly.<YYYYMMDD>.<run>`, tagged with that version and no `v`.** The next patch is the one after the newest published release or release candidate. When that is `0.3.0`, a nightly built on 24 November 2026 by run 57 is `0.3.1-nightly.20261124.57`, published as a GitHub pre-release with the tag `0.3.1-nightly.20261124.57`. Semantic versioning puts it after `0.3.0` and before `0.3.1` and `0.3.1-rc.1` ("nightly" sorts before "rc"), and orders nightlies by date, then run. Once `0.3.1-rc.1` is out, the next nightly is `0.3.2-nightly.*`, so a nightly always sorts above the newest candidate. It's built only from a commit whose CI passed on `main`. It carries the same files and the same signed `SHA256SUMS` as a stable release, and the desktop's feed files for the `nightly` channel.

**Android version codes get room for nightlies after 0.3.0.** Versions up to `0.3.0` keep the code they shipped with. From `0.3.1`:

```
major * 100,000,000 + minor * 1,000,000 + patch * 10,000 + stage
```

where the stage is 9,999 for a release, 9,000 + n for `-rc.n`, and for a nightly the days from 1 January 2026 to its date, plus one. Every code from `0.3.1` on is above `0.3.0`'s (30,099), so phones keep taking updates across the change.

## Consequences

- A release that isn't signed by a committed key installs nowhere: not by `install.sh`, not by a server, not by an app. A lost key means every installed copy refuses new releases until it is updated by hand with one that embeds a new key, so the owner keeps an offline backup. A leaked key is rotated by a release, signed with the old key, that embeds only the new one. For that release the old key is moved to `release-keys/retiring/`, which `sign` accepts and nothing embeds ([Releasing: if the key leaks](../operations/releasing.md#if-the-key-leaks)).
- `install.sh` needs OpenSSL 3, the first version whose `pkeyutl` verifies Ed25519 over raw input. It refuses without it, with the fix, and never installs unchecked.
- The scheduled nightly runs on `main`, so `release-signing` and `android-signing` admit `main` as well as `v*` tags. A change merged to `main` can therefore reach both keys, as a `v*` tag pushed by an admin can.
- The nightly creates and deletes its own tags with the workflow's token, which any workflow on any branch also holds. Its tags are therefore outside `v*`, where only admins may create a tag, and are unprotected: GitHub refuses the GitHub Actions app as a ruleset's bypass actor on a user-owned repository, so no ruleset could leave them to the nightly alone. A nightly tag reaches no signing environment, so a nightly's integrity rests on its signature alone. With a `v` before its version, the nightly would need that token to create `v*` tags, which the signing environments admit, and so would every branch's workflow. electron-updater takes a bare-version tag as it takes a `v` tag, and rejects one with a `/`.
- Version limits from `0.3.1`: a major up to 20, a minor and a patch up to 99, a release candidate up to `rc.98`, and nightlies dated from 2026-01-01 to 2050-08-21 (stage up to 8,999). The stage leaves a nightly's run out, so a day has one nightly at most: the nightly workflow skips a day that already has one, and no two nightlies share a version code.

## Rejected

**Sigstore keyless signing (cosign).** It needs no key to keep, but verifying it needs `sigstore-js` in the server and the network to reach its trust root, and `install.sh` couldn't verify it in plain shell.

**minisign or GPG.** Both need a parser or a keyring for a check that Node and OpenSSL already do with raw Ed25519. minisign signs with the same primitive, so moving to it later changes the format, not the trust.

**The nightly's run number as its Android stage.** It grows strictly, but it starts over when the workflow is renamed or recreated, and then a nightly would get a lower code than the one before it. The date never goes back.

**A date in the version without a run number.** A day has one published nightly, but a run that fails leaves a draft under its version, and a second try that day would take the same version, and that draft, made on the commit the failed run built.
