# 0072: Errors say what to do, Stop can be forced, and questions arrive whole

**Status:** Accepted.

## Context

The engine reports more about a turn's trouble than J3 Bots used to show, and several of the things it showed did not help.

- **Errors spoke the engine's language.** A failed turn said "The provider returned an error" or "Can't reach the engine". A person who is not technical cannot tell from either what happened or what to do next. A failed message said the engine refused it.
- **A retry looked like silence or a failure.** When a provider call fails, the engine tries the turn's AI again, and its own client says so. J3 Bots showed nothing, so a bot whose AI was briefly unreachable looked stalled. A retry that then worked had happened unseen, which is right, but nothing told the operator what the wait was.
- **A Stop could be ignored with no way out.** An AI that does not answer the engine's stop leaves its turn running. The engine marks the stop unresponsive and offers its own client a force stop. J3 Bots kept showing Stop, and Stop did nothing more.
- **Large questions hung a turn.** A question from the harness's own tool with more than four parts, or more than six options to one, did not fit the question card. The server showed a card that said so and took no answer, so the turn waited until the operator stopped it.

## Decision

**What the operator sees of trouble is what they can understand or act on, in plain words, with a next step.**

- **The failures a person meets** are a usage limit with when it resets, the AI's account signed out (sign in again in Settings), the AI unreachable (check the internet connection, then try again), and work that couldn't finish (try again). Each names the AI, Claude or ChatGPT, where the bot is known (`PresentationContext.aiName`). A notice does not say whose turn it was, so it says "the AI". No failure text names the engine, a provider, a class or a code. `transport_error` is its own class, `unreachable`, so it can say what to do.
- **The technical words go behind Details, and to the log.** A failed turn's notice carries the engine's error class, code and message (`details`), with every secret J3 Bots gives the engine taken out and the rest scrubbed of what looks like one by the adapter, and cut to 2,000 characters. A client shows them only when the operator opens Details. The server logs them with the failure.
- **A retry is the bot's quiet state, not a card.** While the engine tries the AI again, the turn's state carries `retrying`, and the bot's line says "Having trouble reaching Claude, trying again" in place of its step. A retry that works leaves no trace. One that gives up fails the turn as before.
- **Stop becomes Force stop when the AI ignores it.** When the engine marks a stop unresponsive, the bot (`Bot.forceStop`), or a room whose turn it is or whose own Stop went to that bot (`Room.forceStop`), offers Force stop in place of Stop. One line says why: the bot isn't responding to Stop, and Force stop ends what it is running now. Pressing it, or the stop shortcut, records the same Stop as before, so it reaches everything that Stop reaches ([Server: Stop](../architecture/server.md#stop)). It then asks the engine to end that turn's program (`forceStopThread`), also while the Stop it sent again has the engine reporting the stop as not ignored for a moment. The request is durable: if the engine cannot be reached, the Stop runner sends it on a later pass. It is dropped when the turn ends without it and nothing of the session's work goes on.
- **Questions arrive whole.** A card shows every question the harness asked, however many, stacked one under the other, with each question's header over it and each option's preview under it. The card stays answerable as one form. Stacking was chosen over paging: the operator sees the whole decision at once, and a form needs no second navigation of its own.

## Costs

- **An older client cannot answer a large question.** Protocol 11 stays, and an older client refuses a known entry kind that fails to decode. A card larger than four questions of six options therefore keeps a single placeholder in `questions`, which asks for an update, and carries the question in `whole`. An older client shows the placeholder, and its turn waits until a newer client answers or the operator stops it. That is how every larger question behaved before.
- **A force stop leaves what was done.** Files the AI wrote and commands it ran stay done. The turns queued behind the stopped one are not ended by the force stop. The Stop that comes with it cancels them, as any Stop does. The next turn starts a new provider session in the same engine session, so the conversation carries on.
- **Force stop is checked against the scripted engine only.** No provider in the conformance suite ignores a stop, so the call against a real one is **Assumed** ([Engine](../architecture/engine.md#the-adapters-interface)).
- **The AI's name needs the engine's status.** A client that has not read it yet says "its AI" instead.
- **Scrubbing knows only what J3 Bots gave and what looks like a secret.** The adapter removes the secrets it gives the engine, whatever their shape, and what looks like a secret: credentials named as such, tokens and keys in their known forms, and long runs of letters and digits. A secret J3 Bots was not given, with no recognizable shape, can still reach Details and the log. Details is shown only to the operator, on their own devices.

## Rejected

- **Showing the engine's message as the failure.** It is accurate and often unreadable, and it can carry secrets. It stays under Details.
- **A retry card in the conversation.** A retry that works would leave a card about nothing. One that fails already leaves a notice.
- **A separate Force stop action beside Stop.** Two buttons ask the operator to know which one applies. One button that turns into Force stop when Stop has failed asks nothing.
- **Paging the questions.** Paging hides the later parts and adds a step per part. Stacking keeps the whole decision in view.
- **A new entry kind for large questions.** An older client would refuse the whole conversation that holds one, not just that card.
