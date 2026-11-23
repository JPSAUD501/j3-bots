# 0032: Updates are served outside the protocol, and offer only a signed, newer release

**Status:** Proposed

## Context

A client and a server compare `PROTOCOL_VERSION` for equality, and a mismatch closes the socket for good: no RPC at all ([Protocol compatibility](../architecture/clients.md#protocol-compatibility)). That is exactly when an update matters, because one side is behind. A release that raises the protocol locks every older client out of the newer server, and every newer client out of an older one, and the installed Android app does not update itself.

Until now, only the operator could update a server, by running `j3-bots update` on its machine ([decision 0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md)). To update it from a client, the client must reach it whatever protocol either side speaks. And every paired device holds the operator's authority, so the question is not who may ask, but what the server may be made to install.

## Decision

**The update surface is plain HTTP routes with a version of their own, beside the protocol, and they offer only a release that verifies, newer than the running one, on the server's channel.**

- **Outside the protocol.** The routes are `/api/update/v1/…` (`UPDATE_HTTP_PATHS`, `UPDATE_API_VERSION` 1). A change to `PROTOCOL_VERSION` never touches them, and their shapes are frozen: a later version adds paths. `ServerInfo` gains an optional `updateApi`, which `GET /api/server` answers before any pairing or socket, so a client of any protocol learns whether the server has them. No bump is needed: an older client drops the field.
- **Open sets.** Every set in what a client receives (the update's state, its reasons, its outcome, the channel) decodes a value the client does not know as `unknown`, so adding one never needs a new route version.
- **The device token.** Each route takes a paired device's token. There is no new role: whoever holds a device token is the operator.
- **Only a signed release.** The server offers a release only once its `SHA256SUMS` carries the release key's Ed25519 signature and names that release, and installs only what matches that list. The signature is checked before any digest in the list is read.
- **Only a newer release, on the channel.** A server follows one channel, `stable` or `nightly`, set per server, starting as the channel of the release it was installed from. It is offered the newest release of its channel, and only when that release sorts after the version it runs. Nothing is ever a downgrade, so a server moved from nightly to stable waits for a stable release newer than its nightly, and says so.
- **One exact version.** A client asks for exactly the version the status offers, never a tag such as `latest`, and the server refuses any other before it downloads anything.
- **One verifier.** The order of versions, the channel rules, the release key and the check of `SHA256SUMS` are one package, `@j3-bots/release`. Its core imports nothing from Node, so the server, the desktop app and the Android app run the same checks against the same test vectors. Each platform supplies its own Ed25519 check and file hash.

## What it costs

- A second versioned surface to keep frozen beside the protocol.
- The key is a secret to keep. Lose it, and every installed server refuses new releases until it is updated by hand with a release that carries a new key. So the key is backed up offline, and a new key is added to `RELEASE_KEYS` a release before the old one stops signing.
- A server polls GitHub's API without a token, under its limit of 60 requests an hour per address. Each check is conditional, and checks are hours apart.
- A release older than the first signed one cannot be verified, so the first update to a signed release is made by hand.

## What was rejected

- **Riding `PROTOCOL_VERSION`.** The update routes would then vanish exactly when the versions differ.
- **An owner role for updates.** Every paired device is the operator's, and a bot that already runs as the server's user could run `j3-bots update` itself. A role would split one person's devices without stopping anything. What protects the server is what may be installed.
- **Trusting `SHA256SUMS` from the same place as the download**, as before. That proves the download was not damaged, not that the project published it.
- **Sigstore keyless signing.** It needs no key to keep, but a Pi would need network access to its trust root and a large library to verify, and `install.sh` could not check it with plain OpenSSL.
- **Letting a client choose the version.** One version, the newest verified one, is simpler to gate than any version a client names.
