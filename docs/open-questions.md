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

**Where it stands.** A build turns push on only with an Expo project and a Firebase configuration ([Clients: mobile](architecture/clients.md#mobile)). The project has neither, by the owner's decision, so no build turns push on, the release APK included, and push has not been tried on a device. **Settled by** the owner deciding whether the project holds those credentials, or another option above replaces Expo, and then one push proven on a phone.

## 5. How many bots does a host and a subscription sustain?

On a laptop, a turn under the engine costs about 59,000 input tokens per model call on Claude Code and 15,000 on Codex before J3 Bots adds anything, mostly cache reads while the session is warm; a loaded Claude Code session holds about 230 MB, and the engine about 470 MB ([Engine: footprint](architecture/engine.md#footprint)). Still unknown: the same numbers on the Raspberry Pi the product targets, with J3 Bots' base prompt, pinned memory and tools in place; and how a subscription's allowance counts cached input.

**Matters because** it sets how many bots and routines a host and a subscription can sustain, and therefore the default budgets and the concurrency limit. **Settled by** repeating the measurement on the target host with the first build, and by watching allowance on a subscription account.

## 6. When should a main session rotate, and what does the digest contain?

The server rotates a main session after 200 turns and carries a digest of the last delivered messages, up to 60 of them and 6,000 characters ([Server: sessions](architecture/server.md#sessions)). Both numbers are guesses. The rotation bounds the engine thread's length, whose cost grows with every turn it holds ([decision 0003](decisions/0003-conversation-is-not-session.md)); it is not there to keep the model's context from filling up. That is the harness's job: Claude Code and Codex compact a full context on their own, and their summary keeps more of the work than the digest does, so the server doesn't rotate on how full the context is. The digest may need the bot's own summary rather than the raw messages. A fresh start carries no digest, as the client promises: the new session starts from the bot's memory files alone.

**Settled by** real conversations: how a session's cost grows with its turns on each provider, and whether bots pick up well after a rotation.

## 7. How does an operator configure providers without T3 Code's interface?

On the host, `j3-bots provider connect` sets the endpoint and its key, `j3-bots provider login` signs the first account of a harness in, and `j3-bots doctor` shows what the engine reports for each provider. The desktop app, when it runs the bots on its own computer, does the first two itself: an account's sign-in through the operator's browser, and an endpoint whose key goes only to the server ([Engine: sign-in from the app](architecture/engine.md#sign-in-from-the-app)). Settings → Providers, on every client, adds another Claude Code or Codex account, turns one off, sets its executable and launch arguments, and removes one the operator added ([decision 0108](decisions/0108-the-operator-sets-up-each-ai-account-and-picks-a-bots-model-as-in-t3-code.md)). Still open: signing an account in from a client on another machine, where a harness's sign-in page cannot return to the server, and removing a stored connection.

## 8. Is non-streamed speech good enough?

A message sent through `say` arrives whole. The operator sees the avatar working and then a complete message, not text appearing as it is generated. For one or two sentences this is probably right; for long answers it may feel slow.

**Settled by** using M1.

## 9. Which harnesses beyond Claude Code and Codex are worth supporting?

The engine also runs Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, Muse and fx (**Read** at `bc0f04d`), and J3 Bots offers none of them ([decision 0108](decisions/0108-the-operator-sets-up-each-ai-account-and-picks-a-bots-model-as-in-t3-code.md)). A bot speaks only through J3 Bots' tools, which J3 Bots gives Claude Code and Codex by writing its tool server into their homes; the engine gives an ACP agent only its own MCP server, and the other drivers take their tools from their own configuration, so on any of them a bot could think and not say a word. Each needs J3 Bots' tools written into its own configuration, and the base prompt delivered its own way, **Verified** against the real harness, before it is offered.

Agents connected through ACP have no system-prompt field. T3 Code sends each turn to them as its own text followed by the dispatched message, so J3 Bots' base prompt would have to ride in instruction files or in every envelope, which behaves differently after compaction.

## 10. Is the name free to use?

The name is chosen: J3 Bots ([Concepts: Names](product/concepts.md#names)). Whether it is free to use is not checked yet: conflicting trademarks, and the npm scope, GitHub name, domain and app-store names it needs.

**Settled by** those checks, which are the owner's to make.
