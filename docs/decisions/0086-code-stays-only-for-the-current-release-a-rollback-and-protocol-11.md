# 0086: Code stays only for the current release, a rollback to the one before, and the clients of its protocol

**Status:** Accepted.

## Context

J3 Bots shipped eleven minor releases in a week. Each one left something behind for the one before it: a reader for a file an older release wrote, a fallback for a server that lacked a request, a comment that told how protocol 7 or the vault became what they are now, a string whose screen was replaced. Read today, that code looks as if it still had a job, and the next change has to work around it. The owner asked for nothing legacy to stay.

Deciding what is legacy needs a line that holds release after release, not a judgment made file by file.

## Decision

**Code stays only if one of three holds. Everything else goes.**

- **(a) The current release uses it.** A path some caller reaches, a setting something reads, a string a screen shows.
- **(b) A rollback to the previous minor release needs it.** An update keeps a snapshot to roll back to ([decision 0016](0016-an-update-keeps-a-snapshot-to-roll-back-to.md)), so the previous release's data and clients must still work: for 0.12, those of 0.11. Data a home of the previous release can still hold counts, whichever release wrote it: an entry, a command receipt or a connector's record is kept for as long as the home is, so the reader for its oldest shape stays. A file the server rebuilds when it cannot read it, as the release feed file, is a cache, not such data. Builds before 0.1.0-rc.1, the first one published, were never released, so what only they wrote is not either.
- **(c) Clients still on the current protocol need it.** Clients compare the protocol version for equality, so the peers a release meets are those of its protocol: at protocol 11, the releases from 0.9.0 on. A field one of them may leave out stays optional, and a request one of them calls stays answered.

**What goes:** dead code and paths no caller reaches; shims, readers and fallbacks for releases before the previous minor that no home of it can hold; names left behind by renames; flags that are always on or always off; settings nothing reads; and text, in comments and docs, that tells how something used to be instead of what it is. Docs are rewritten to say what holds now.

**What never goes, whatever its age:**

- **Migrations.** They run forward only, and a home skipping releases runs every one it missed, so they stay as they were written.
- **The vendored T3 Code contracts** (`packages/engine-t3/vendor`): an upstream copy, kept whole.
- **The frozen admin status samples**, which pin the one reply two releases must both read across an update and a rollback ([decision 0015](0015-a-release-is-a-self-contained-archive.md)).
- **Decision records and release notes**, which are history by design ([Decision records](README.md)).
- **The contract's shape within a protocol.** A field made required needs a protocol bump ([Clients: protocol compatibility](../architecture/clients.md#protocol-compatibility)), even when every server of the protocol already sends it, so a field's optionality and its decoding default stay until the protocol changes. What the client does without the field stays with it. So does a value a server of the protocol sends, or a file a supported release wrote holds: it stays readable after this release stops producing it.

**What changes what someone sees or does is the owner's to decide.** When dropping a path would change a screen, a flow or what happens to someone's data, even for a state only an old home can reach, it is not removed on this rule alone: the owner decides, and the decision is written here.

**Data a release no longer reads is refused, never destroyed.** Where removing a reader leaves data a home may still hold, the release detects it, changes nothing, and says in one plain line what to do. A vault from before secrets that still holds logins is the case: the server refuses to start over one, as over a configuration it may not run on, and its line says to open it with 0.12 first. An update from 0.12 to such a home does not become ready, so it rolls back to 0.12, where the vault opens.

The first pass, for 0.13.0, removed the Android version code's formula for 0.3.0 and before, a settings receipt's and a shipped skill's fallbacks for builds before 0.1.0, a release feed file's default for 0.8, an engine credential's reading of a file without its scopes, two wording functions, eight strings and a design token nothing read, and the comments and docs that recounted protocols 1 to 10, the vault's name and releases from 0.1 to 0.8.

The owner then decided the paths that pass kept because removing them changes what someone sees or does:

- **The old vault's password path goes.** The owner's only home holds no unopened vault. The password form, `secrets.openOldVault` and its strings go, and no part of this release produces the `old-vault` state or the export's reason for it; the detection above stays. Both values stay readable, as the contract's shape does: a 0.12 server still sends the state, which this release's clients word by sending the operator to that server's own web app, and an archive or a desktop's settings from 0.12 may still carry the reason.
- **The server-update view for servers without update routes goes.** Every server since 0.3.1 has them; a 404 now reads as any answer outside the contract, not reached.
- **A desktop settings file without `mode` reads as no choice**, the first-run path, instead of as remote. Every desktop release since 0.3.0, where `mode` came in, writes the whole file, `mode` included, each time its window closes, quitting included, so every install that ran one since holds it.
- **`install.sh` no longer gives advice for releases before 0.3.1**, which it does not install.
- **Drafts and the outbox read only what released clients write.** A stored draft's mentions and an outbox message's labels, which every release writes, are required. Fitting a draft's file marks to its files stays: the current release needs it for files another window added.
- **The `handoff` notification kind goes**, with its strings: no server sends it since 0.5.0, as a teammate's message notifies no one. The Android app deletes the channel it made for it at start, so the system's settings stop listing it.
- **The AI sign-in state for a server that cannot sign in from the apps stays for now**: the rewrite of the AI sign-in screens replaces the files it lives in, and takes it out there.

## Costs

- **A home that skips releases may meet something its new release no longer reads.** Only files outside the database are exposed; the database has its migrations. A release feed file 0.8 wrote and nothing rewrote since is fetched again instead of read, losing the verdicts and the rate limit it kept: the release is checked again, and a refused check records the limit again.
- **A home with a vault no release opened stops at 0.12.** It runs this release only after 0.12 opens the vault; a home coming from 0.8 passes through 0.12 first. The release notes say so.
- **Optional fields every server sends stay optional.** A client keeps code for the field's absence that no server of its protocol triggers, until the next protocol bump takes it out.
- **The line moves with each minor release.** What (b) and (c) keep today becomes removable when the next minor ships or the protocol changes, so the inventory is a task of every minor release, not done once.

## Rejected

- **Keeping everything a skipped-release upgrade might need.** Every shim would stay forever, which is what the owner asked to end. The database is covered by migrations; the rest is small, and fetched or rebuilt again.
- **Making optional fields required within protocol 11.** Every protocol-11 server sends some of them, so no client would break today, but the contract's rule is that a narrower field needs a bump, and a rule kept only when convenient stops being one.
- **Keeping the old vault's password form.** It is the only way a home with an unopened vault gets its logins back, but no home the owner runs holds one, and 0.12 still opens it: the release that cannot is the one that refuses to start over it.
- **Reading a settings file without `mode` as remote while any old file might exist.** No release since 0.3.0 leaves one behind after its window closes once.
