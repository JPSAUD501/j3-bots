# Design language

**Status:** direction only. No mockups exist yet. Token values are starting points to be validated for contrast and on real screens.

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

| Region | Wide window | Tablet | Phone |
| --- | --- | --- | --- |
| Roster | Left column, 280 px | Left column | First screen |
| Conversation | Center, text column capped near 720 px | Center | Pushed screen |
| Details | Right pane, 320 px, closed by default | Sheet | Pushed screen |

- The conversation text column has a maximum width; on a wide window the space goes to margins and the details pane, not to longer lines.
- The details pane opens from the bot's name in the conversation header.
- On desktop the command palette is `Cmd/Ctrl+K`. New message focus, next and previous bot, and stop each have a shortcut.

## Color

Neutrals carry the interface. One accent marks focus and links. Semantic colors mark state. A separate palette belongs to bots.

### Interface tokens (starting values)

| Token | Light | Dark |
| --- | --- | --- |
| `background` | `#fcfcfc` | `#000000` |
| `surface` (cards, popovers) | `#ffffff` | `#0e0e0f` |
| `sidebar` | `#f5f5f5` | `#070707` |
| `border` | `#e4e4e7` | white at 8% |
| `foreground` | `#18181b` | `#f4f4f5` |
| `muted-foreground` | `#71717a` | `#a1a1aa` |
| `bubble-user` | `#18181b` on it `#fafafa` | `#f4f4f5` on it `#09090b` |
| `bubble-bot` | `#f1f1f3` | `#18181b` |
| `accent` | a blue near `oklch(0.49 0.22 264)` | the same hue, lighter |
| `waiting` | amber | amber |
| `blocked`, `destructive` | red | red |
| `success` | emerald | emerald |

### Bot palette

Each bot has one color, chosen by the operator from a fixed set of about ten hues. The set is built so that any two are distinguishable for the common forms of color blindness, and each hue has a light-mode and a dark-mode value with the same perceived weight. The exact values are a design task.

## Avatars

The avatar is the most important element on screen: it is how the operator recognizes a bot at a glance and how they read its state.

Requirements:

- Recognizable at 24 px in a list and expressive at 96 px in a profile.
- Built from two choices the operator makes, a **shape** and a **color**, so that a roster of ten bots has ten distinct silhouettes.
- Carries the six states (idle, thinking, working, waiting, blocked, done) through its own form or motion. Done is an idle bot with something unread.
- Works as a still image for notifications and for reduced-motion settings; state is then shown by a small mark.
- An operator may replace it with an image; state then falls back to the small mark.

J3 Bots needs **its own** avatar system. Existing products use friendly blob characters with eyes; J3 Bots must not resemble them. The direction to explore first is abstract and geometric: a solid shape in the bot's color with a single inner mark, where state changes the mark (a slow pulse for thinking, a rotating segment for working, a notch for waiting, a break for blocked). This needs real exploration at small sizes before it is settled.

## Typography

- **Interface:** the platform's system font, with Inter Variable as the web fallback. No display face.
- **Code and identifiers:** the platform's monospace.
- **Scale:** 11, 12, 13, 14, 16, 20. Message text is 14 on desktop and 16 on phones. Metadata (times, statuses) is 11 or 12.
- **Weight:** regular and medium. Bold is rare.
- Message text sets no line longer than about 70 characters.

## Shape and space

- A 4 px spacing grid.
- Radius 8 for controls and cards. Bubbles are rounder (16), with the corner nearest the speaker tightened. The composer is a pill.
- Borders are hairlines. Elevation is used for popovers and sheets only.
- Roster rows are 52 px on pointer devices and 64 px on touch.

## Motion

- State changes animate once, in 120 to 200 ms, and stop.
- Avatar state motion is slow and low duty: it must not hold the display at full refresh rate.
- New messages appear in place; the list does not jump.
- Everything honors the platform's reduced-motion setting.

## Components

| Component | Notes |
| --- | --- |
| Roster row | Avatar, name, time, one status line; a marked variant for "needs you" |
| Bubble | Operator and bot variants; groups; link and code styling |
| Composer | Pill, labeled "Message {name}", attachment and dictation; sends on Enter |
| Work fold | "Worked for {duration}"; opens to steps: commands, edits, searches, delegated tasks |
| Question card | Prompt, up to six options, optional free text; resolved state |
| Approval card | The exact action, Allow once, Allow for session, Deny |
| File card | Name, type, size; opens a preview |
| Handoff card | "Asked Scout about …"; opens the exchange |
| Routine row | Name, schedule in words, next run, last result, pause switch |
| Presence line | One line under the bot's name in the conversation header: what it is doing now |
| Budget notice | One quiet line where a chain was stopped |

## Words

Interface text follows the same rules as bot messages: plain, short, literal.

- Sentence case everywhere.
- A button says what it does to what: "Pause routine", not "Pause".
- Schedules are written out: "Weekdays at 8:47", not a cron expression.
- Errors say what happened and what the operator can do.
- No exclamation marks, no mascot voice.

## Accessibility

- Text contrast of at least 4.5:1, and 3:1 for large text and interface marks, in both themes.
- State is never carried by color alone: the avatar's form or a mark changes too.
- Every action is reachable by keyboard on desktop and by screen reader on every platform, with the same name it has on screen.
- Touch targets are at least 44 pt.

## Next steps for design

1. Avatar exploration: shapes, the state system, small-size legibility.
2. The three core screens as static mockups in both themes, phone and desktop.
3. The bot palette with measured contrast and distinguishability.
4. The card set.
