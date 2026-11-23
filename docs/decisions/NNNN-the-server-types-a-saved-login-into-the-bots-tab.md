# NNNN: The server types a saved login into the bot's tab, unattended

**Status:** Proposed

## Context

The vault keeps the operator's logins sealed on the server ([decision 0029](0029-the-vault-key-comes-from-a-master-password-held-in-memory.md)). A bot that works on websites must sign in with them, and must not hold the values: whatever reaches a bot's context reaches the model's provider, its transcript and anything a page can talk it into.

The engine lets a client that is not an agent act on a bot's tab in one way: as a viewer, which takes the tab, types where the page's focus is, and gives it back. While a viewer holds the tab, the bot's browser actions fail. The viewer channel does not say which element has focus, nor in which frame ([Engine: the bot's browser](../architecture/engine.md#the-bots-browser)). The engine's own agent tools could check both, but no agent tool takes a secret the agent does not hold.

The owner chose unattended fills, as other assistants offer them: nobody confirms each fill. The operator decides ahead of time, per bot and per login.

## Decision

**The server types a saved login into the bot's front tab when the bot asks, with every guard available today, and says plainly what remains.**

- **Allowed ahead of time.** A bot fills only while its vault access is on (off by default, a switch on its details next to the browser's) and its browser is on, only logins that allow it, and only for a call its running turn made, as the engine recorded it.
- **The bot never holds a value.** `fill_credential` names the login and the field; the answer is `filled`, `refused` with a reason, or `locked`, in a fixed shape. No value reaches a result, a work step, an entry or a log line.
- **The server checks the page, not the bot.** It takes the tab first, so the bot cannot move it, then reads the committed address from the engine. The origin must equal one of the login's exactly, in ASCII; plain `http:` is refused except on this computer, and a page still loading is refused. It reads the address again right before typing.
- **A password is always submitted** within the hold, and cleared if the page stays, so the bot never gets the tab back with a filled password field. The tab is given back only once the engine confirmed it ran the typing, since a release drops input still waiting.
- **A refusal is final** for that tab in that turn.
- **Claude Code bots lose the engine's `preview_evaluate`**, which could read a field's value back with a script. The engine runs one Claude Code instance for every bot, and the list of removed tools is the instance's, so every Claude Code bot loses it, with vault access or not. The other browser tools still read and act on pages.

## What it costs

- **The page decides where the value lands, within its origin.** J3 Bots cannot tell a password field from a comment box, nor the top frame from an embedded one of another origin. A page on the login's own origin can have the bot focus a field it reads. [Security: filling a login](../architecture/security.md#filling-a-login) lists the residual.
- **A user name and a one-time code are visible** on the page after they are typed, to the bot as to the operator.
- **Codex bots keep `preview_evaluate`.** Nothing in J3 Bots' reach removes one engine tool from Codex without risking the engine's own configuration (**Assumed**), so a Codex bot with vault access could read a field's value with a script.
- **Every Claude Code bot loses `preview_evaluate`**, also bots that never fill, because the setting cannot be per bot without a second instance.
- **No confirmation.** A bot a page has fooled fills on the login's own site without asking the operator first. Each fill is a step in the bot's work, after the fact.

## What was rejected

- **A card to confirm each fill.** The operator would be the check the channel lacks, but no work could run unattended, which was the point.
- **Waiting for the engine to check the field itself.** The clean path is a change to T3 Code: a `type` action that takes a one-use secret reference and checks the field's kind and its frame's origin. It is drafted in [Proposal: a typed secret in the engine's browser](../proposals/engine-browser-secret-input.md) and not sent. When a pinned release has it, the fill moves to it and this record is rewritten.
- **Handing the bot the value or a script.** Anything in the bot's context is in the provider's.
- **Driving the browser directly**, apart from the engine. The browser is the engine's; a second control path would bypass its rule that a held tab refuses the agent ([decision 0001](0001-t3-code-as-unmodified-engine.md)).
