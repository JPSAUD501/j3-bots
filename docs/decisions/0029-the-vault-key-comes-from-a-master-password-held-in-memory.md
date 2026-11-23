# 0029: The vault's key comes from a master password, held in memory

**Status:** Proposed

## Context

Bots that use websites need the operator's logins for them. Until now the only way to give one was the engine's secret request. It hands one value to one command, keeps nothing, and the operator types it again the next time. Pasting a login into a conversation would put it in the transcript, the model's context and every backup of the database.

J3 Bots therefore keeps logins on the server: the **vault**. Whatever it seals them under decides who can read them. The server runs unattended as the operator's user, and every bot's shell runs as that same user ([Security: trust model](../architecture/security.md#trust-model)). A key the server can read without the operator is a key a bot's shell can read too.

## Decision

**The vault's key comes from a master password the operator types, and the server holds it in memory only.**

- **Nothing on disk opens it.** scrypt derives a key-encryption key from the password. That key wraps a random data key, and the data key seals each value with AES-256-GCM, bound to its record and field. The disk holds the salt, the parameters and the wrapped data key, never a key ([Server: the vault](../architecture/server.md#the-vault)).
- **Locked at every start.** The server starts with the vault locked. Any paired client can unlock it, and it stays unlocked until a client presses Lock now or the server stops. There is no automatic lock: the operator decides when it closes.
- **A file of its own, outside the snapshots.** The vault is `<J3_HOME>/vault/vault.sqlite`, with migrations of its own that only move forward. An update never copies it and a rollback never puts an older one back ([decision 0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md)). A release that finds a newer vault leaves it alone and says so.
- **Wrong passwords make unlocking wait.** After five wrong passwords in a row, each further one doubles the wait, from 30 seconds up to an hour. The vault's file keeps the count and the wait, so a restart does not end them; a day with no wrong password starts the count over.
- **Connectors share it.** The secrets connectors need are a second kind of record in the same vault, under the same key. A locked vault therefore stops every connector that needs a secret until a client unlocks it.
- **No way back without the password.** There is no recovery key and no reset. Setup, onboarding and every password change say that saved logins cannot be recovered without the password.

## What it costs

- **Someone has to unlock it after every restart.** After a reboot, nothing a bot does can use the vault until the operator unlocks it from a client. A routine that runs overnight finds its connectors unavailable.
- **A forgotten password loses everything in the vault.** The operator saves each login again and signs in to each connector again.
- **It protects the file, not the running server.** While the vault is unlocked, the key is in the server's memory, and anything that can act as the server's user is inside the boundary ([Security: the vault](../architecture/security.md#the-vault)).
- **A backup of the home does not bring logins back** unless the master password is known when the backup is restored.

## What was rejected

- **A key file in the home.** The vault would open itself after a restart. But the file would sit beside the store: readable by every process of the server's user, a bot's shell included, and copied by every backup of the home. The vault would then add nothing over the database's private folder.
- **The system's keyring.** A headless server, such as a Raspberry Pi or a container, often has none. Where one exists, it opens for any process of the same user, which is the same exposure as a key file.
- **A biometric or device-held key.** A paired phone would have to be reachable for anything to use the vault, and losing the phone would lose the vault. This needs its own design and is left for later.
- **An automatic lock after some idle time.** Routines and connectors would stop at times the operator never chose. Lock now does the same when the operator wants it.
- **Logins in J3 Bots' database.** They would be in every update snapshot, and one `sqlite3` away from a bot's shell.
