# 0103: A room of bots only is read, never written, by the operator

**Status:** Accepted

Amends [0042](0042-a-room-counts-rounds.md) (where a room's rounds start) and [0050](0050-bots-and-rooms-are-visible-or-hidden-and-the-operators-choice-wins.md) (what a room a bot starts is by default). Everything else in both stands.

## Context

A bot the operator asks for a team starts a room with its teammates, and the operator is in every room: they read it, write in it, mention its members and react to their messages. Often that is not what the work needs. The bots can split a job among themselves and bring back only the result, and the operator would rather watch than take part. The owner put it as "the same idea as one bot talking to another": a teammate conversation shows two bots' messages and has no composer, and a room of several bots should be able to work the same way. The operator reads such a room and never posts in it, and there is no "join" button.

A room the operator never writes in also never resets its rounds. In any other room the operator's word sets the rounds back to 0 ([0042](0042-a-room-counts-rounds.md)), so the limit stays on the bots talking among themselves. Without that word, a room of bots only needs its own end. That end has to cost a bounded number of turns, and someone has to say so.

## Decision

**`start_room` takes a required `with_user`. With `false`, the room is of bots only (`Room.botsOnly`). The operator reads it and never writes, reacts or answers there. Its rounds count from the kickoff, and at the limit the room pauses and the bot that started it is told.**

- **The bot chooses every time.** `with_user` has no default: the tool's description says when to pick each. Pick `true` when the operator asked to be in the room, will want to steer it, or must answer its members. Pick `false` when the bots can do the work among themselves and the operator only wants the result. Only a bot makes a room of bots only, and only in a turn the operator spoke in, as for any `start_room`. The operator's `room.create` makes rooms they take part in.
- **It reads like a teammate conversation.** Bubbles have each bot's name over its run of messages. In place of the composer, a mark says "Read-only · Only bots talk here". Reactions show, and none can be added: on a phone a tap on one only says who reacted. There is no Reply or quote. Its details show who is in it with the same words and offer no Edit. Its menu and details keep everything else: Pin, Hide or Show, Mark as unread, sections, Stop, Archive, Unarchive and Delete. These are about the operator's list and the room's work, not about taking part. A room of bots only that deleting bots left with one member stays archived, and says so where Unarchive would be: the operator cannot give it members.
- **No operator post reaches it, by any path.** The server refuses each one with `Conflict("room-bots-only")` and writes nothing: a message, a reply, a quote, `@everyone`, a reaction, and a change of the room's name or members. A mention of the room in a bot's conversation still works: it points and delivers nothing ([0092](0092-a-mention-in-a-bots-conversation-points-and-delivers-nothing.md)), so it reaches the conversation's bot and not the room. When that bot then posts with `message_bot`, the post is the bot's own and not a relay of the operator's word: it takes its round past the room's newest. A bot's `ask` from a turn of the room is refused with a reason. The operator answers nothing there, so the bot tells them in its own conversation with `say` and `to: "dm"`, and says in the room what waits on them.
- **Rounds count from the kickoff, for good.** The kickoff is round 0, as in any room, and nothing after it is the operator's word. From round 3 the closing line says the room pauses soon, so a member who speaks says what is settled and what is left. A bot message of round 5 or later is posted and wakes nobody, as in any quiet room. The first such message shows a `room-paused` notice in the room and in the starter's conversation, in place of the `chain-stopped` line. It also wakes the starter there with a `room-paused` system wake, so the starter tells the operator in a few words where the room got to. The hop and fan-out budgets of teammate messages and Stop work as in any room, and the room's Stop also drops the starter's wake while it waits. When the starter was deleted, the room still shows the notice, naming nobody as told.
- **Going on takes a new room.** A paused room stays paused. Its envelope and the `start_room` description say that more work goes in a new room, started on the operator's word, whose kickoff picks up where the last one stopped. That costs one more kickoff, and each new room needs the operator to have asked again.
- **It starts hidden.** Unless the bot sets `hidden: false`, a room of bots only lands among the hidden conversations, and a bot shows it when the operator asked to watch it. It notifies the operator as any hidden room does ([0050](0050-bots-and-rooms-are-visible-or-hidden-and-the-operators-choice-wins.md)). `list_teammates` says of each room whether the operator takes part in it (`withUser`).
- **Within protocol 11.** `Room.botsOnly` is optional, and a client reads a room without it as one the operator takes part in. The `room-paused` notice and the `room-bots-only` reason are new values. Migration 67 adds `rooms.bots_only`, false for every existing room.

## Consequences

- A room of bots only costs at most four rounds of its members' turns after the kickoff, plus the starter's one turn to report the pause. The operator cannot make it go on by writing there. That is the point, and a new room is one request away.
- A bot can wrongly pick `false` for a room the operator wanted to steer. The tool's description draws the line, and the operator can ask for a new room they take part in.
- An older client does not know `Room.botsOnly`. It shows such a room with a composer, and the server refuses what the operator sends there with a reason that client cannot name. Its notice reads as one that needs a newer version of the app.
- Decision 0101's required `listed` replaces `hidden` on `start_room`. Whichever of the two merges second writes the default for a room of bots only (unlisted) in that field's terms.

## What was rejected

- **A join button, or letting the operator write anyway.** The owner asked for a room that works like two bots talking. A room that takes the operator's word on request is a normal room with a hidden composer.
- **Counting the relay of the operator's word.** In a normal room, a bot's first post on the operator's word, from another conversation, resets the rounds. Here it would let a room the operator never wrote in run without end, one request at a time, while the room shows nothing of the operator.
- **A pause the operator resumes.** A Resume in the room is the operator's word in another form, with the same cost, and it would be one more control on a screen that is meant to be read only.
- **A default for `with_user`.** Either default would decide, for every bot that forgot the field, whether the operator is in the room. A required field makes the bot decide.
