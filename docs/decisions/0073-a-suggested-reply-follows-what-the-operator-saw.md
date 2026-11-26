# 0073: A suggested reply follows what the operator saw

**Status:** Accepted.

## Context

T3 Code can guess the message its user will send next and show that guess in the composer once a turn ends. Its web client draws it where the empty composer's placeholder would be, with a Tab key badge. Tab takes it into the prompt and Escape sets it aside. The harness makes the guess: Claude Code through its SDK's prompt suggestions, and Codex through one more low-effort request after the turn. The engine streams the latest guess for each thread (**Read** at `59651c1`, `orchestration.subscribePromptSuggestion`, `usePromptSuggestion` and the composer). The owner asked for the same in J3 Bots, for someone who isn't technical.

In T3 Code a thread is what its user reads. In J3 Bots it is not. One main session serves a bot's whole working context: its conversation with the operator, every room it is in, and the messages of its teammates. The engine's user messages are wake envelopes, and the bot's assistant text is working text the operator never sees; only what the bot says with `say` reaches them. A guess is made from all of that. So it can follow a room's conversation, a teammate's message, or text the operator never read, and it can imitate the envelope rather than the operator.

## Decision

**A suggested reply is offered only in a bot's own conversation, and only while it follows what the operator saw there.**

- **The server decides where a guess may show** ([Server: Suggested replies](../architecture/server.md#suggested-replies)). It follows each bot's main session. It offers a guess only after a turn that only the operator woke in the bot's conversation (every wake it took, including those steered into it, is theirs), that spoke for that conversation and that completed, and only while the last message that turn said there is still the conversation's newest entry. The text must also be short enough for the composer and must not read as an envelope's markup. A guess after anything else is dropped.
- **Rooms never get one.** The guess would come from a session that also holds the bot's conversation and its other rooms, so it could carry one audience's words into another's. No check on the guess's text can rule that out.
- **It travels on the bot.** `Bot.suggestedReply` holds the text and the entry it follows. The roster carries it, so it needs no new subscription. The field is additive, so protocol 11 is unchanged. It lives in memory, as the engine's guesses do.
- **The composer offers it as T3 Code's does, and never sends it.** The guess shows faintly in place of the placeholder while the draft is empty, with **Use** beside it. Use, or Tab on the web, puts it in the draft for the operator to send or change. Typing hides it, Escape on the web sets it aside, and anything newer in the conversation takes it away, on the client before the server says so ([Clients: Suggested replies](../architecture/clients.md#suggested-replies)).
- **The operator can turn it off, and is told what it costs.** Settings → Providers has a switch, on by default. Its words say that each suggestion is one more small request to the AI account. The server writes the switch to the engine as `promptSuggestionsEnabled`, at provisioning and whenever it changes.

## Costs

- **The guess still reads what the operator never saw.** The server's checks bound where a guess shows, not what it was made from. After the operator's own turn, a guess can still lean on the bot's working text or on what the envelope carried with the operator's words, which is not a wake: a teammate's held message, or a routine's catch-up note. None of this has been observed on a running engine with a real model. Every engine fact here is **Read** at `59651c1`, and the server's rules are proved against the test engine.
- **Every turn pays, including turns whose guess is never shown.** The engine's switch is engine-wide, not per thread. So rooms, teammate messages and routines' side sessions make guesses the server drops. Claude Code makes the guess as a cached request, and Codex with a low-effort one, both on the operator's plan. Turning the switch off stops the offers at once. Codex stops guessing from its next turn. Claude Code stops only once its session's process starts again (**Read**).
- **A restart of the engine loses the guess.** The engine keeps no guess across its own restart, so the conversation offers nothing until the bot's next answer.
- **A room offers nothing**, though the same composer offers a guess in a bot's conversation.
- **Tab is taken while a suggestion shows.** In an empty composer showing a guess, Tab takes the guess instead of moving the focus on. Escape first, or Shift+Tab, moves the focus as before. This is what T3 Code does.

## Rejected

- **Showing the engine's guess wherever its session spoke.** It is the simplest way to match T3 Code, but in a room it could put the bot's private context in front of the room's audience, and after a teammate's message it would answer for the wrong person.
- **J3 Bots making its own guess from the conversation the operator sees.** That would be reliable for every audience, rooms included. But it is a new model call with its own prompt, its own cost and its own place in the usage view, where the owner asked for the harness's own suggestion as T3 Code shows it. It remains the way forward if the engine's guess turns out to be unreliable in use.
- **Cleaning up a guess that reads as an envelope.** Such a guess imitates the server, not the operator, and whatever remains after stripping its markup is not something the operator would type.
- **Off by default, as in T3 Code.** The owner asked for the feature, and a switch that nobody finds would hide it. The cost is small and is stated where the switch is.
- **A tap that sends the guess.** A message the operator did not write would go out in their name. Use only puts it in the draft.
