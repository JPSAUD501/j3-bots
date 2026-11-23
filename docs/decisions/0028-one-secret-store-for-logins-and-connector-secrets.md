# 0028: One secret store for logins and connector secrets

**Status:** Proposed

## Context

J3 Bots keeps two kinds of secret it did not keep before.

- **Logins** the operator saves for sites a bot uses in its browser. They live in the vault: its own database, `<J3_HOME>/vault/vault.sqlite`, sealed under a key that comes from a master password the server holds in memory only. After every start the vault is locked until a client unlocks it, and a forgotten password loses it. The vault is outside the snapshot an update keeps to roll back to ([decision 0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md)), with a schema version of its own that only moves forward.
- **Connector secrets**, which the server holds so that no bot does ([decision 0026](0026-a-bot-uses-connected-services-through-j3-bots.md)): an OAuth client's secret, access and refresh tokens, the values of headers a connector is called with, the environment of a server started by command, and the address or command arguments the operator typed, either of which can carry a key.

The connector secrets could have a store of their own, with a key of its own, or sit in J3 Bots' database.

## Decision

**Connector secrets are a second kind of record in the vault**, sealed as a login is and under the same key.

- **One store, one key, one way to move it forward.** A connector's record holds its OAuth client and tokens, its headers and its environment, and the address or arguments the operator typed, every value sealed apart (AES-256-GCM with the record's id and the field's name as associated data), under the data key the master password unwraps. It moves with the vault's own schema version, outside the rollback snapshot, and an export re-encrypts it under the passphrase typed for the export, as it does logins.
- **Nothing else holds them.** J3 Bots' database keeps a connector's description (with the origin it is reached at or the program it starts, and a gallery entry's public address), its grant, its accepted tools and its status, never a value of its secrets. They reach a request to the connector when the server makes it, and are never cached in plain text beyond that request.
- **A locked vault stops the connectors that need it.** While the vault is locked, as after every start until a client unlocks it, a connector with a secret is `vault-locked`: bots get none of its tools, a bot that calls one gets a result saying it is unavailable, and tokens are not renewed. A connector that needs no secret works locked. The clients show the state with Unlock beside it.
- **A connector that needs a secret needs a vault.** Adding one before the operator has set a master password fails, and the client offers the vault's setup there.

## What it costs

- **After a restart, connectors wait for the operator.** A routine that runs overnight after a reboot finds its connectors unavailable until someone unlocks the vault from a client. That is the price of a key the disk does not hold, and the owner chose it for logins; connectors share it rather than keeping their tokens under a weaker key.
- **The same trust boundary as the logins.** The key is in the server's memory while the vault is unlocked, and any process of the server's user, a bot's shell in full access included, can reach that process ([Security: trust model](../architecture/security.md#trust-model)). The store keeps tokens out of prompts, transcripts, harness configuration, logs and backups in the clear; it is not a wall against a misled bot with a shell.
- A connector's secrets are lost with a forgotten master password, as the logins are. The operator signs in to each connector again after setting a new vault up.

## What was rejected

- **A store of its own for connectors.** A second key means a second password to type after every start, or a key file on the disk beside the store, which every process of the server's user can read and which a snapshot would copy.
- **Tokens in J3 Bots' database.** In the clear, or under a key the server keeps on disk, they would be one `sqlite3` away from any process of the server's user, and inside every update's snapshot.
- **The harness's own token store.** The tokens would be in the instance's home, which the bot's shell reads ([decision 0026](0026-a-bot-uses-connected-services-through-j3-bots.md)).
