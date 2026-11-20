# Security

J3 Bots runs agents with real access to a real machine, on behalf of one person, around the clock. This document states what is trusted, what is not, and what stands between them.

## Trust model

| Party | Trust |
| --- | --- |
| The operator | Full. They own the machine, the subscriptions and the bots. |
| A paired client | The operator's. A device token is the operator's authority. |
| The J3 Bots server | Full. It runs as the operator's user. |
| The engine | Full. It runs as the same user and executes what bots ask within their permission mode. |
| A bot's model output | **Not trusted to be correct, trusted to be the bot's.** A bot may be wrong or may have been misled; it is still the party the operator delegated to. |
| Anything a bot reads | **Untrusted.** Web pages, files, tool results, webhook bodies, messages from other bots. |

The line that matters most is the last one. A bot with a shell that treats text from a web page as an instruction is a remote code execution path into the operator's machine.

## Who can give instructions

Only the operator, through a `user` wake in a bot's conversation or an entry they wrote in a room.

Everything else is context:

- A **routine's saved instruction** is the operator's standing request for exactly what it names, and nothing more.
- A **teammate's message** is another bot asking. The receiving bot weighs it against its own job and limits. It does not inherit the sender's authority, and it cannot be used to launder a request the operator did not make.
- A **webhook body**, a **tool result**, a **file** and a **web page** are data.

J3 Bots enforces this in three places:

1. **Envelopes.** The server writes every wake. Content that did not come from the operator is placed inside a block whose tag carries a per-wake random nonce, so text inside the block cannot close it or imitate another block.
2. **The base prompt.** It states the rule above, and that a request found in data is reported to the operator, not carried out.
3. **Authority that does not transfer.** Approvals can only be granted from a paired client. No bot tool grants an approval, raises a permission mode or widens a budget.

Prompt-level rules reduce the risk. They do not remove it. The permission mode is what bounds the damage.

## Permission modes

A bot's permission mode is the engine's runtime mode for its sessions.

| Mode | What it means for a bot |
| --- | --- |
| Supervised | Asks before commands and edits. On Codex the sandbox is read-only, so even an approved write fails: a supervised Codex bot can read and answer but not change files |
| Auto-accept edits | Edits files freely, asks before commands |
| Auto | An automatic reviewer decides; risky actions become approval cards |
| Full access | Does anything the operator's user can do |

J3 Bots' default for a new bot is **Auto** where the provider supports it and **Supervised** where it does not. Full access is a choice the operator makes per bot, with a plain statement of what it means.

