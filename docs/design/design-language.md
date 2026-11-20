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
| Details | Right pane, 320 px, closed by default | Pane over the conversation, with a scrim that closes it | Pushed screen |

- The layout follows the width of the interface's own container, not the window's, so the same component lays out correctly in a narrow frame on a wide screen.
- The conversation text column has a maximum width; on a wide window the space goes to margins and the details pane, not to longer lines.
- The details pane opens from the bot's name in the conversation header, or from the pane button beside it.

### Keyboard and focus

| Action | Keys |
| --- | --- |
| Next and previous bot or room, in roster order | `Alt+↓`, `Alt+↑` (`⌥↓`, `⌥↑` on macOS) |
| Put the cursor in the composer | `/` |
| Stop the bot that is working | `Ctrl+.` (`⌘.` on macOS) |
| Close the details pane | `Escape` |
| Move through the roster | `↓` from the search field, then `↑`, `↓`, `Home`, `End` |

- Shortcut hints are shown where the action is: on the Stop button, and on the empty screen for the next-bot shortcut.
- Opening the details pane moves focus to its heading; closing it returns focus to the conversation title. Choosing another conversation with a mouse or keyboard puts the cursor in its composer; on touch screens it does not, so the keyboard does not cover the conversation. Loading a page moves focus nowhere.
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
| `avatar-ink` | `#ffffff` | `#0b0b0c` | The mark inside an avatar |
| `scrim` | black at 32% | black at 60% | Behind a pane or sheet that lies over content |

Destructive actions use `blocked`: there is no separate destructive red. Every text color reaches 4.5:1 on the fills it is used on, code reaches 4.5:1 inside both bubbles, and `waiting`, `blocked`, `success` and `accent` reach 3:1 on every canvas and on `muted`.

### Bot palette

Each bot has one color, chosen by the operator from ten: red, orange, yellow, green, teal, blue, indigo, violet, pink and gray. Each has a light and a dark value.

Ten hues cannot all have the same lightness and still be told apart by someone with a color vision deficiency: protanopia and deuteranopia collapse red, orange, yellow and green onto one axis. The palette therefore varies lightness on purpose and gives up equal perceived weight. What it guarantees instead, and what the tests check:

- every fill reaches 3:1 against `background`, `surface`, `sidebar` and `muted`, and against `avatar-ink`, so both the avatar's silhouette and its inner mark are legible (measured minimum 3.05 in light, 3.06 in dark);
- every pair of fills stays at least 0.085 apart in OKLab for typical vision and for protanopia, deuteranopia and tritanopia, simulated after Machado, Oliveira and Fernandes (2009) at full severity (measured minimum 0.088 in light and 0.115 in dark).

| Color | Light | Dark |
| --- | --- | --- |
| red | `oklch(0.441 0.179 29)` | `oklch(0.555 0.193 33)` |
| orange | `oklch(0.537 0.095 66)` | `oklch(0.682 0.132 57)` |
| yellow | `oklch(0.618 0.127 97)` | `oklch(0.79 0.162 94)` |
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
- A one-time nudge plays when the state changes, then the avatar is still apart from its state motion.
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
- Consecutive bubbles from one speaker within five minutes form a group: the corners between them, on the speaker's side, tighten to 4. A pause of more than fifteen minutes puts a time between entries.
- Borders are hairlines. Elevation is used for popovers and sheets only.
- Roster rows are 52 px on pointer devices and 64 px on touch.

## Motion

- Durations: 120 ms for hover and press feedback, 160 ms for a change of state, 200 ms for larger moves, all on `cubic-bezier(0.2, 0, 0, 1)`. State changes animate once and stop.
- Avatar state motion is stepped: the breathing ring changes 12 times in 2.4 s and the working arc 8 times in 1.6 s, instead of every frame, so a roster full of busy bots does not hold the display at full refresh rate.
- New messages appear in place; the list does not jump.
- Everything honors the platform's reduced-motion setting.

## Components

| Component | Notes |
| --- | --- |
| Roster row | Avatar, name, time, one status line; waiting and blocked lines are worded and colored; an unread dot. The line comes from the bot's state, else from the server's preview of the last entry: a card the bot still waits on reads in the present ("Asks: …"), an older one in the past ("Asked: …"). Order: pinned, then rows that need the operator, then most recent |
| Bubble | Operator and bot variants; groups; link and code styling. Under the operator's message, "Queued" while the bot has not received it, or why it never will |
| Composer | Pill, labeled "Message {name}", attachment and dictation; sends on Enter |
| Work fold | "Worked for {duration}"; opens to steps: commands, edits, searches, delegated tasks |
| Question card | Prompt, up to six options, optional free text; resolved state. An option the bot recommends says "Recommended"; one that loses something is drawn in `blocked` |
| Approval card | The exact action, Allow once, Allow for session, Deny |
| Credential card | What is asked for and why, a masked field, a link to get one when the bot gives a web address, Provide and Decline. Says the value is not kept; once answered, only what happened remains |
| File card | Name, type, size; opens a preview |
| Handoff card | "Asked Scout about …"; opens the exchange |
| Routine row | Name, schedule in words, next run, last result, pause switch |
| Presence line | One line under the bot's name in the conversation header: what it is doing now |
| Notice | One quiet line where something stopped: a failed turn (with Try again), a reply that did not arrive, a chain of bots that hit its budget, a bot waiting in its own conversation |
| Routine change | A card in the timeline when a routine is created, changed, paused, resumed or deleted |

## Words

Interface text follows the same rules as bot messages: plain, short, literal.

- Sentence case everywhere.
- A button says what it does to what: "Pause routine", not "Pause".
- Schedules are written out: "Weekdays at 8:47 AM", not a cron expression. A schedule with no plain sentence shows its expression. A single run gives its full date and time in the operator's time zone.
- Times use the language's own short style ("8:47 AM" in English, "08:47" in Portuguese) and the operator's time zone.
- Errors say what happened and what the operator can do.
- No exclamation marks, no mascot voice.

### Languages

Every interface sentence goes through the translation layer as a whole sentence with named placeholders. English is the source; Brazilian Portuguese is the first translation. A catalog that misses a key or drops a placeholder does not type-check. Plurals follow each language's rules. The language follows the browser unless the operator picks one in Settings, where each language is named in itself.

## Accessibility

- Text contrast of at least 4.5:1, and 3:1 for large text and interface marks, in both themes.
- State is never carried by color alone: the avatar's form or a mark changes too.
- Every action is reachable by keyboard on desktop and by screen reader on every platform, with the same name it has on screen.
- Touch targets are at least 44 pt; smaller controls extend their hit area on touch screens.
- Light and dark follow the system unless the operator picks one in Settings. The choice is applied before the first paint.

## Next steps for design

1. The command palette.
2. Image avatars, with state moved to the badge.
3. Notification visuals that use the still avatar.
4. The mobile theme, generated from the same tokens.
5. A virtualized conversation list once conversations grow long.
