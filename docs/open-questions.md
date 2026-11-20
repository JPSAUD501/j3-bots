# Open questions

Each question names what is unknown, why it matters, and what would settle it. Questions are removed when answered; the answer goes into the document it affects.

## 1. Does a bot's manner hold on top of the host's prompts?

The harness has its own coding-oriented system prompt and T3 Code adds about 6 KB about its orchestration tools. J3 Bots asks the model to do something the host does not expect: treat reply text as private and speak only through a tool, in one or two sentences.

In a single direct conflict, J3 Bots' instruction beat T3 Code's on both harnesses and from every layer that carries it ([Prompt architecture](prompts/architecture.md#how-each-layer-reaches-each-harness)). That says the layers rank high enough. It does not say the manner holds over many turns, or on Codex after a compaction, when T3 Code injects its text again.

**Matters because** the product's character depends on it. **Settled by** the first behavior evals in M0, per harness and model, including a forty-turn run and a run across a compaction.

## 2. How do provider sign-ins work with J3-owned provider homes?

Giving the engine's Claude and Codex instances their own home directories keeps bots clear of the operator's personal coding setup. It also means the subscription sign-in stored in the usual home is not there. A home reached through an API endpoint needs only the instance's environment and a few lines of configuration ([Engine: provisioning](architecture/engine.md#provisioning)), but a typical user signs in with the provider's own login, and the engine has no sign-in flow for these providers.

**Matters because** it decides the install experience. **Options:** run the provider's own login against the J3-owned home (`CLAUDE_CONFIG_DIR=<home> claude auth login`, `CODEX_HOME=<home> codex login`), driven by the installer; share only the credential file; use the operator's home and accept their global instructions. **Settled by** testing each option on Claude Code and Codex with a subscription account, including what happens when the token refreshes.

## 3. Should J3 Bots run as a dedicated system user?

A bot in full access can read anything its user can, including SSH keys that reach other machines. A dedicated user with no keys and no sudo bounds the damage. It also complicates installation, file sharing with the operator, and provider sign-in.

**Settled by** deciding whether this is a recommendation in the install guide or the default the installer sets up.

## 4. How do push notifications reach the mobile app?

A self-hosted server cannot send to Apple's and Google's push services without credentials tied to the published app.

**Options:** a small push relay run by the project that holds the app's credentials and forwards opaque wake-ups; Expo's push service, which plays that role for Expo apps; operators building the app with their own credentials; on Android, UnifiedPush with no Google dependency.

**Matters because** it is the only place where a hosted component enters the path. **Constraint:** whatever is chosen must work with previews turned off, carrying no message text.

## 5. How are contributions licensed, and can the mobile app ship through app stores?

The license is AGPL-3.0-or-later ([decision 0008](decisions/0008-license.md)). Apple's App Store terms have conflicted with GPL-family licenses in the past: the copyright holders can still distribute their own work there, but only if they hold the rights to all of it. That makes the terms for outside contributions (a contributor agreement or a sign-off with an added permission) something to settle before the first outside contribution is merged.

## 6. Is the name free to use?

The product is called J3 Bots. Before going public it needs a check for conflicting marks and for available package, domain and store names. One thing to weigh in that check: the name's shape is close to "T3", the brand of the engine's authors, and J3 Bots must not read as their product.

## 7. How many bots does a host and a subscription sustain?

On a laptop, a turn under the engine costs about 59,000 input tokens per model call on Claude Code and 15,000 on Codex before J3 Bots adds anything, mostly cache reads while the session is warm; a loaded Claude Code session holds about 230 MB, and the engine about 470 MB ([Engine: footprint](architecture/engine.md#footprint)). Still unknown: the same numbers on the Raspberry Pi the product targets, with J3 Bots' base prompt, pinned memory and tools in place; and how a subscription's allowance counts cached input.

**Matters because** it sets how many bots and routines a host and a subscription can sustain, and therefore the default budgets and the concurrency limit. **Settled by** repeating the measurement on the target host with the first build, and by watching allowance on a subscription account.

## 8. When should a main session rotate, and what does the digest contain?

Rotation trades continuity for cost. The thresholds (runs, tokens, age) and the digest's size and content need real conversations to tune.

## 9. How does an operator configure providers without T3 Code's interface?

For M1 the plan is to print a pairing link to the engine's own web interface. J3 Bots' settings need their own provider screen eventually: which providers are signed in, which models each bot may use.

## 10. Is non-streamed speech good enough?

A message sent through `say` arrives whole. The operator sees the avatar working and then a complete message, not text appearing as it is generated. For one or two sentences this is probably right; for long answers it may feel slow.

**Settled by** using M1.

## 11. Which harnesses beyond Claude Code and Codex are worth supporting?

Agents connected through ACP have no system-prompt field. T3 Code sends each turn to them as its own text followed by the dispatched message, so J3 Bots' base prompt would have to ride in instruction files or in every envelope, which behaves differently after compaction.