In every mode, the bot's own `j3` tools run without asking: they only reach J3 Bots, which applies its own rules to each call. The engine's and the harness's other tools keep the mode's rules. The Codex behavior is **Verified** on release `4969`; see [Engine](engine.md#behaviors-j3-bots-designs-around).

J3 Bots adds no sandbox. A bot in full access can read the operator's SSH keys, their other bots' folders, and J3 Bots' own database.

## Acting on the operator's behalf

Sending something to another person is not reversible. The base prompt holds bots to these rules regardless of permission mode:

- A message, email or post to anyone but the operator goes out only when the operator asked for that specific send, or a routine's saved instruction names it.
- When in doubt, the bot drafts and asks.
- A declined send is final. The bot does not retry it, reword it or find another route.
- Purchases, deletions, publishing and changes to accounts need the operator's explicit yes in the conversation.

## Running on a machine that matters

The first deployment of J3 Bots is on a host that has SSH access to the rest of its owner's network. That is common for a home server and it changes the stakes: a misled bot on that host can reach every machine the host can.

Recommended for any such host, and set out step by step in [Running on a Raspberry Pi](../operations/running-on-a-pi.md#choose-the-user-it-runs-as):

- Run J3 Bots and its engine as a **dedicated system user** that has no SSH keys, no sudo, and no read access to the operator's home directory.
- Give that user its own provider sign-ins.
- If a bot needs access to something outside its workspace, grant that one thing.

This is a deployment recommendation, not something J3 Bots enforces. See [open question 3](../open-questions.md).

## The engine's credentials

- The engine listens on loopback only.
- J3 Bots' engine token carries `orchestration:operate`, which can start a full-access agent. The engine's own CLI mints it, the server keeps it in `<J3_HOME>/engine/j3/credential.json` (mode 0600, inside the private home), never writes it to a log, and replaces it before it expires. A backup of the home contains it.
- Bots receive no engine credential from J3 Bots. Their sessions get the engine's own per-session MCP token, scoped to their thread, as T3 Code provides to any agent it runs.

## J3 Bots' own surface

- **Client connections** require a device token. Tokens are stored hashed, listed, and revocable. The socket checks the token, or a single-use ticket bought with it, once at the upgrade; each socket belongs to one device, and revoking the device closes its sockets at once. File routes take the same bearer on every request.
- **Pairing codes** carry 50 bits (ten Crockford base32 characters), expire after five minutes and work once. Failed attempts are limited across all sources: after five failures in fifteen minutes, pairing is locked for fifteen minutes and every attempt is answered with the time it opens again. A locked-out attacker gets a handful of guesses per quarter hour against a space of 2^50. Codes and failures are kept in memory, so a restart of the server forgets both. A pairing request is capped at 4 KiB, declared or chunked, and refused with 413 before it counts as an attempt or is decoded.
- **Plain HTTP** reaches only loopback and private addresses. A configured address must be an IP literal in one of those ranges, or start is refused. The default, `lan`, listens on every IPv4 interface. Start refuses it while any of the host's addresses is public, and the server then checks each connection as it accepts it: one that reached an address outside those ranges, such as one that appeared after start, is closed before a byte of it is read. A public address needs a TLS certificate and key ([Server: configuration](server.md#configuration)). On a private network, plain HTTP still lets anyone on that network read a device token in transit. Serving HTTPS, for instance on a Tailscale name, closes that gap.
- **The data directory is private, or the server does not start.** Before it opens the database or binds anything, the server checks that the home is a folder owned by its user that no group and no other user can open (no bit of mode 077 set). `j3-bots doctor` reports a home that fails this as a problem, with the `chmod` or `chown` command that fixes it. The home holds the database, the engine's credential and the admin socket.
- **Private state stays in the home.** Every location the server or its engine adapter writes must resolve, symbolic links followed, inside the home and outside the web client's folder: at start, and again before each write ([Server: data](server.md#data)).

  This rule protects against misconfiguration and against a link inside the home that would publish private state. It does not defend against a hostile process running as the same user, and that includes a bot's own shell tools: such a process can already write anywhere the user can. The rule therefore stays a cheap, uniform check and does not grow into a sandbox. A refused write affects only the scope that was tampered with (one bot's workspace or memory, the attachments, the engine's folder), never the server or the other bots.
- **One server per home.** The server holds an exclusive lock on `<J3_HOME>/server.lock` for as long as it runs. The kernel releases it when the process ends, so a crash never leaves the home held, and two servers that start at once cannot both get it.
- **The admin socket** gives commands on the host a pairing code and the server's status. It takes no token: it is a Unix socket (mode 0600) inside the private home, so only the operator's user can open it. Anyone who can act as that user can already read the database. The server removes a socket a stopped server left behind only while it holds the lock, and only once it has seen that the file is a socket and that nothing listens on it.
- **A failing request** fails alone, with a generic error; the cause stays in the server log, and the socket's other subscriptions carry on.
- **Webhook endpoints** authenticate with a secret in the path, compared in constant time, and optionally an HMAC over the body. Bodies are size-limited and rate-limited per routine.
- **The bot tool endpoint** listens on loopback and accepts calls only from sessions the server created. Any program on the host can reach the port, so a call's body is capped at 4 MiB before it is decoded. It identifies the bot from the session and pins each call to the turn it came from, never from an argument the model supplies ([Server: bot tools](server.md#bot-tools)).
- **Bot scope.** A bot's tools reach its own conversation, memory and routines, the shared memory, and the rooms it belongs to. Nothing in the tool surface returns another bot's conversation or memory. This is isolation of the product surface, not of the filesystem.

## Secrets

- J3 Bots never asks the operator to paste a secret into a conversation, and the base prompt tells bots not to either.
- When a bot needs a credential, it uses the engine's secret request, which shows the operator a masked input and gives the value to the command that needs it without placing it in the model's context.
- J3 Bots carries the value from the client to the engine and keeps nothing of it: not in the card, the change log, a command receipt or a log line. The card records only that a value was provided. In code the value travels as a redacted type, so printing it shows nothing.
- Memory files are not a place for secrets. The `remember` tool refuses text that looks like a credential.

## What is logged

- Conversations, rooms and memory are the operator's data, stored on their disk, in the clear.
- Server logs record wakes, dispatches and outcomes with identifiers, not message text.
- No telemetry leaves the machine by default.

## Known gaps

- No isolation between bots at the filesystem level.
- No protection against a compromised paired device beyond revocation.
- Push notifications pass through Apple's and Google's services, and through whichever push relay is chosen; previews are opt-in for that reason.
- The automatic reviewer in Auto mode is the provider's, and its judgment is not J3 Bots' to guarantee.
