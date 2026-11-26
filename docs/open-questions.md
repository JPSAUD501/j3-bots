# Open questions

Each question names what is unknown, why it matters, and what would settle it. Questions are removed when answered; the answer goes into the document it affects.

## 1. Does a bot's manner hold on top of the host's prompts?

The harness has its own coding-oriented system prompt and T3 Code adds about 6 KB about its orchestration tools. J3 Bots asks the model to do something the host does not expect: treat reply text as private and speak only through a tool, in one or two sentences.

In a single direct conflict, J3 Bots' instruction beat T3 Code's on both harnesses and from every layer that carries it ([Prompt architecture](prompts/architecture.md#how-each-layer-reaches-each-harness)). That says the layers rank high enough. It does not say the manner holds over many turns, or on Codex after a compaction, when T3 Code injects its text again.

**Matters because** the product's character depends on it. **Settled by** the first behavior evals in M0, per harness and model, including a forty-turn run and a run across a compaction.

## 2. Does a subscription sign-in work inside a J3-owned provider home?

Giving the engine's Claude Code and Codex instances their own homes keeps bots clear of the operator's personal coding setup, and of the subscription sign-in stored there. J3 Bots reaches the models through a provider connection: an endpoint such as CLIProxyAPI in front of the operator's subscriptions, set with `j3-bots provider connect`, which works with no sign-in in the homes ([Engine: reaching the models](architecture/engine.md#reaching-the-models)). An operator without such an endpoint signs each harness in inside its J3-owned home with `j3-bots provider login <claude-code|codex>`, which runs the harness's own sign-in there. No run has signed a harness in that way yet. When a connection is also stored, the configuration J3 Bots writes points each harness at the connection; whether the harness then never uses the sign-in is unchecked too. Claude Code's documentation says a subscription sign-in ends on a date that use does not extend, so bots on one would stop until the operator signs in again.

**Matters because** it decides whether an operator who runs no proxy can use J3 Bots at all, and what they must do to keep bots running. **Settled by** one run as a throwaway user on a test machine, removed after with everything it signed in: `j3-bots provider login claude-code` and `j3-bots provider login codex` with a subscription account each, a Claude Code bot and a Codex bot running turns on them for longer than an access token lives, then a provider connection stored beside the sign-ins, recording which credential each harness's requests use. It needs the owner at a browser for both sign-ins.

## 3. Should J3 Bots run as a dedicated system user?

A bot in full access can read anything its user can, including SSH keys that reach other machines. A dedicated user with no keys and no sudo bounds the damage. It also complicates installation, file sharing with the operator, and provider sign-in.

**Settled by** deciding whether this is a recommendation in the install guide or the default the installer sets up.

## 4. How do push notifications reach the mobile app?

A self-hosted server cannot send to Apple's and Google's push services without credentials tied to the published app.

**Options:** a small push relay run by the project that holds the app's credentials and forwards opaque wake-ups; Expo's push service, which plays that role for Expo apps; operators building the app with their own credentials; on Android, UnifiedPush with no Google dependency.

**Matters because** it is the only place where a hosted component enters the path. **Constraint:** whatever is chosen must work with previews turned off, carrying no message text.

**Recommended:** Expo's push service, behind an interface any of the others can replace ([decision 0014](decisions/0014-push-goes-through-a-push-sender.md), proposed). The server sends through it, and the app registers for it.

**Where it stands.** A build turns push on only with an Expo project and a Firebase configuration ([Clients: mobile](architecture/clients.md#mobile)). The project has neither, by the owner's decision, so no build turns push on, the 0.1.0 APK included, and push has not been tried on a device. **Settled by** the owner deciding whether the project holds those credentials, or another option above replaces Expo, and then one push proven on a phone.

## 5. How many bots does a host and a subscription sustain?

On a laptop, a turn under the engine costs about 59,000 input tokens per model call on Claude Code and 15,000 on Codex before J3 Bots adds anything, mostly cache reads while the session is warm; a loaded Claude Code session holds about 230 MB, and the engine about 470 MB ([Engine: footprint](architecture/engine.md#footprint)). Still unknown: the same numbers on the Raspberry Pi the product targets, with J3 Bots' base prompt, pinned memory and tools in place; and how a subscription's allowance counts cached input.

**Matters because** it sets how many bots and routines a host and a subscription can sustain, and therefore the default budgets and the concurrency limit. **Settled by** repeating the measurement on the target host with the first build, and by watching allowance on a subscription account.

## 6. When should a main session rotate, and what does the digest contain?

The server rotates a main session once its working context reaches three quarters of the point where the harness would compact it, or after 200 turns where the provider gives no measure, and carries a digest of the last delivered messages, up to 60 of them and 6,000 characters ([Server: sessions](architecture/server.md#sessions), [decision 0074](decisions/0074-a-session-rotates-by-how-full-its-context-is.md)). The share, the run count and the digest's size are guesses. Rotation trades continuity for cost, and the digest may need the bot's own summary rather than the raw messages. A fresh start carries no digest, as the client promises: the new session starts from the bot's memory files alone.

**Settled by** real conversations: how much a turn adds to a session's context on each provider, how often a turn still runs into the harness's compaction, and whether bots pick up well after a rotation.

## 7. How does an operator configure providers without T3 Code's interface?

On the host, `j3-bots provider connect` sets the endpoint and its key, `j3-bots provider login` signs a harness in, and `j3-bots doctor` shows what the engine reports for each provider. The desktop app, when it runs the bots on its own computer, does the first two itself: a harness's sign-in through the operator's browser, and an endpoint whose key goes only to the server ([Engine: sign-in from the app](architecture/engine.md#sign-in-from-the-app)). Still open: setting the providers up from a client on another machine, where a harness's sign-in page cannot return to the server, which models each bot may use, and removing a stored connection.

## 8. Is non-streamed speech good enough?

A message sent through `say` arrives whole. The operator sees the avatar working and then a complete message, not text appearing as it is generated. For one or two sentences this is probably right; for long answers it may feel slow.

**Settled by** using M1.

## 9. Which harnesses beyond Claude Code and Codex are worth supporting?

Agents connected through ACP have no system-prompt field. T3 Code sends each turn to them as its own text followed by the dispatched message, so J3 Bots' base prompt would have to ride in instruction files or in every envelope, which behaves differently after compaction.

## 10. Is the name free to use?

The name is chosen: J3 Bots ([Concepts: Names](product/concepts.md#names)). Whether it is free to use is not checked yet: conflicting trademarks, and the npm scope, GitHub name, domain and app-store names it needs.

**Settled by** those checks, which are the owner's to make.

## 11. Does a fill hold on the pinned engine as the source reads?

The server fills a saved login through the engine's viewer channel ([Server: filling a login](architecture/server.md#filling-a-login)). Its tests run against the in-memory browser, so these are **Assumed** until seen on the pinned engine with a real harness:

- the engine queues a viewer's input messages in the order they arrived, so a `probe` answered means the typing before it ran;
- a form submission answered with no new document shows as loading, then loaded again at the same address, or stays loading; either way the fill clears the field;
- a password field shows dots in a snapshot, as on screen;
- after a password the page stays on, one Backspace per character empties the field, because typing leaves the caret at the end.

**Matters because** each is part of what keeps a filled value from the bot ([Security: filling a login](architecture/security.md#filling-a-login)). **Settled by** a real-engine conformance case with the scripted agent: a local sign-in page, a fill of each field, the page's received value and the field after a failed sign-in.
