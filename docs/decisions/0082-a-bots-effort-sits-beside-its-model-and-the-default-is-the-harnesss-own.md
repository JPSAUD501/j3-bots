# 0082: A bot's effort sits beside its model, and the default is the harness's own

**Status:** Accepted.

## Context

Claude Code and Codex let their user choose how much the AI reasons before it acts: Claude Code's effort, and Codex's reasoning effort. More effort is slower and spends more of the subscription, for more careful work. T3 Code 0.1.13 reports, for each model of each provider, the levels it takes, as a `select` among the model's option descriptors, and runs a thread at the level its model selection names (**Read** at `bc0f04d`, `ClaudeModelCatalog.ts`, `CodexProvider.ts`, `CodexAdapterV2.ts`). Which levels exist depends on the provider and on the model: Claude Code's run from Low to Max, some Codex models start at None or Minimal and stop at Extra High, and an ACP agent can name its own. A level the model lacks is not handled the same way by every harness: Claude Code's catalog falls back to its default, while the engine passes Codex the level as it is, and Codex refuses it.

The owner asked for a per-bot effort setting beside the model, whose default is the harness's own.

## Decision

**Each bot has an effort, beside its model, in its settings: Default, or one of the levels the engine reports for that model.**

- **Default sends nothing.** Every bot starts at Default, and Default is no option at all on the engine's thread, so Claude Code and Codex choose as they would on their own. It is not a level J3 Bots guesses or pins.
- **Only the reported levels are offered.** The engine adapter reads each model's reasoning control (Claude Code's `effort`, Codex's `reasoningEffort`, or an ACP agent's select marked `reasoning`) and reports its levels with the model, in the engine's order, leaving out Claude Code's own "default" choice ([Engine: effort](../architecture/engine.md#effort)). A model that takes none shows no choice.
- **A level the model lacks never fails a turn.** The server refuses to save a level the bot's model does not take. A change of model that the bot's level does not fit takes the bot back to Default in the same save, and the form says so before Save, in plain words. A level that the model stops taking later, after its harness updates, stays saved, but the adapter sends it only while the engine reports it, so the turn runs at Default meanwhile, and the bot's settings say so ([Server: effort](../architecture/server.md#effort)).
- **It is applied like a model.** A new effort is a change of the bot's settings: it reaches the main session before its next turn, on the same provider session, through the same alignment as a model or a permission mode, and side sessions open with it.
- **Only the operator chooses it.** No bot tool changes a bot's model, and none changes its effort. A bot that another bot's `create_bot` makes takes its maker's model and starts at Default.
- **Plain words.** "Effort: Default / Low / Medium / High", with one line on the trade. A level the interface has words for is said in the reader's language; any other in the engine's English name. Storage is one nullable column on `bots` (migration 0058), and the contracts gain `Bot.effort`, each model's `efforts` and `bot.update`'s `effort`, all additive: protocol 11 is unchanged, and an older client ignores them.

## Costs

- **Nothing of it has run against a real engine.** What the adapter sends and how the engine treats it is **Read** at `bc0f04d`; the server's rules are proved against the in-memory engine. The conformance suite does not change a session's effort.
- **Default hides what the AI will actually use.** Codex marks its own default level, and the form could name it ("Default (Medium)"). It does not: the harness may change its default, Claude Code's is not reported at all, and the owner asked for the choice to read "Default".
- **A level a model stops offering stays saved.** The bot runs at Default until the operator changes something, which saves Default. Clearing it on its own would mean writing to a bot because a harness updated, which the operator did not ask for.
- **The engine's names for unknown levels are English.** A level the interface has no words for, from a harness that adds one, reads as the engine names it until the catalog learns it.

## Rejected

- **A fixed scale of Low, Medium and High, mapped onto each harness.** Simpler to read, but it would hide levels the operator can use (Max, Extra High), and invent a mapping the harnesses do not define.
- **An effort per message or per routine.** More control than someone who isn't technical needs, in places they would have to learn. The bot is where its model already is chosen.
- **Letting the managing bot change a teammate's effort.** No bot changes a model today, and effort is spent from the operator's plan: both stay the operator's choice.
- **Failing the save, or the turn, when the model changes.** Making the operator fix an effort before a model change saves is friction for no gain, and a failed turn is what the default exists to avoid.
