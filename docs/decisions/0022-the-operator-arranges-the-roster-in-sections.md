# 0022: The operator arranges the roster in sections the server keeps

**Status:** Proposed

## Context

An operator with a dozen bots wants to group them: work and home, a project's bots together, the ones checked daily apart from the ones that run alone. The roster already has two ways to arrange it, pinning and hiding, both stored on the bot by the server, so every device shows the same list. Grouping is a third, and the first that is a thing of its own, with a name and an order, rather than a flag on a bot.

The protocol is at version 7, and the installed Android app does not update itself. Raising the version for this would lock every installed client out of a newer server until it updates ([Protocol compatibility](../architecture/clients.md#protocol-compatibility)).

## Decision

**A section is a named group of bots that the server keeps, in an order the operator sets.**

- **Flat, and only bots.** A section holds bots, each bot in at most one, and nothing nests. Rooms keep their own pin and stay out of sections: a room's members already group it, and a room in a section would make a bot's section say less.
- **On the server.** Sections, their order and each bot's section are in the database (`sections`, `bots.section_id`, migration 22), changed by commands with receipts, and sent with the roster: the snapshot carries every section in order, and a change carries them all again when any changed. They are few, and a move renumbers them all, so sending the list whole is simpler than a delta and keeps the contract's rule that changes carry whole entities.
- **Deleting a section keeps its bots.** The database moves them out (`ON DELETE SET NULL`), and each is sent as a changed bot. A section never owns a bot's life.
- **Folding is the device's.** Whether a section is folded is a view of the moment, flipped often, and kept per device like a window's size, not sent to the server.
- **Sections only arrange the roster.** Pinning, hiding and unread work as before: a pinned bot shows at the top whatever its section, and a hidden one stays hidden in it. Nothing a bot does, and nothing a bot is told, depends on its section.
- **No version bump.** Every field is new and optional: an older client drops `sections` and `sectionId` and lists every bot as before. A roster snapshot that carries `sections` tells a newer client the server has sections, and the client offers them only then, so it never calls the new commands on an older server.

The same change adds **Mark as unread** (`entries.markUnread`), behind the same signal. It moves the read mark back to just before the last entry a bot wrote, rather than storing an "unread" flag beside the mark: unread keeps one source of truth, and the read that opening the conversation sends clears it with no new rule.

## What it costs

- A table, a column and three commands to maintain, and one more thing every client draws.
- The capability signal is a convention, not a version: a later feature that wants the same treatment needs its own field in data the client reads first.
- A device that folds a section does not fold it on the others.

## What was rejected

- **Sections on each device.** Free to build and needing no protocol, but the operator would arrange the roster again on every device, unlike pins and hidden bots.
- **Tags, a bot in several groups.** More flexible, and the roster would show a bot several times or need rules for which group wins. One section per bot matches how the operator reads the list: once, top to bottom.
- **Nested sections, or rooms in sections.** Neither was asked for, and both make the roster harder to scan on a phone.
- **A manual order of bots inside a section.** The roster's order (what needs the operator, then the latest activity) already places them; a second order would fight it.
- **A protocol bump.** It would protect nothing an older client can see, and would lock installed apps out of every newer server.
