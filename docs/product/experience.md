# Experience

This document describes what the operator does and sees. It is written from their side: the question each screen answers comes before the screen.

## Flows

### First run

The operator chooses where the bots live. In the desktop app, the first screen asks: "Use this computer" runs them on that computer, where they sleep when it sleeps, and goes straight on with nothing to type, while J3 Bots starts there; "Connect to a server" leads to the address of a machine that stays on, where the operator installed J3 Bots, and pairing with it. A browser or a phone always pairs with a server. Until the first bot exists, the app is a short sequence of screens, one thing per screen, and every one of them can be left with its defaults: Continue always works, and Back, the screen's or the phone's own, always goes to the screen before.

1. **A welcome.** A few bots, alive, and one sentence on what they are: teammates that keep working on the operator's machine and subscriptions. Settings stays in reach from here, for signing out or changing the language.
2. **The first bot's name.** The field starts with a name, so the operator can just go on; they can rename the bot any time.
3. **Its look.** Twelve silhouettes and twelve colors to pick from, one pair already picked, with the bot above changing as the operator picks. Where the bot works is not asked: J3 Bots gives every bot its own workspace.
4. **A model, only when none is connected.** If no provider can run a bot yet, one step says so in plain words. In the desktop app running the bots on its own computer, it offers a button for each harness found there, "Sign in with Claude" and "Sign in with ChatGPT (Codex)", which signs that harness in with the operator's own account through their browser, with a quiet line that the bots' usage counts toward their plan's limits; where it finds neither, where to install them and "Look again"; and, folded away, an endpoint and its key instead. Elsewhere, it gives the one command to run on the machine J3 Bots runs on and a button that copies it, and points those who would rather sign in with their own Claude or ChatGPT account to the install guide. The step updates by itself when a provider connects, and once shown it stays in the sequence, also when the operator goes back. It never holds the bot back: the operator can create the bot anyway, and it says hello once a model is connected; if the bot landed on a provider that turns out not to be there, it moves to the one that connects. Only a server with no model at all refuses the bot, and the step then says so. While the engine is still checking the providers, in the first seconds after it starts, the step says so without the command, since the check may find one ready. It does not ask for API keys. With a provider ready, this step is skipped.
5. **The bot arrives** once the server has created it, in a short moment of its own, then travels into the header of its conversation as that opens, and becomes the primary bot without being asked. On this computer, a bot asked for while J3 Bots is still starting there waits for it, and the arrival says so. A start that failed takes the screen instead: why, what repairs it, and Try again.
6. The conversation opens and **the bot speaks first**: a short hello, then, if its job already says what to do, the work, with the same approvals as any other work; otherwise one question about what the operator needs, in the same message. While none of the operator's bots knows what to call them, the first bot to say hello asks that instead, in a few friendly words, as its one question. It saves the answer as the operator's name, which every bot uses from then on, and a quiet line in the conversation says so; Settings shows the name live and still changes it. An operator who passes over the question is not asked again, and telling any bot later to call them something else changes the name the same way. On a server upgraded from before this question, the bots it already has have said hello, so no new bot asks; such an operator tells any bot what to call them, or sets it in Settings. A name the bot only reads, in a page, a file, a forwarded message or another bot's words, is never taken as theirs. It saves what matters in the other answers as its first memories. There is no settings form to fill in. If the provider is not signed in yet, the hello waits for it. What the operator writes meanwhile waits too, and goes after the hello, as the bot's next turn: the bot greets, then answers the messages in the order they were written, also when the hello fails. A failed hello is otherwise offered again, until the operator writes. A bot another bot made for a room opens in that room instead, and never says hello ([Several bots, one goal](#several-bots-one-goal)). If the operator writes first while nothing holds the hello back, before it has gone to the engine, the hello is dropped and the bot answers the message. Once the hello has gone, a message is like any other: it reaches the bot's turn while that turn runs and can redirect it, or goes next once it has ended.
7. The moment the operator hands it something real, the bot drops the questions and does the work.

Until its hello can run, the conversation says what it waits for: the usage limit's reset, at the time it resets when the provider gives one, or otherwise a connected model, with the same command and copy button when one connects it. What the operator writes meanwhile waits for the hello and goes right after it, and each message says so in the same words ("Sent when the usage limit resets", "Sent once a model is connected"); once the hello has gone, it shows as queued like any message.

### Talking to a bot

The operator picks a bot in the roster and types.

- The bot acknowledges within a second or two, in a few words, then works.
- While it works, a row where its reply will appear shows its face in that state, one line saying what it is doing right now, and how long the turn has run. The operator can open the work to see every step, but nothing forces them to.
- The conversation's header shows the bot's face and name, with no line under the name about what it is doing: that is the conversation's to show, in the row of the turn under way and in its cards.
- The answer arrives as a short message. Longer material arrives as a file or a card.
- The operator can send another message at any time. It reaches the bot mid-turn and can redirect it.
- "Stop" ends the work. It does not undo what was already done, and the bot says what was left running, if anything. It sits in the bot's details, one press from the conversation's header, while there is work to stop; the conversation itself stays about what the bot is doing. On a computer, `Ctrl+.` (`⌘.` on macOS) stops it from the conversation.

### Being asked

A bot needs a decision or permission.

- A **question** arrives as a card with a few options and, when it makes sense, room for a typed answer. Tapping an option answers it.
- An **approval** arrives as a card that names the exact action, with Allow and Deny. Allowing can be for this once or for the session.
- Both produce a notification on the operator's devices. Answering on any device resolves the card everywhere.
- While the bot waits on a card the operator has scrolled away from, "Waiting for you" floats over the end of the conversation, with an arrow toward the card, and brings it back into view.
- A question the bot asked on its own can be dismissed, which is a "no". The bot does not ask again. A question its coding tool asks mid-task has no dismiss: it waits for an answer, or for the operator to stop the bot.

### Watching the bot's browser, and taking it over

A bot shops, books or reads a site in its own browser, on the machine J3 Bots runs on.

- While the bot has a page open, a globe sits in its conversation's header, its mark breathing while the bot acts on the page. Under the line of the turn under way, a picture of the page and the site's name, taken again as the page changes and every few seconds while the bot works. It is a picture, not a live view: watching it costs nothing.
- Either opens the browser: beside the conversation on a wide window, over it on a tablet, rising from the bottom on a phone. The page is live, its site and address shown, and a line says who is acting on it: "The bot is browsing", "You have control" or "On another device". While the operator only watches, the page takes nothing they do, and the bot's pointer shows where it acts.
- **Take control** is the one primary action. Once taken, the bot cannot act on the page, and everything the operator does over it goes to the page: the pointer, the wheel, typing, a phone's keyboard on a field they tap. Back, forward, reload and the address field appear only now. **Done** gives the page back to the bot.
- When the bot asked for help on the page (a sign-in, a code, a check that a person is there), **Done** tells it the step is done, and **Can't do it** tells it the operator could not; either gives the page back. **Open browser** on that card opens the browser on the page.
- A sign-in window the page opens shows in the browser as the bot's front page; the operator keeps control in it, and the browser goes back to the page it came from when it closes.
- Leaving the browser while in control asks once whether to give the page back to the bot. Keeping it leaves the bot waiting until the operator returns and presses Done; giving it back this way leaves a help card open, since the step may not be done.
- The operator's clipboard and files never reach the page: pasting, dropping, downloads and file pickers are out of reach in this version.

### Work that starts on its own

The operator says "every weekday morning, tell me what changed in the repo" or "let me know when the deploy finishes".

- The bot creates a routine and confirms the exact schedule it saved, in the operator's time zone.
- When the routine runs and has something to report, a message appears in the bot's conversation. It reads like the bot mentioning something it took care of, not like a system alert.
- When there is nothing to report, nothing appears. The run is still recorded in the routine's history.
- The operator pauses, edits, tests or deletes a routine from the bot's details, or by telling the bot.

### Several bots, one goal

The operator asks a bot for a team, or sets one up themselves.

- **Asking for one.** The operator tells a bot, in its conversation, something like "make me a support group, several bots". In that one turn, the bot makes the teammates the group lacks (only the primary bot can, at most five at a time), each on the bot's own model, or on the default one while that model's provider is not ready; it then starts a room with them, and posts a kickoff there: what the room is for, who owns which part, the rules, and what each member should answer first. Then it says in the conversation what it set up and who owns what, under a quiet "Scout started Support" line. A bot made for the room opens there, with no hello in its own conversation, which shows instead a quiet "Made by Scout for Support" line. Both lines name the room as it is called now, so a rename shows there, and open it with a tap; once it is deleted they say "a room" and open nothing. The members the kickoff names, every one by default, start on it at once; a member the kickoff gives a part answers it rather than waiting for someone else to speak. Only the operator's own word starts a team: a bot never makes teammates or rooms because a routine, another bot or something it read asked.
- **Setting one up.** The operator creates a room, adds two to six bots, and writes.

Either way, the room then works the same:

- The room's header shows its members' avatars side by side, up to three, then how many more ("+2"), and its name. The composer reads "Message Support".
- Every member reads every message in the room, the operator's and each bot's. A message that mentions nobody wakes every member at once, but the bot that wrote it, and each answers only if it has something to add, so a hello is not answered by every member. Members answering at the same moment do not see each other's replies, so two may still say the same thing, as people in a group do. The room's empty state says so.
- `@Name` speaks to that bot: only the bots a message names are woken, and they answer; the others read it the next time they are woken, with whatever came after it. `@everyone` wakes every member and asks each to answer. A bot's message can name members too, and wakes only them; one that names nobody wakes the others. Nothing under the composer says whom a message goes to: a picked mention stands out in the text. The operator's message reaches a member it wakes mid-turn when that member is already answering in the room, and can redirect it; what a member missed while it worked reaches it with its next turn.
- While members answer, one quiet line at the room's end says who, with their faces: "Hal is answering…", several at once, "Hal and Bo are answering…", and past three, "Hal, Bo, and 2 more are answering…". It changes in place as each one's turn ends and goes once nobody answers, whether or not they said anything.
- A message that could not go because a member it mentions left the room says so, and Send again sends it to the members it mentions who stayed, or to the room when none did.
- Bots answer each other in the room. A member can also bring later work back into the room from its own conversation, instead of passing it from bot to bot. It quiets down when no bot has anything to add. The room also counts the bots' messages since the operator last wrote there: after six, its members are told the conversation is winding down and answer only what is essential; after twelve, a bot's message is still posted but wakes nobody, and one quiet line says the bots stopped answering each other and the room waits for the operator. The operator's next message there starts the count again.
- Approvals and questions never appear in a room. They go to the asking bot's own conversation, and the room shows that the bot is waiting.
- While the room's work is under way, also work a bot left running in the background for it, the room's details offer Stop. It asks first, saying what ends (what the bots are doing for the room, and the work they left running for it) and that anything else they're doing goes on.

### One bot hands work to another

- The operator asks, or the bot offers ("want me to ask Scout?").
- What the two bots say to each other goes in their **teammate conversation**, "Scout and Wren", one per pair of bots. It reads like a room: each bot's name over its messages, its avatar in its tint, the time between them, and each message that never reached the other bot marked so. The operator reads it and cannot write in it: in place of a composer, a "Read-only" mark. Its menu offers "Talk to Scout", "Talk to Wren" and "Start a room with both".
- In each bot's own conversation, a run of messages with teammates, with nothing else between them, however long it lasted, is one small line led by the first teammate's small avatar ("Wrote to Wren", "Wren wrote", "Talked with Wren · 3 messages"), which opens the teammate conversation at the run. A run with several teammates ("Talked with Wren and Pip · 4 messages") first asks which conversation to open, in a sheet on the phone. A line whose messages did not all reach their teammate says how many did not, quietly ("1 not delivered"). An urgent message that never reached the teammate still shows the recipient's conversation a card that offers to send it again.
- The reply comes back later, as its own turn. Messages between bots never make a conversation unread, never become its last line in the roster and never notify: the operator is told only when a bot has something new for them, and a bot that needs them says so.

### Changing a bot

- **Name, title, avatar, model, permission mode**: in the bot's details.
- **Job**: an editable text in the bot's details. Telling the bot "from now on, never do X" updates memory instead; the job stays a short statement of purpose.
- **Memory**: the operator can read what a bot remembers, correct a line or delete it. They can also just tell the bot to forget something.
- **Fresh start**: stops any work the bot has running and resets its working context, with nothing of the recent conversation carried over, and drops the notes that would have told it what its routines reported. The conversation history, memory, routines and files stay. Each routine keeps what its recent runs said, which is the routine's own state: a run reads it to tell what is new and not report the same thing again. Moving a bot to another provider stops its work the same way, and its new working context does carry a digest of the recent conversation.
- **Delete**: removes the bot, its conversation, memory and routines after an explicit confirmation. Files in its workspace are kept unless the operator chooses otherwise.

### Sharing a bot, and starting from one

The operator has a bot that does its job well and wants someone else to have it, or a copy to start from.

- **Share as template…** in the bot's details shows everything the file will hold, in full: the profile, the job, each skill's text, each routine's instruction and schedule, the model and the permission mode. It says that the job, the skills and the routines go exactly as written, and that the bot may have written some of them, so the operator reads them for anything they would not share; one line says what never goes (memory, the conversation, files, accounts, credentials, anything else on this machine). A bot whose file would be too large to read is not shared: the screen says so, and names the largest part to shorten. On Android it ends in the system's share sheet with a `.j3bot` file; on the web and the desktop the file is downloaded, or its text copied.
- **New bot from a template** in the roster's new menu picks a `.j3bot` file. A file dropped anywhere on the web or desktop window, shared to J3 Bots on Android, or tapped where it kept its media type, leads to the same place.
- That place is a preview of everything the bot will be and do, with a note that the file came from outside J3 Bots, that what it says goes only into the new bot, and that the other bots see the new one as any teammate. It says which model the bot will run on here, and whether that replaces the template's because this server does not offer it. The permission mode starts at the template's or the default, whichever lets the bot do less, and says so when it lowered the template's; the operator can pick any mode. A mode left as it was is the server's to settle when the bot is made, by the same rule. Its routines arrive paused, to be turned on in its details.
- Nothing is created until the operator presses Create. Then the new bot's conversation opens, and its first turn works from its job as written. A file that is too large, damaged, or from a newer J3 Bots is refused with a sentence saying which.

What a template holds and leaves out is in [Concepts](concepts.md) and [decision 0023](../decisions/0023-a-bot-template-is-a-file.md).

### Giving a bot a service

The operator wants a bot to reach something it cannot yet: their notes, their tracker, their calendar.

- **Connectors**, in Settings and in a bot's details, opens one screen: the operator's connectors first, each with its status and who may use it, then the gallery's featured entries and a search of it. "Add your own" is the last row. A bot can suggest one in its conversation, with a card that says why; Connect on the card opens the same screen at that entry, for that bot.
- An entry's page says what the connector lets bots do, in J3 Bots' own words for a curated one and its publisher's for one from the registry, and who published it. It connects the way the service asks:
  - **Sign in**: one press opens the system browser at the service. On the desktop app the browser comes back to the app, which hands the sign-in to the server, and the page says it is done. On the web, served over plain HTTP, the browser ends on a page that does not load; the screen says to copy that page's address and paste it, and that the desktop or phone app does this without the step. Served over `https:` with its address set (`publicOrigin`), the server takes the browser back itself. On the phone the service opens over the app, in the browser's own tab; the phone takes the browser back and hands it to the server, with a notification while it waits, or, from a server reached over `https:` with its address set, the server takes it back itself. Over `https:` without it, the phone asks for the address to paste, as the web does.
  - **A key or token**: where to make one, with a button that opens that page, then masked fields, with what each is for. One that takes one of a few values is a list to pick from.
  - **An app of the operator's own**, for a service that asks for one: the steps to register it, a button that opens where to do so, the redirect address to register on it for the way this device signs in, as the server states it, ready to copy, then its client ID and its secret. A curated entry already knows the service's issuer; for another, the operator gives it. J3 Bots uses that app only with that issuer.
  - **A command**, for a registry entry the server runs: the whole command line, and a confirmation that it runs on the operator's computer, as their user, before it is added.
- Who may use it starts as the bot that suggested it, or the primary bot, and widens to some bots or all of them, those made later included.
- On the phone, Add your own takes an address only, and a connector that runs a command shows read-only, with a line that it is connected, changed or removed from J3 Bots on the computer: the phone is no place to review a command that runs on the server. Its status, and why it is not running, read as on the computer.
- **Add your own** takes an `https:` address, with any headers and an OAuth client the service gave the operator (its issuer, client ID and secret), or a command with its arguments and environment. A key belongs in the environment, where it is masked, never in an argument. An address in the operator's own network is added only once they confirm they meant it.
- **A command** is a program on the computer that runs J3 Bots, one argument a line, and environment variables, each a name and a masked value. Before it is sent, the form says what the server would refuse: a package `npx` or `uvx` fetches at no exact version (with an example of one), a launcher option J3 Bots cannot read past, a variable such as `PATH` that chooses which program runs, or one named twice. Then a confirmation shows the whole command line, every argument as it will run, and the name of every variable, never a value, and says it runs there as the operator's user, with everything that user can reach. Nothing runs until they choose Run it.
- A command connector's page has **Change command**: its program and its variables' names as they are, its arguments and values never shown. A new value alone is saved as it is, an empty one keeping its own. Anything else (the program, the arguments, a variable's name, one added or removed) needs the arguments and each value typed again, since the command line is saved whole, and asks for the confirmation again, marking a variable that is new, one that is gone and a program that changed. The process the old command started stops, and the new one lists its tools: a tool that is new or changed waits for the operator as for any connector. Disconnect says the program stops and its variables' values are deleted.
- A connector's page shows its status and what fixes it: connected; needs signing in again (Sign in again); can't reach it, and why; a command that is not running, because its program is not on the computer (install it, or name it by its full path) or because it stopped or could not start (check the command and its variables; it starts again when a bot next uses it, waiting longer each time); or the vault locked (Unlock, which opens Settings over the screen; closing Settings returns to the page as it was, with anything typed in it). Its tools are listed once it is connected. It says which bots use it, changed in place, and the origin of its address or the program it runs, never the whole address or the arguments, which can carry a key. Disconnect asks first.
- When a connector's tools change, its page shows what is new or changed, and bots get none of those until the operator accepts them; its other tools work as before. "Not now" leaves them held, without a badge, and Accept stays on the page.
- A bot that finds its connector signed out says so with a card in its conversation, whose Sign in again opens the connector's page and starts the sign-in, or opens its form again for one that takes a key.

What a connector is, and what a bot can and cannot do with one, is in [Concepts](concepts.md); how its secrets are kept is in [Security: connectors](../architecture/security.md#connectors).

### Knowing what it costs

- A usage view shows each provider's limit windows as the engine reports them, and which bots and routines used turns recently.
- A routine that fires often shows its run count next to its schedule.
- When a provider's limit is reached, affected bots show as blocked with the reset time, and their routines wait instead of failing repeatedly.

### Keeping J3 Bots up to date

- A newer release never interrupts the operator. A dot on the Settings button and "Update available" under it are the whole notice. Settings → About and updates names the version, links to what's new, says the bots stop for a minute or two and that the server goes back on its own if the new version doesn't start.
- One press updates the server: "Update the server". It asks first only when bots have work running, as that work stops. The same line then says how it is going: downloading, checking the download against the project's signature, getting it ready, restarting. While the server restarts, the connection line says "Updating your bots to {version}…", not that the connection was lost, and the app reconnects by itself.
- How it ended is said once in a toast, and shows in Settings until the operator closes it after: "Your bots run {version}", or that the update didn't go through and the bots are back on the version before, with their data as it was. A rollback stays in Settings, with why, its details and "Try again", for as long as the server runs the version it rolled back to.
- A server that cannot update itself from a client (started by hand, run from a source checkout, run inside the desktop app elsewhere) says so, with the one command to run on its machine instead. No button is ever offered that cannot work.
- Each side has a channel, Stable or Nightly, chosen in the same place: the server's for the server, the app's for the desktop app. Moving back to Stable never installs an older version: a nightly build stays until a stable release is newer, and Settings says so.
- The desktop app updates itself the same way, with "Restart to update" once the download has matched the project's signature. On this computer the app carries the bots' server, so updating the app updates both.
- When the app and the server speak different versions, the screen says which one is behind. A server behind the app offers "Update the server" right there, after asking it to look for a newer release once, as it may not have looked since this app's release came out; a server that cannot update from here gives the command to run on its machine; an app behind the server updates itself, or a browser reloads. The operator is never left on a broken screen.

## Screens

The interface is the same three regions on every surface. On a phone they are three screens; on a wide window they sit side by side.

### Roster

Answers: who do I have, who needs me, what is each of them doing.

- One row per bot and per room: avatar, name, time of last activity, one line of status or the last message.
- Rows that need the operator (a pending question or approval, an unread result) come first and are marked.
- Pinned bots stay at the top, as large avatars with their names; a room keeps its own pin, at the top of the list.
- The operator can group bots in named sections, in an order they choose, each one folded or open. A bot is in one section at most, and deleting a section never deletes its bots: they return to the list.
- Hidden bots keep running. They are left out of the list and reachable through search and through a "Hidden conversations" row at its end, which says how many there are and whether one has something unread, and lists them, each with Unhide.
- After the bots and rooms, a "Between bots" section lists each pair of bots that wrote each other, latest first: both avatars overlapped, "Scout and Wren", the last message with who said it ("Wren: …") and its time. It is not one of the operator's sections, and its rows are never unread, pinned or notified. A pair shows only while both bots are in the list, neither hidden nor deleted; the other bot's details still reach it.
- Each bot and room has a menu (right-click, the "…" or a long press) to mark it read or unread, pin it, move it to a section, make it the primary bot, hide it, and reach its details. The primary bot's avatar carries a small star wherever it appears.
- Search finds bots, rooms and messages, and pairs of bots by either name, a hidden bot's too.
- New bot and new room are one action each, and a new bot can start from a template file.

### Conversation

Answers: what did we say, what is it doing, what does it need from me.

- Messages as bubbles, the operator's on one side and the bot's on the other, with timestamps between groups.
- In a room, each bot's name stands over its run of messages and its avatar beside the last, as in a teammate conversation. The header shows the members' avatars, three at most and "+2" for the rest, the room's name and, under it, who is in it. While members answer, the room's last line names them ("Hal is answering…").
- In a bot's conversation, the header shows the bot's face and name on one line, with no line about what it is doing under it.
- Cards inline for what needs the operator (questions, approvals, credentials, a step in the bot's browser, a connector to add or sign in to) and for files.
- What only happened takes one quiet line, as small as a time between messages: messages with teammates ("Talked with Wren · 3 messages"), a routine created or changed ("Routine Morning digest created"; several in a row, "3 routines created"), the name a bot saved for the operator. Tapping one shows the rest: the teammate conversation, the routine, or the routines to pick from.
- A finished turn's work folds into one line ("Worked for 2m") that opens to show the steps.
- While the bot has a page open in its browser, a globe in the header, and a picture of the page under the turn under way, open the browser.
- A composer labeled with the bot's name, or the room's ("Message Support"). Attachments and dictation are in the composer; nothing else is. A file stands in the message where the operator put it ("compare [image] with [image]"), and the bot reads it there, numbered and named as in the harness's list of files. A tap on a file shows it: an image in a viewer, anything else in the app that opens it.

### Details

Answers: what is this bot, and what runs without me.

- Profile: name, title, avatar, job, with Share as template.
- Routines with their schedule, next run, last result, and a pause switch.
- Files the bot produced.
- Memory, readable and editable.
- Connectors this bot may use, each with its status, and a way to the connectors screen.
- Teammates: the teammate conversation with each bot it wrote or heard from, with the last message and its time, a deleted teammate's included.
- Model and permission mode.

### Outside those three

- **Command palette** on desktop and web: jump to a bot, a room or a message; run any action by name.
- **Settings**: engine and provider status, connectors, usage, the operator's name and time zone, devices, notifications, appearance, and about and updates: the server's version and channel, and in the desktop app, the app's.
- **Updates on the phone.** When the server or the app has an update, one quiet line over the roster says so, never a dialog. It opens Settings → About and updates, and hides until the next release. While the server updates, the same line shows how far it has come, its restart included, in place of the line that says the server cannot be reached. It then says once how the update ended. The app updates itself as it opens: with "Update automatically" on, the default, it downloads a newer release, checks it against the project's signature and installs it with no tap, while the same line says how far it has come and that the app closes to finish; Android installs it without asking where it allows that, and asks once otherwise. An update that does not go through says so in that line, once, and the app tries again the next time it opens. Turned off in Settings → About and updates, the app's update is a tap, and Android asks to install it. The first time, the app explains Android's "Install unknown apps" before it opens that page, and goes on when the operator comes back. A phone whose server speaks another protocol shows the side that is behind, with the update that brings it forward. A server behind the app is first asked to look for releases, so the phone says none is out yet only after it has looked. An app behind its server looks for its own release as the screen opens, and has its check and its channel there, since the server may run a nightly.

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
