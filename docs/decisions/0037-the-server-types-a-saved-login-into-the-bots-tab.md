# 0037: The server types a saved login into the bot's tab, unattended

**Status:** Accepted

## Context

The operator's logins are secrets the server keeps sealed ([decision 0046](0046-secrets-the-operator-types-a-bot-uses-a-reference.md)). A bot that works on websites must sign in with them, and must not hold the values: whatever reaches a bot's context reaches the model's provider, its transcript and anything a page can talk it into.

The engine lets a client that is not an agent act on a bot's tab in one way: as a viewer, which takes the tab, types where the page's focus is, and gives it back. While a viewer holds the tab, the bot's browser actions fail. The viewer channel does not say which element has focus, nor in which frame ([Engine: the bot's browser](../architecture/engine.md#the-bots-browser)). The engine's own agent tools could check both, but no agent tool takes a secret the agent does not hold.

The owner chose unattended fills, as other assistants offer them: nobody confirms each fill. The operator decides ahead of time, in each login: which bots it allows.

## Decision

**The server types a saved login into the bot's front tab when the bot asks, with every guard available today, and says plainly what remains.**

- **Allowed ahead of time.** A bot fills only while its browser is on, only logins that allow it, and only for a call its running turn made, as the engine recorded it.
- **The bot is never handed a value.** `fill_credential` names the login, by its name or its reference, and the field; the answer is `filled` or `refused` with a reason, in a fixed shape. Secrets that cannot be read now are a refusal too (`unavailable`). No value reaches a result, a work step, an entry or a log line.
- **The server checks the page, not the bot.** It takes the tab first, so the bot cannot move it, then reads the committed address from the engine. The origin must equal one of the login's exactly, in ASCII; plain `http:` is refused except on this computer, and a page still loading is refused. It reads the address again right before typing.
- **A password is always submitted** within the hold, and cleared if the page stays, so the bot does not get the tab back with a filled password field, unless the page moved the focus away from it on submit. The tab is given back only once the engine confirmed it ran the typing, since a release drops input still waiting.
- **A refusal is final** for that tab in that turn.
- **Bots keep running scripts in pages.** The engine's `preview_evaluate` stays for every bot, on Claude Code and Codex, and filling works on both harnesses.

## What it costs

- **The page decides where the value lands, within its origin.** J3 Bots cannot tell a password field from a comment box, nor the top frame from an embedded one of another origin. A page on the login's own origin can have the bot focus a field it reads. [Security: filling a login](../architecture/security.md#filling-a-login) lists the residual.
- **A user name and a one-time code are visible** on the page after they are typed, to the bot as to the operator.
- **A bot a login allows can read a value it just filled.** A page script, through `preview_evaluate`, can read the field back, or catch the value as it is typed, and its result reaches the model and its provider. The owner accepted this to keep page scripts for every bot. The other guards stand: the exact origin, the server holding the tab while it types, each login allowing only the bots it names, and the field cleared after a submit that stays. The real fix is a field the bot cannot read, which only the engine can give ([Proposal: a typed secret in the engine's browser](../proposals/engine-browser-secret-input.md)).
- **No confirmation.** A bot a page has fooled fills on the login's own site without asking the operator first. Each fill is a step in the bot's work, after the fact.

## What was rejected

- **A card to confirm each fill.** The operator would be the check the channel lacks, but no work could run unattended, which was the point.
- **Waiting for the engine to check the field itself.** The clean path is a change to T3 Code: a `type` action that takes a one-use secret reference and checks the field's kind and its frame's origin. It is drafted in [Proposal: a typed secret in the engine's browser](../proposals/engine-browser-secret-input.md) and not sent. When a pinned release has it, the fill moves to it and this record is rewritten.
- **Taking `preview_evaluate` from bots.** Claude Code drops it through `--disallowedTools`, for every bot of its instance at once, and Codex perhaps through `disabled_tools` in its `config.toml`, if the engine keeps that key when it writes its own server there (**Assumed**). Either way every bot loses page scripts, which the owner chose to keep.
- **Handing the bot the value or a script.** Anything in the bot's context is in the provider's.
- **Driving the browser directly**, apart from the engine. The browser is the engine's; a second control path would bypass its rule that a held tab refuses the agent ([decision 0001](0001-t3-code-as-unmodified-engine.md)).
