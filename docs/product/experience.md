# Experience

This document describes what the operator does and sees. It is written from their side: the question each screen answers comes before the screen.

## Flows

### First run

The operator installs J3 Bots on a machine that stays on, pairs a device with it, and opens the app. Until the first bot exists, the app is a short sequence of screens, one thing per screen, and every one of them can be left with its defaults: Continue always works, and Back, the screen's or the phone's own, always goes to the screen before.

1. **A welcome.** A few bots, alive, and one sentence on what they are: teammates that keep working on the operator's machine and subscriptions. Settings stays in reach from here, for signing out or changing the language.
2. **The first bot's name.** The field starts with a name, so the operator can just go on; they can rename the bot any time.
3. **Its look.** Twelve silhouettes and twelve colors to pick from, one pair already picked, with the bot above changing as the operator picks. Where the bot works is not asked: J3 Bots gives every bot its own workspace.
4. **A model, only when none is connected.** If no provider can run a bot yet, one step says so in plain words. In the desktop app running the bots on its own computer, it offers a button for each harness found there, "Sign in with Claude" and "Sign in with ChatGPT (Codex)", which signs that harness in with the operator's own account through their browser, with a quiet line that the bots' usage counts toward their plan's limits; where it finds neither, where to install them and "Look again"; and, folded away, an endpoint and its key instead. Elsewhere, it gives the one command to run on the machine J3 Bots runs on and a button that copies it, and points those who would rather sign in with their own Claude or ChatGPT account to the install guide. The step updates by itself when a provider connects, and once shown it stays in the sequence, also when the operator goes back. It never holds the bot back: the operator can create the bot anyway, and it says hello once a model is connected; if the bot landed on a provider that turns out not to be there, it moves to the one that connects. Only a server with no model at all refuses the bot, and the step then says so. While the engine is still checking the providers, in the first seconds after it starts, the step says so without the command, since the check may find one ready. It does not ask for API keys. With a provider ready, this step is skipped.
5. **The bot arrives** once the server has created it, in a short moment of its own, and becomes the primary bot without being asked.
6. The conversation opens and **the bot speaks first**: a short hello, then, if its job already says what to do, the work, with the same approvals as any other work; otherwise one question about what the operator needs, in the same message. While none of the operator's bots knows what to call them, the first bot to say hello asks that instead, in a few friendly words, as its one question. It saves the answer as the operator's name, which every bot uses from then on, and a quiet line in the conversation says so; Settings shows the name live and still changes it. An operator who passes over the question is not asked again, and telling any bot later to call them something else changes the name the same way. A name the bot only reads, in a page, a file, a forwarded message or another bot's words, is never taken as theirs. It saves what matters in the other answers as its first memories. There is no settings form to fill in. If the provider is not signed in yet, the hello waits for it. What the operator writes meanwhile waits too, and goes after the hello, as the bot's next turn: the bot greets, then answers the messages in the order they were written, also when the hello fails. A failed hello is otherwise offered again, until the operator writes. If the operator writes first while nothing holds the hello back, before it has gone to the engine, the hello is dropped and the bot answers the message. Once the hello has gone, a message is like any other: it reaches the bot's turn while that turn runs and can redirect it, or goes next once it has ended.
7. The moment the operator hands it something real, the bot drops the questions and does the work.

Until its hello can run, the conversation says what it waits for: the usage limit's reset, at the time it resets when the provider gives one, or otherwise a connected model, with the same command and copy button when one connects it. What the operator writes meanwhile waits for the hello and goes right after it, and each message says so in the same words ("Sent when the usage limit resets", "Sent once a model is connected"); once the hello has gone, it shows as queued like any message.

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
- A question the bot asked on its own can be dismissed, which is a "no". The bot does not ask again. A question its coding tool asks mid-task has no dismiss: it waits for an answer, or for the operator to stop the bot.

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
- While the room's work is under way, also work a bot left running in the background for it, the room's header offers Stop. It asks first, saying what ends (what the bots are doing for the room, and the work they left running for it) and that anything else they're doing goes on.

### One bot hands work to another

- The operator asks, or the bot offers ("want me to ask Scout?").
- The handoff appears in both conversations. The sender's shows a compact card, "To Wren", with the start of the message; tapping it shows all of it in place. The recipient's shows the message whole, under a centred line, "Message from" with Scout's avatar and name, the way a conversation marks the time between messages. The other bot's name goes to its conversation. An urgent message that never reached the teammate says so on both cards, and the recipient's conversation offers to send it again.
- The reply comes back later, as its own turn. The operator is told only when there is something new for them.

### Changing a bot

- **Name, title, avatar, model, permission mode**: in the bot's details.
- **Job**: an editable text in the bot's details. Telling the bot "from now on, never do X" updates memory instead; the job stays a short statement of purpose.
- **Memory**: the operator can read what a bot remembers, correct a line or delete it. They can also just tell the bot to forget something.
- **Fresh start**: stops any work the bot has running and resets its working context, with nothing of the recent conversation carried over, and drops the notes that would have told it what its routines reported. The conversation history, memory, routines and files stay. Each routine keeps what its recent runs said, which is the routine's own state: a run reads it to tell what is new and not report the same thing again. Moving a bot to another provider stops its work the same way, and its new working context does carry a digest of the recent conversation.
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
- **Settings**: engine and provider status, usage, the operator's name and time zone, devices, notifications, appearance.

## States the interface must always show

A bot is in exactly one of these, and the avatar carries it:

| State | Meaning |
| --- | --- |
| Idle | Nothing running |
| Thinking | A turn started and no visible work has happened yet |
| Working | A turn is running tools |
| Waiting | The bot asked a question or needs an approval |
| Blocked | The turn cannot continue: provider limit, error, engine unreachable |
| Done | Idle, with a result the operator has not read. It follows from the unread mark, so reading the result makes the bot idle on every device |

"Working" and "stuck" must never look the same. A bot whose turn has produced no activity for a long time is shown as possibly stalled, with a way to check on it or stop it.
