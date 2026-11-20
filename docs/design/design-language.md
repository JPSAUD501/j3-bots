# Design language

**Status:** the tokens, the avatar system and the core web components exist. The values below are the ones in [`packages/design-tokens`](../../packages/design-tokens/src/tokens.ts), and the contrast and distinguishability figures are checked by its tests. The web client's development build has a gallery at `/gallery` that shows every component in every state, in both themes; it is the place to review the design, and it is not part of a production build.

## Two references, one product

J3 Bots' interface is a deliberate mix of two existing designs. Both are described here in words; neither's assets are reproduced.

**From persistent-agent products (xAI's Grok Bot is the clearest example):** the interface of a messaging app, organized around who you are talking to.

- The sidebar is a roster of named teammates, not a history of chats. Each row is an avatar, a name, a time, and one line that reads like a status update from a person.
- The avatar is the presence indicator. It changes with what the bot is doing, so there is no separate spinner or status badge.
- Conversations are bubbles. The operator's are dark and right-aligned, the bot's are light and left-aligned, grouped, with timestamps between groups.
- The chrome is almost monochrome. Color belongs to the bots.
- Structured answers arrive as cards in the same timeline as prose.
- A side pane shows what the bot is and what runs without you: its routines.
- Controls that do not help the operator delegate are removed.

**From T3 Code:** the precision and density of a developer tool.

- A true-black dark canvas and near-white light canvas, zinc neutrals, hairline borders, small radii.
- A dense type scale with steps below 12 px for metadata.
- A finished turn's work folds into one line ("Worked for 2m") that opens to show each step.
- A command palette that reaches every action, and a shortcut for everything.
- Semantic color tokens as CSS variables with a light and a dark value each.
- Components in a `ui` layer own their look; callers choose a variant.
- No animation that repaints continuously.

**The synthesis.** J3 Bots looks like a messaging app and behaves like a professional tool. Messaging gives the structure: roster, bubbles, presence. The developer tool gives the manner: density, restraint, keyboard reach, and work that is always inspectable but never in the way.

## Principles

1. **Who before what.** Every screen starts from a bot. There is no screen that lists tasks, runs or sessions as first-class things.
2. **One line of truth.** Each roster row carries one line: what the bot last said, or what it is doing now, or what it needs. The row that needs the operator is visibly different from the rest.
3. **Work is available, not present.** The steps of a turn are one tap away and never open by themselves.
4. **Color means someone or something.** A color on screen is a bot's identity or a state (waiting, blocked, error). Decoration does not use color.
5. **Quiet motion.** Motion marks a change of state and then stops. Nothing loops at full frame rate.
6. **Same words everywhere.** A bot, a room, a routine, a card: the same nouns on every surface and in every prompt.

## Layout

Three regions, the same on every surface.

| Region | Wide (1200 px and up) | Tablet (768 to 1199 px) | Phone (below 768 px) |
| --- | --- | --- | --- |
| Roster | Left column, 280 px | Left column, 280 px | First screen |
| Conversation | Center, text column capped at 720 px | Center | Pushed screen |
| Details | Right pane, 320 px, closed by default, beside the conversation | Modal dialog over the conversation, with a scrim that closes it | Modal dialog that covers the screen |

- The layout follows the width of the interface's own container, not the window's, so the same component lays out correctly in a narrow frame on a wide screen.
- The conversation text column has a maximum width; on a wide window the space goes to margins and the details pane, not to longer lines.
- The details pane opens from the bot's name in the conversation header, or from the pane button beside it. On a phone the name carries a chevron, because there is no pane button.
- Below the wide layout the details pane is a modal dialog: the roster and the conversation behind it are inert, focus is trapped inside it, the dialog handles `Escape`, and the conversation's shortcuts wait until it closes. At the wide layout it sits beside the conversation, nothing else is blocked, and `Escape` closes it from anywhere in the shell.
- On phones every region keeps clear of the screen's safe areas (the notch, rounded corners and home indicator) on the edges it touches, in portrait and landscape.

### Keyboard and focus

| Action | Keys |
| --- | --- |
| Next and previous bot or room, in roster order; with none open, the first or the last | `Alt+↓`, `Alt+↑` (`⌥↓`, `⌥↑` on macOS) |
| Put the cursor in the composer | `/` |
| Stop the bot that is working | `Ctrl+.` (`⌘.` on macOS) |
| Close the details pane, before anything else | `Escape` |
| Move through the roster | `↓` from the search field, then `↑`, `↓`, `Home`, `End` |

- Shortcut hints are shown where the action is: on the Stop button, and on the empty screen for the next-bot shortcut. Touch screens show neither. Only a coarse pointer hides anything: with no pointer at all, as with a keyboard alone or a TV remote, every hint and the inline "Waiting for you" stay.
- The roster's arrow keys are unmodified ones; `Alt+↑` and `Alt+↓` pass through it to the shell.
- Opening the details pane moves focus to its heading; closing it on the same conversation, by any route, returns focus to the conversation title. Choosing another conversation with a mouse or keyboard puts the cursor in its composer; on touch screens it does not, so the keyboard does not cover the conversation. When the details close because another conversation was chosen, the move wins and focus follows it. Loading a page moves focus nowhere.
- Each conversation opens at its own newest entry, never where the previous one was scrolled to.
- A command palette (`Cmd/Ctrl+K`) that reaches every action is planned and not built yet.

## Color

Neutrals carry the interface. One accent marks focus and links. Semantic colors mark state. A separate palette belongs to bots.

### Interface tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `background` | `#fcfcfc` | `#000000` | The canvas |
| `surface` | `#ffffff` | `#0e0e0f` | Cards, popovers, the composer |
| `sidebar` | `#f5f5f5` | `#070707` | The roster |
| `muted` | `#ebebed` | `#18181a` | Hover and selection fills, quiet controls |
| `border` | `#e4e4e7` | white at 9% | Hairlines |
| `input` | `#d4d4d8` | white at 14% | Borders of fields and outline buttons |
| `foreground` | `#18181b` | `#f4f4f5` | Text |
| `muted-foreground` | `#67676f` | `#a1a1aa` | Metadata, secondary text |
| `bubble-operator` | `#18181b`, text `#fafafa` | `#f4f4f5`, text `#09090b` | The operator's bubbles |
| `bubble-bot` | `#f0f0f2`, text `#18181b` | `#18181b`, text `#f4f4f5` | Bots' bubbles |
| `code-background` | black at 6% | white at 8% | Inline code and code blocks, over any fill |
| `accent` | `oklch(0.49 0.22 264)` | `oklch(0.72 0.15 264)` | Focus rings, links, unread |
| `waiting` | `oklch(0.52 0.12 65)` | `oklch(0.82 0.15 80)` | A bot needs the operator |
| `waiting-surface` | `oklch(0.975 0.03 85)` | `oklch(0.21 0.045 70)` | Header of a card awaiting the operator |
| `blocked` | `oklch(0.53 0.2 27)` | `oklch(0.71 0.17 25)` | A turn cannot continue; destructive actions |
| `blocked-surface` | `oklch(0.975 0.015 20)` | `oklch(0.2 0.05 25)` | |
| `success` | `oklch(0.52 0.12 160)` | `oklch(0.78 0.14 160)` | A routine that is on |
| `control-off` | `#82828a` | `#6b6b73` | A switch that is off; the boundary of an empty checkbox or radio |
| `avatar-ink` | `#ffffff` | `#0b0b0c` | The mark inside an avatar |
| `scrim` | black at 32% | black at 60% | Behind a pane or sheet that lies over content |

Destructive actions use `blocked`: there is no separate destructive red. Every text color reaches 4.5:1 on the fills it is used on, code reaches 4.5:1 inside both bubbles, and `waiting`, `blocked`, `success`, `accent` and `control-off` reach 3:1 on every canvas and on `muted`. Text is never drawn with a text token at reduced opacity, since that would put it below the measured contrast.

### Bot palette

Each bot has one color, chosen by the operator from ten: red, orange, yellow, green, teal, blue, indigo, violet, pink and gray. Each has a light and a dark value.

Ten hues cannot all have the same lightness and still be told apart by someone with a color vision deficiency: protanopia and deuteranopia collapse red, orange, yellow and green onto one axis. The palette therefore varies lightness on purpose and gives up equal perceived weight. What it guarantees instead, and what the tests check:

- every fill reaches 3:1 against `background`, `surface`, `sidebar` and `muted`, and against `avatar-ink`, so both the avatar's silhouette and its inner mark are legible (measured minimum 3.05 in light, 3.06 in dark);
- every pair of fills stays at least 0.085 apart in OKLab for typical vision and for protanopia, deuteranopia and tritanopia, simulated after Machado, Oliveira and Fernandes (2009) at full severity (measured minimum 0.088 in light and 0.115 in dark).

| Color | Light | Dark |
| --- | --- | --- |
| red | `oklch(0.441 0.179 29)` | `oklch(0.555 0.193 33)` |
| orange | `oklch(0.535 0.11 72)` | `oklch(0.682 0.132 57)` |
| yellow | `oklch(0.621 0.125 86)` | `oklch(0.79 0.162 94)` |
| green | `oklch(0.401 0.091 159)` | `oklch(0.812 0.104 149)` |
| teal | `oklch(0.61 0.102 206)` | `oklch(0.708 0.093 189)` |
| blue | `oklch(0.516 0.124 243)` | `oklch(0.596 0.217 271)` |
| indigo | `oklch(0.322 0.193 281)` | `oklch(0.72 0.151 295)` |
| violet | `oklch(0.622 0.183 295)` | `oklch(0.523 0.148 298)` |
| pink | `oklch(0.451 0.136 336)` | `oklch(0.584 0.094 349)` |
| gray | `oklch(0.532 0 0)` | `oklch(0.93 0 0)` |

Color is never the only thing that tells two bots apart: the shape does too.

## Avatars

The avatar is the most important element on screen: it is how the operator recognizes a bot at a glance and how they read its state.

Requirements:

- Recognizable at 24 px in a list and expressive at 96 px in a profile.
- Built from two choices the operator makes, a **shape** and a **color**, so that a roster of ten bots has ten distinct silhouettes.
- Carries the six states (idle, thinking, working, waiting, blocked, done) through its own form, with motion only as an addition. Done is not a state the server reports: it is an idle bot with something unread.
- Works as a still image for notifications and for reduced-motion settings.

J3 Bots has **its own** avatar system. Existing products use friendly blob characters with eyes; J3 Bots does not resemble them. An avatar is a solid geometric shape in the bot's color with a single inner mark in `avatar-ink`. The shape is the bot's identity; the mark is its state.

**Shapes.** Ten, drawn on a 100 × 100 grid with softened corners: circle, square, hexagon, diamond, triangle, clover, burst, arch, plus and leaf. The mark sits at each shape's visual center, which is lower than the box's center for the triangle and the arch.

**States.**

| State | Mark | Motion | Corner badge |
| --- | --- | --- | --- |
| Idle | A small dot | None | None |
| Thinking | A ring | Breathes: grows and shrinks slowly | None |
| Working | An open arc | Turns | None |
| Waiting | A notched ring, open at the top | None | `waiting` |
| Blocked | A ring with a slash | None | `blocked` |
| Done (idle, with something unread) | A check | None | `accent` |
| Stalled (thinking or working with no activity) | A dotted ring | None: a stuck turn stops moving | None |

- Every state has its own mark, so the avatar reads with motion off. The still form is the same drawing with the motion removed; there is no separate "small mark" for still use.
- The waiting and blocked badges carry the color that matches the roster line's wording, so state is never carried by color alone.
- Small avatars (28 px and under) draw the mark 30% larger so it stays legible.
- When the state changes, the avatar nudges once and the new mark eases in; then it is still apart from its state motion. Nothing plays when an avatar first appears, so opening a screen does not set every avatar moving.
- A room's avatar overlaps the shapes of its first two members.

**Image avatars** are not available yet: the contract's avatar is a shape and a color only. When images are added, state moves to the corner badge and a ring around the image.

## Typography

- **Interface:** the platform's system font, with Inter Variable as the web fallback. No display face.
- **Code and identifiers:** the platform's monospace.
- **Scale:** 11, 12, 13, 14, 16, 20 px, with line heights of 16, 16, 18, 20, 24 and 28. Message text is 14 on pointer devices and 16 on touch screens. Metadata (times, statuses) is 11 or 12. Tailwind's own scale is removed, so only these sizes exist.
- **Weight:** regular (400) and medium (500). Semibold (600) is rare.
- Message text sets no line longer than about 70 characters.

## Shape and space

- A 4 px spacing grid.
- Radii: 4 for badges and a bubble's tightened corner, 8 for controls and cards, 12 for popovers and sheets, 16 for bubbles, and a pill for the composer and round buttons.
- Consecutive bubbles from one speaker within five minutes form a group: the corners where two bubbles meet, on the speaker's side, tighten to 4. A bubble on its own keeps all four corners round. A pause of more than fifteen minutes puts a time between entries.
- Entry widths are layout tokens: a bubble takes up to 36 rem or 85% of the column, a card up to 36 rem or 92%, and the compact handoff and routine-change cards up to 28 rem. On a phone a card that asks the operator for something (a question, an approval, a credential) takes the full column. The composer grows with its text up to 15 rem, then scrolls.
- Borders are hairlines. Elevation is used for popovers and sheets only.
- A filled area inside a bordered box, such as the header of a card awaiting the operator, rounds its corners to the box's radius less the border, so the fill follows the box's outline.
- Roster rows are 52 px on pointer devices and 64 px on touch.

## Motion

- Durations: 120 ms for hover and press feedback, 160 ms for a change of state, 200 ms for larger moves, all on `cubic-bezier(0.2, 0, 0, 1)`. State changes animate once and stop.
- Avatar state motion is stepped: the breathing ring changes 12 times in 2.4 s and the working arc 8 times in 1.6 s, instead of every frame, so a roster full of busy bots does not hold the display at full refresh rate.
- New messages appear in place; the list does not jump.
- Everything honors the platform's reduced-motion setting.

## Components

| Component | Notes |
| --- | --- |
| Roster row | Avatar, name, time, one status line; waiting and blocked lines are worded and colored. A usage limit leads with its reset, since the line is cut short: "Limit resets at 4:15 PM", or "Usage limit reached" when the reset is unknown; the conversation header and the provider list keep the whole sentence. Unread shows once: as the avatar's done badge, or, for a row whose avatar shows another state, as a dot under the time; the time itself stays muted, and screen readers hear "Unread" either way. The line comes from the bot's state, else from the server's preview of the last entry: a card the bot still waits on reads in the present ("Asks: …"), an older one in the past ("Asked: …"). Only a stand-in for something absent, such as "No messages yet", is italic. Order: pinned, then rows that need the operator, then most recent |
| Bubble | Operator and bot variants; groups; link and code styling. In a room, a bot's group is labeled with its name beside a 20 px drawing of its shape, which carries identity only, never state. Under each of the operator's messages the bot has not received yet, "Queued", or why it never will. That line's text is a status region from the moment the message is queued, so a failure is announced once, and "Send again", beside it, is not read as part of it; a delivered message leaves it empty, taking no room. One whose delivery failed says what follows in the blocked color: refused by the engine, or perhaps delivered, so sending again may repeat the work. "Send again" sits at the line's size, its text ending where the other lines end. While a retry is on its way the line reads "Queued" again and "Send again" takes no second press (`aria-disabled`, so focus stays on it); once sent, focus moves to the message, which stays whatever its line then says, even nothing. A message still on this device reads "Sending…" until the server has it, through disconnections and reloads; one the server refused, or that a signed-out device could not send, says why, with "Send again" and "Delete" |
| Composer | Pill, labeled "Message {name}", with a button to attach files and dictation where the platform has it; sends on Enter. While its field has keyboard focus, the whole pill carries the `accent` focus outline. Files picked, pasted or dropped upload at once and sit above the pill as chips: progress while uploading, the size once uploaded, or in `blocked` why the file cannot go (over the server's limits, refused), each with a button to remove it. The message goes once every file has uploaded; until then the send button takes no press (`aria-disabled`) and its name says it sends after the upload. Only a file that cannot go is announced. What is typed and uploaded is kept per conversation, across reloads, until sent |
| Work fold | "Worked for {duration}"; opens to steps: commands, edits, searches, delegated tasks. Long commands wrap; nothing is shown only in a hover title |
| Code block | In the approval card and the work fold, each line of code is its own block with a hanging indent: leading spaces stay, a wrapped line continues indented under itself, and selecting the block copies the text exactly as given. Long words break anywhere rather than overflow. In a file change's diff, added lines take a `success` tint, removed lines a `blocked` tint and hunk headers are muted; the `+` and `-` stay, so the tint is never the only mark, and the text is untouched, so copying is too. A block that scrolls shows a soft shade at each edge with more past it, in CSS alone, so touch screens, which hide scroll bars, show it too |
| Question card | Prompt, up to six options, optional free text; resolved state. On a question the bot asked with `ask`, once an option is chosen the text field reads "Add a note to your answer", because both are sent. A question from the harness's own tool takes one or the other, as its engine does: the field reads "Or type an answer", typing clears the chosen option and choosing clears the text. A single question with one choice and no typed answer is answered by tapping an option; anything else is a form of radios, checkboxes and text, sent with "Send answer". An option the bot recommends says "Recommended"; one that loses something is drawn in `blocked` and says "Loses something". Dismissing reads "Dismiss as a no", because that is what the bot receives |
| Approval card | Allow once (primary), Allow for session, Deny (outline, as neutral as Allow for session). What the bot asks is always on the card, exactly as the engine recorded it: the whole command, every line and its indentation, in a block that scrolls when long; or a file change's path, then, past a seam of the card's surface, its diff, which alone scrolls, so the path stays in view. Every scrolling block can be scrolled from the keyboard. Why it asks, when the provider said (an escalation out of the sandbox, say), is a quiet line above, never mixed into the action. When the provider shared only a summary, the card says so ("The exact command wasn't shared, only a summary"), sets the summary as prose rather than code, and offers Deny and Allow once but not Allow for session: a bot never stalls on such a provider, and nothing unseen is granted beyond once. The engine adapter decides that (`sessionGrant`); the card offers what the entry says. Allow for session is offered only where what it covers is established: a provider that applies a rule of its own, which may change its permission mode, is offered Deny and Allow once. Under the buttons, a quiet line says what Allow for session allows from then on, in words, starting with the button's name, so on a phone it never reads as the consequence of the full-width Allow once above it; the button is described by it: "Choosing Allow for session will allow all future command requests in this session automatically". A card allowed for the session keeps that scope under "Allowed for this session", in the past: "Future command requests in this session will be allowed automatically". While a decision is on its way the buttons stay where they are and take no second one (`aria-disabled`, so focus stays on the one pressed); once decided, focus that was on a button or in the diff, which folds away, moves to the card, and the card is described by how it ended ("Allowed once", "Denied", "This request expired before it was answered."), so focus on it reads the result. A summary is a region of its own, "Approval summary". While the card waits, the summary can give way to the exact action once the engine has it; focus that was in the summary moves to the action that replaces it, and focus anywhere else stays where it is. Once decided, the card keeps the action, a summary keeps a quiet "Summary" above it, and a diff folds away behind "Show the change", or "Show the file" for a new or deleted file's contents. A diff's added and removed lines are tinted across the block's whole width; its `@@` headers are quiet, and so are `---` and `+++` where they are file headers, outside a hunk: inside one, `----` is a removed line. On a phone the buttons share each row they wrap onto, so they read as one group |
| Credential card | What is asked for and why, a masked field, a link to get one when the bot gives a web address, Provide and Decline. Says the value is not kept; the typed value exists only while the card is pending, and once answered only what happened remains |
| File card | Name, type, size. Opens in a new tab when the browser shows its type without running script (PDF, images, plain text); any other file is downloaded |
| Handoff card | "Asked Scout about …"; opens the exchange |
| Routine row | Name, schedule in words, next run, last result with the run count in one sentence ("Last run reported back yesterday at 8:47 AM · 18 runs"), whose last three words never break apart, pause switch. A failed run draws only its failure in `blocked`; the run count stays muted |
| Presence line | One line under the bot's name in the conversation header: what it is doing now. "Waiting for you" is a button that moves to the card the bot waits on: underlined in the line, and on touch screens a separate 44 px button with an arrow at the end of the header instead, apart from the name that opens the details. On a phone the block with the name, which opens the details, is a 44 px target too. Screen readers hear a change of state once, when it happens, not every time the line is read |
| Delete confirmation | Opened from the last section of the details, alone below a hairline, apart from "Start fresh". A dialog that names the bot, says its conversation, memory and routines are deleted for good and that files in its workspace are kept. "Keep {name}" has focus; the bot is deleted only after the destructive button is pressed |
| First run | Lists each provider with an accurate state ("Ready", "Not signed in", "Usage limit reached, resets …", "Not available right now"). A limited provider uses the same sentence as a blocked bot, with the day when the reset is not today. A provider that needs signing in shows the command to run on the host, wrapped to read in full, with a copy button pinned to its corner; where the page has no clipboard, as over plain HTTP on the local network, or the browser refuses, the button selects the command and says, visibly and to screen readers, "Command selected. Copy it manually." Creating the first bot opens its conversation. An engine that is not running or not reachable says why and what the operator can do: it is being restarted, its port is taken by another program, it could not be installed, or it refused J3 Bots' credential |
| Pairing | The first screen on a new device: the ensemble of avatars, the code from `j3-bots pair` and a name for the device, guessed from the browser. A wrong or expired code is selected, ready to type again; after too many, the screen says when pairing opens again and opens it by itself then; a server of another version offers Reload. A device signed out elsewhere says so above the form. Pairing opens the app at once |
| Connection line | One quiet line above the whole app while the server is out of reach: offline, reconnecting, the connection lost, or the server not reached, with a countdown to the next try and "Try now". The sentence is announced once; the countdown is not. Everything on screen stays, marked by the line rather than cleared. Connected, it takes no room |
| Settings | A dialog opened from the roster's footer, the whole screen on a phone. The engine (its version, or what is wrong), the operator's name and time zone, devices (each with its last activity; revoking one asks first; "Pair another device" shows a code and when it expires) and this browser (appearance, language, and signing out, which asks first) |
| Notice | One quiet line where something stopped: a failed turn (with Try again), a reply that did not arrive, a chain of bots that hit its budget (a pause mark), a bot waiting in its own conversation, a bot that lost its working context, and a conversation that may be behind because J3 Bots could not apply what the engine reported. Notices are not announced; the conversation header's live region is |
| Routine change | A card in the timeline when a routine is created, changed, paused, resumed or deleted |

Question, approval and credential cards take a submitting state: while the operator's answer is on its way, their controls take no second answer but stay focusable (`aria-disabled` buttons, read-only fields), so focus stays where it was. Once answered, focus that was in the controls moves to the card, and the card is described by the line that says how it closed, so a screen reader announces the outcome with it.

## Words

Interface text follows the same rules as bot messages: plain, short, literal.

- Sentence case everywhere.
- A button says what it does to what: "Pause routine", not "Pause".
- Schedules are written out: "Weekdays at 8:47 AM", not a cron expression. An interval reads as one ("Every 15 minutes", "Every 6 hours at minute 00") only when it divides the hour or the day evenly; `*/7` minutes runs at :56 and again at :00, so it is not "every 7 minutes". A schedule with no plain sentence shows its expression. A schedule kept in another time zone names it, hourly ones included: "Every Monday and Thursday at 9:00 AM (Western European Time)", "Every hour at minute 15 (India Standard Time)". A single run gives its full date and time in the operator's time zone, and "Next run" is always in the operator's time zone.
- Times use the language's own short style ("8:47 AM" in English, "08:47" in Portuguese) and the operator's time zone. A time of day never breaks across lines: the space inside "8:47 AM" is a no-break space wherever a time appears, a full-width one, since the narrow one some runtimes use is set too thin at small sizes to read as a gap, in rosters, schedules, last runs and notices. A time standing alone reads "Yesterday at 1:40 PM"; inside a sentence it has its own form ("yesterday at 1:40 PM", "at 8:47 AM", "on Nov 13, 2026, 4:30 PM"), so no capital lands mid-sentence.
- Errors say what happened and what the operator can do.
- No exclamation marks, no mascot voice.

### Languages

Every interface sentence goes through the translation layer as a whole sentence with named placeholders. English is the source; Brazilian Portuguese is the first translation. A catalog that misses a key or drops a placeholder does not type-check. Plurals follow each language's rules. The language follows the browser unless the operator picks one in Settings, where each language is named in itself.

## Accessibility

- Text contrast of at least 4.5:1, and 3:1 for large text and interface marks, in both themes.
- State is never carried by color alone: the avatar's form or a mark changes too.
- Every action is reachable by keyboard on desktop and by screen reader on every platform, with the same name it has on screen.
- Touch targets are at least 44 px. On touch screens a compact control grows to a real 44 px box, so controls that sit side by side or wrap onto a second line never cover one another; pointer devices keep the compact size. Menu rows, such as New, do the same.
- Light and dark follow the system unless the operator picks one in Settings. The choice is applied before the first paint.

## Next steps for design

1. The command palette.
2. Image avatars, with state moved to the badge.
3. Notification visuals that use the still avatar.
4. The mobile theme, generated from the same tokens.
5. A virtualized conversation list once conversations grow long.
