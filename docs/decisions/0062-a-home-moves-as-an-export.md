# 0062: A home moves as an export: secrets sealed under a passphrase, sessions left behind

**Status:** Accepted.

## Context

A person who starts with bots on their own computer, in the desktop app's local mode, needs a way to move them to an always-on server. A backup of the data directory does not move them: the database names each bot's workspace by its path, the engine's folder holds a credential and a provider key that belong to that machine, the paired devices hold tokens for that server, and the secrets' key file opens the secrets for whoever has it.

Whatever the move writes, a later release has to read. And what it does with the secrets and the engine's sessions decides what a person can lose in it.

## Decision

**`j3-bots export` writes one archive, and `j3-bots import` puts it in another home.** Both run with no server on the home and hold its `server.lock`. [Server: moving to another server](../architecture/server.md#moving-to-another-server) describes them.

- **The archive is the server's own.** It is a gzipped tar written and read in process, so it needs no system `tar` and works the same on Windows. Its first file, `manifest.json`, names the format (`j3-bots-export-1`), the release, its protocol, the database's and the secrets' last migrations, and each file with its size and SHA-256. An import refuses a format it does not read and an archive a newer release wrote. It migrates an older one.
- **What belongs to a machine stays there.** The archive holds the database, the bots' memory, skills and files, the shared memory and skills, the attachments and the secrets. It leaves out the configuration, the engine's folder, the providers' sign-ins, the update snapshots and the secrets' key file. It also deletes the paired devices, their push registrations and deliveries from the copy, so every device pairs with the new server, and the webhooks' secrets, which are credentials: the import gives each webhook a new one. The command receipts go too, since they answer a device's retry on the old server and a webhook's holds its address.
- **The secrets travel sealed under a passphrase of the export's own.** The export opens each value under the home's key and seals it again, in a copy, under a key that scrypt derives from that passphrase. It uses a fresh salt and seals with AES-256-GCM, binding each value to its record and field, as the secrets are sealed at home. The passphrase is typed twice, and it cannot be recovered. The import seals each value again under the key of the home it lands in. No value is ever in the archive unsealed.
- **Sessions do not move.** The import records the sessions as belonging to an engine the new home does not have. The new server's first start loses every one of them, and each bot goes on in a new session with its conversation and memory ([Another engine](../architecture/server.md#another-engine)). The import never talks to an engine.
- **A home that holds anything the import would delete is replaced only when asked** (`--replace`): bots, secrets, or files a person kept, as a deleted bot's. An import that stops while it puts the archive in place leaves a mark naming the archive. The server refuses to start until the import of that archive is run again, or another one with `--replace`.
- **The desktop app moves the bots it runs with the same command.** Settings runs the server's own `export` on their home, from the release that would start next, with the passphrase on its stdin, and reads its report (`--report`) to say what it left out. Once the file is written the server there stays stopped, and the app says so, until the operator runs the bots there again or deletes their data: the bots never run in two places unasked. The app has no import: the bots move to a server.
- **The archive is checked as data from outside.** Its reader takes regular files only, each named, sized and hashed by the manifest; the database's bot ids and attachment paths are checked before they become paths in the home.

## Costs

- The archive's format is now a promise. A later release keeps reading `j3-bots-export-1`, or says plainly that it does not.
- A forgotten passphrase loses the secrets in that export, and nothing recovers them. The export still holds everything else.
- The bots lose whatever their sessions held that is not in their memory or conversation, as on any lost session. Every device pairs again, providers sign in again on a server that has none, and every service that calls a webhook is given its new address.
- The source keeps its data. Until the operator deletes it, the bots could run in two places with copies that drift apart. The desktop app keeps its server stopped after an export for that reason, and starting it again is the operator's choice.

## Rejected

- **Copying the data directory.** It carries the engine's credential, the provider key and the devices' tokens to a machine that should not have them. And it breaks on a different path.
- **Carrying the secrets' key file in the archive.** The archive would open every secret for whoever has it. A passphrase keeps the export as safe as the passphrase, with the file kept apart.
- **Leaving the secrets out.** Moving would cost every saved login and connector secret, and the export is the only way they leave a machine: no update snapshot copies them ([decision 0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md)).
- **Moving the engine's sessions.** They are the engine's, under its keys and its projects. A fresh engine has none of them, and J3 Bots does not reach into the engine's files ([decision 0001](0001-t3-code-as-unmodified-engine.md)).
- **The system's `tar`.** Windows does not always have one that reads gzip, and each one names, links and refuses files in its own way.
