# Experience

This document describes what the operator does and sees. It is written from their side: the question each screen answers comes before the screen.

## Flows

### First run

The operator installs Roster on a machine that stays on, and opens the web client.

1. Roster checks that the engine is running and that at least one provider is signed in. If none is, it says which command signs one in and waits. It does not ask for API keys.
2. The operator creates their first bot by giving it a name. Roster suggests making it the primary bot.
3. The conversation opens and **the bot speaks first**. It asks what the operator wants it for, one question at a time, and saves the answers as its job and its first memories. There is no settings form to fill in.
4. The moment the operator hands it something real, the bot drops the questions and does the work.

### Talking to a bot

The operator picks a bot in the roster and types.

- The bot acknowledges within a second or two, in a few words, then works.
- While it works, its avatar shows the state and one line under its name says what it is doing right now. The operator can open the work to see every step, but nothing forces them to.
- The answer arrives as a short message. Longer material arrives as a file or a card.
- The operator can send another message at any time. It reaches the bot mid-turn and can redirect it.
- "Stop" ends the work. It does not undo what was already done, and the bot says what was left running, if anything.

### Being asked

A bot needs a decision or permission.

- A **question** arrives as a card with a few options and, when it makes sense, room for a typed answer. Tapping an option answers it.
- An **approval** arrives as a card that names the exact action, with Allow and Deny. Allowing can be for this once or for the session.
- Both produce a notification on the operator's devices. Answering on any device resolves the card everywhere.
- A dismissed question is a "no". The bot does not ask again.

### Work that starts on its own

The operator says "every weekday morning, tell me what changed in the repo" or "let me know when the deploy finishes".

- The bot creates a routine and confirms the exact schedule it saved, in the operator's time zone.
- When the routine runs and has something to report, a message appears in the bot's conversation. It reads like the bot mentioning something it took care of, not like a system alert.
- When there is nothing to report, nothing appears. The run is still recorded in the routine's history.
- The operator pauses, edits, tests or deletes a routine from the bot's details, or by telling the bot.

### Several bots, one goal

The operator creates a room, adds two to six bots, and writes.

- Writing without addressing anyone goes to the host. The host answers or hands the request to the right bot by mentioning it.
- `@Name` gives a request one owner. `@everyone` asks each member in turn and is meant to be rare.
- Bots answer each other in the room. The chain stops when a bot has nothing to add, or when the room's budget for consecutive bot turns runs out; then the room waits for the operator.
- Approvals and questions never appear in a room. They go to the asking bot's own conversation, and the room shows that the bot is waiting.

### One bot hands work to another

- The operator asks, or the bot offers ("want me to ask Scout?").
- The handoff appears in the conversation as a compact card: who was asked, about what. Opening it shows the exchange.
- The reply comes back later, as its own turn. The operator is told only when there is something new for them.

### Changing a bot

- **Name, title, avatar, model, permission mode**: in the bot's details.
- **Job**: an editable text in the bot's details. Telling the bot "from now on, never do X" updates memory instead; the job stays a short statement of purpose.
- **Memory**: the operator can read what a bot remembers, correct a line or delete it. They can also just tell the bot to forget something.
- **Fresh start**: resets the bot's working context. The conversation history, memory, routines and files stay.
- **Delete**: removes the bot, its conversation, memory and routines after an explicit confirmation. Files in its workspace are kept unless the operator chooses otherwise.

### Knowing what it costs

- A usage view shows each provider's limit windows as the engine reports them, and which bots and routines used turns recently.
- A routine that fires often shows its run count next to its schedule.
- When a provider's limit is reached, affected bots show as blocked with the reset time, and their routines wait instead of failing repeatedly.

## Screens

The interface is the same three regions on every surface. On a phone they are three screens; on a wide window they sit side by side.

### Roster

Answers: who do I have, who needs me, what is each of them doing.

- One row per bot and per room: avatar, name, time of last activity, one line of status or the last message.
- Rows that need the operator (a pending question or approval, an unread result) come first and are marked.
- Pinned rows stay at the top. Hidden bots keep running and are reachable through search.
- Search finds bots, rooms and messages.
- New bot and new room are one action each.

### Conversation

Answers: what did we say, what is it doing, what does it need from me.

- Messages as bubbles, the operator's on one side and the bot's on the other, with timestamps between groups.
- Cards inline: questions, approvals, files, handoffs, routines created or changed.
- A finished turn's work folds into one line ("Worked for 2m") that opens to show the steps.
- A composer labeled with the bot's name. Attachments and dictation are in the composer; nothing else is.

### Details

Answers: what is this bot, and what runs without me.

- Profile: name, title, avatar, job.
- Routines with their schedule, next run, last result, and a pause switch.
- Files the bot produced.
- Memory, readable and editable.
- Model and permission mode.

### Outside those three

- **Command palette** on desktop and web: jump to a bot, a room or a message; run any action by name.
- **Settings**: engine and provider status, usage, devices, notifications, appearance.

## States the interface must always show

A bot is in exactly one of these, and the avatar carries it:

| State | Meaning |
| --- | --- |
| Idle | Nothing running |
| Thinking | A turn started and no visible work has happened yet |
| Working | A turn is running tools |
| Waiting | The bot asked a question or needs an approval |
| Blocked | The turn cannot continue: provider limit, error, engine unreachable |
| Done | A turn finished with a result the operator has not read |

"Working" and "stuck" must never look the same. A bot whose turn has produced no activity for a long time is shown as possibly stalled, with a way to check on it or stop it.
