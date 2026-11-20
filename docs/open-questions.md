# Open questions

Each question names what is unknown, why it matters, and what would settle it. Questions are removed when answered; the answer goes into the document it affects.

## 1. Does a bot's manner hold on top of the host's prompts?

The harness has its own coding-oriented system prompt and T3 Code adds 6 to 8 KB about its orchestration tools. J3 Bots asks the model to do something the host does not expect: treat reply text as private and speak only through a tool, in one or two sentences.

**Matters because** the product's character depends on it. **Settled by** the first behavior evals in M0, per harness and model, including a forty-turn run.

## 2. Does the tool bridge identify its caller on every supported harness?

The design relies on `T3CODE_THREAD_ID` reaching a stdio MCP server. In source, T3 Code sets it on the Claude process environment and per thread on each stdio MCP server Codex starts. Whether Claude Code passes its environment to stdio MCP servers it launches, and how J3 Bots' server is registered so that Codex counts it among the servers to tag, are untested.

**Settled by** running the bridge in M0. **Fallback:** a per-bot registration file in the workspace carrying the bot's identity, where the harness supports project-scoped MCP configuration.

## 3. How do provider sign-ins work with J3-owned provider homes?

Giving the engine's Claude and Codex instances their own home directories keeps bots clear of the operator's personal coding setup. It also means the subscription sign-in stored in the usual home is not there. The first deployment uses a local proxy with environment variables, which hides this problem; a typical user signs in with the provider's own login.

**Matters because** it decides the install experience. **Options:** sign in again inside the J3-owned home; share only the credential file; use the operator's home and accept their global instructions. **Settled by** testing each option on Claude Code and Codex.

## 4. Should J3 Bots run as a dedicated system user?

A bot in full access can read anything its user can, including SSH keys that reach other machines. A dedicated user with no keys and no sudo bounds the damage. It also complicates installation, file sharing with the operator, and provider sign-in.

**Settled by** deciding whether this is a recommendation in the install guide or the default the installer sets up.

## 5. How do push notifications reach the mobile app?

A self-hosted server cannot send to Apple's and Google's push services without credentials tied to the published app.

**Options:** a small push relay run by the project that holds the app's credentials and forwards opaque wake-ups; Expo's push service, which plays that role for Expo apps; operators building the app with their own credentials; on Android, UnifiedPush with no Google dependency.

**Matters because** it is the only place where a hosted component enters the path. **Constraint:** whatever is chosen must work with previews turned off, carrying no message text.

## 6. How are contributions licensed, and can the mobile app ship through app stores?

The license is AGPL-3.0-or-later ([decision 0008](decisions/0008-license.md)). Apple's App Store terms have conflicted with GPL-family licenses in the past: the copyright holders can still distribute their own work there, but only if they hold the rights to all of it. That makes the terms for outside contributions (a contributor agreement or a sign-off with an added permission) something to settle before the first outside contribution is merged.

## 7. Is the name free to use?

The product is called J3 Bots. Before going public it needs a check for conflicting marks and for available package, domain and store names. One thing to weigh in that check: the name's shape is close to "T3", the brand of the engine's authors, and J3 Bots must not read as their product.

## 8. How does the engine conformance suite run without spending allowance?

The suite needs an engine that completes turns deterministically. T3 Code has a replay provider for development and a provider-testing package with a fake CLI; whether either is usable against a release build is unknown.

**Option:** a small scripted agent that speaks the Agent Client Protocol, registered in the engine as a local-command provider. J3 Bots would own it and could script any turn, including approvals.

## 9. How much does a turn cost?

Each turn carries the harness's prompt, T3 Code's text, J3 Bots' base prompt, the bot's pinned memory and the tool lists. A bot that answers "ok" still pays for all of it, mitigated by prompt caching while the session is warm.

**Matters because** it sets how many bots and routines a subscription can sustain, and therefore the default budgets. **Settled by** measurement in M0.

## 10. When should a main session rotate, and what does the digest contain?

Rotation trades continuity for cost. The thresholds (runs, tokens, age) and the digest's size and content need real conversations to tune.

## 11. How does an operator configure providers without T3 Code's interface?

For M1 the plan is to print a pairing link to the engine's own web interface. J3 Bots' settings need their own provider screen eventually: which providers are signed in, which models each bot may use.

## 12. Is non-streamed speech good enough?

A message sent through `say` arrives whole. The operator sees the avatar working and then a complete message, not text appearing as it is generated. For one or two sentences this is probably right; for long answers it may feel slow.

**Settled by** using M1.

## 13. How are files a bot produces served to clients?

Bots write to their workspace on the host. Clients are elsewhere. The server needs an authenticated file route, size limits, and a decision about files outside the workspace.

## 14. Which harnesses beyond Claude Code and Codex are worth supporting?

Agents connected through ACP have no system-prompt field. Supporting them means carrying the whole base prompt in instruction files or in the first message, which behaves differently after compaction.
