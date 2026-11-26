# 0046: Secrets: the operator types, a bot uses a reference

**Status:** Accepted

## Context

Until 0.9.0 the operator's logins and the connectors' secrets were kept in the **vault**, sealed under a key that only the operator's master password unwrapped and that lived only in the server's memory ([decision 0029](0029-the-vault-key-comes-from-a-master-password-held-in-memory.md)). Each bot had a switch that let it fill logins ([decision 0037](0037-the-server-types-a-saved-login-into-the-bots-tab.md)).

What that cost:

- **Nothing worked after a restart.** Every start, an update's included, left the vault locked until someone typed the password on a paired device. A routine that ran overnight after a reboot found its connectors and its logins unavailable.
- **A password, a lock and a wait to learn.** Setup, unlock, Lock now, changing the password and a growing wait after wrong passwords each had a screen, on two clients, for a protection that did not hold against what the operator worries about most.
- **The protection was smaller than it looked.** Every bot's shell runs as the server's user ([Security: trust model](../architecture/security.md#trust-model)). While the vault was unlocked, as it had to be for anything to work, the key was in the memory of a process that user owns, and the admin channel and the debugger reach it. The password guarded a copy of the file, not the running server.
- **No way for a bot to ask.** A bot could raise a save-login card, but was not told when it was saved, and had no way to ask for a single value such as an API token.

The owner decided the vault's job: a safer way for the operator to type a secret, and for a bot to ask for one and use it without ever reading it. Always open: nothing to unlock after a restart.

## Decision

**The vault becomes Secrets. There is no master password: the data key is in a key file in a private folder of `<J3_HOME>`. A bot asks for a secret with `ask_for_secret` and only ever gets its reference, `secret:<name>`; the server puts the value where it is used.**

- **The key.** A random 256-bit data key in `<J3_HOME>/vault/key` (the file `0600`, its folder `0700`), outside every update snapshot, backup and export. Every value is still sealed apart with AES-256-GCM, bound to its record and field. A key check tells the right key from another: a missing or replaced key file leaves the secrets `unreadable` and changes nothing.
- **No lock.** Lock, unlock, Lock now, the wait after wrong passwords, setup, changing the password, the onboarding step and the connectors' "vault locked" status are gone.
- **One kind of secret.** A login (user name, password, optional one-time-code key, the exact origins it is for) or a single value. Each has a name, unique among the operator's secrets, which bots may use it (the bot that asked for it, more bots or every bot, as the operator sets), and where it was used last.
- **One tool to ask.** `ask_for_secret` shows the operator a card with masked fields in the bot's conversation, and a notification. The bot gets the reference and, when the card closes, a wake that says whether the secret was saved, declined or expired.
- **Use is the server's.** `fill_credential` types a login into the bot's tab ([decision 0037](0037-the-server-types-a-saved-login-into-the-bots-tab.md)) for any bot the login allows, with no per-bot switch beside the browser's. `${secret:<name>}` in a connector's header, argument or environment value is resolved by the server when it makes the request or starts the process, for the connector, while every bot it goes to may use the secret ([decision 0049](0049-the-bots-manage-mcp-servers-and-skills.md)); a reference that is missing, not allowed or lacks its value stops the connector with a status that names the secret. A connector's OAuth tokens are connector secrets, beside the operator's ([decision 0028](0028-one-secret-store-for-logins-and-connector-secrets.md), whose single store stays). The engine's `request_secret` is unchanged.
- **Moving an old vault over.** A vault sealed under a password waits for it one last time: the operator types it, the server writes the key file, names each login from its label and deletes the password's keyring. Until then the secrets cannot be read. Starting over with nothing is the operator's own step, deleting the folder ([Operating](../operations/operating.md#secrets)).

## What it costs

- **The key file is readable by any process of the server's user, a bot's shell included.** So is the secrets' file beside it. Secrets keep values out of prompts, transcripts, the harnesses' configuration, logs, snapshots and backups. They do not keep a value from a bot that was deliberately misled into reading `<J3_HOME>` with its shell. Before, the same bot could reach the unlocked key in the server's memory; the difference is that now it does not need the server running. The wall that would hold is a harness sandbox that denies reads of `<J3_HOME>`, a later item ([Security: secrets](../architecture/security.md#the-operators-secrets)).
- **A copy of the home with the key file opens the secrets.** A backup must keep the key file apart, or not at all ([Operating](../operations/operating.md#secrets)).
- **An old vault's operator types the password once more.** Until they do, connectors and logins wait, as they did after every start before.

## What was rejected

- **The operating system's keyring.** On Linux the Secret Service needs a D-Bus session and a keyring daemon that a headless server (a Raspberry Pi, a VPS) usually lacks, and unlocks with the desktop login, which such a server never has. Where it exists, any process of the same user reads it as easily as a file. It would add a platform dependency for no wall against a bot's shell.
- **Keeping the master password.** Its only gain was a stolen copy of the file without the server; it cost every restart, and did not protect the running server.
- **A key derived from something on the machine** (a machine id, a hardware key). Any process of the server's user reads the same inputs; it is a key file with extra steps, and breaks when the server moves.

## Supersedes

[Decision 0029](0029-the-vault-key-comes-from-a-master-password-held-in-memory.md), [decision 0028](0028-one-secret-store-for-logins-and-connector-secrets.md) as far as a locked vault and its password go, and the per-bot vault switch of [decision 0037](0037-the-server-types-a-saved-login-into-the-bots-tab.md).
