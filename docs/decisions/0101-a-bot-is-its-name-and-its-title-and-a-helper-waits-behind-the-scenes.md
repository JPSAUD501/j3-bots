# 0101: A bot is its name and its title, and a helper waits behind the scenes

**Status:** Accepted. Amends [0050](0050-bots-and-rooms-are-visible-or-hidden-and-the-operators-choice-wins.md) and the naming rule of the bots' tools.

## Context

Bots have had people's names since 0.8: "Bia", "Davi", not "Bakery Watcher". A name says who a teammate is, not what they do, and a roster of first names leaves the operator guessing which one follows the bakeries. Every bot already had a title in its profile, but it was optional, a bot creating teammates rarely gave one, and the apps showed it only in the details.

Hiding, from 0050, worked as designed, but its words did not fit what it was for. "Hidden" sounds like something kept from the operator, when the point is a helper working out of the way, one tap from the list. And a helper another bot made said hello as every new bot does, so the operator was greeted by something they had not asked to see and that had nothing to ask them.

## Decision

**Wherever the apps name a bot as a person, they show its name over its title, as a team chat shows a colleague's name over their job title.** The roster row has the name with its time, the title in muted text (two lines at most, then an ellipsis), then the status line; the header has the title under the name; a room's sender reads "Name · Title"; the mentions list, teammate lists, room member lists, quick access and notifications carry the same pair. A bot with no title shows its name alone, and its menu offers "Give a title", which opens its edit form at the title.

**A title is required and short.** `create_bot` takes `title`, two to four words in the operator's language with no tool, model or AI word, and refuses one that is missing or blank. The apps' New bot form requires it, a template whose bot had none asks for one, and an edit cannot empty a title once set. The primary bot the apps create is titled "Main assistant" ("Assistente principal"). `update_bot` and `update_profile` take a title, so the primary bot can title bots made before this. The tools' naming rule gains the title: the name makes the bot a person, the title says why it exists, and the titles of bots made together say how their work differs.

**"Behind the scenes" replaces "hidden" in everything the operator reads,** and in the bots' tools. `create_bot` and `start_room` take a required `listed: boolean`, and `set_visibility` is now `set_listed` with `{ id, listed }`, so a bot decides each time where what it makes goes instead of forgetting an optional flag. The roster's last row reads "Behind the scenes · N" ("Nos bastidores · N"); the actions are "Move behind the scenes" and "Bring back to the list". Everything else 0050 decided stands: out of the list, not out of reach or out of the notifications, and the operator's choice wins.

**A helper made behind the scenes says no hello.** A bot another bot creates with `listed: false` gets no `first-run` wake; it waits for its maker or a room to give it work. A bot the operator makes behind the scenes still greets them, since its hello asks what it is for.

**The wire keeps `hidden`.** `Bot.hidden`, `Room.hidden`, the app's payloads, the columns and the `set_visibility` receipt keep their names, and `title` stays optional in `bot.create`: protocol 11 does not change, and an older client still creates a bot. Only the bots' tools say `listed`, since they are read by a model, which follows a word that says what it does.

## What it costs

- Roster rows are no longer one height: a title of two lines makes a row taller. Android, whose list needs each row's height before drawing it, measures titles out of sight at the list's width.
- Bots made before a title was required have none until the operator or the primary bot gives one; they show their names alone meanwhile.
- Two names for one flag: `listed` for bots, `hidden` on the wire and in the database. Each is documented where it is used.
- The prompt version changes, as with any tool description.

## What was rejected

- **The title beside the name on one line.** It truncates first exactly where it is needed, in a narrow roster, and reads as part of the name.
- **Renaming `hidden` on the wire.** It would need a protocol bump that locks installed apps out of every newer server, to rename a flag no operator reads.
- **Keeping `hidden` optional in the tools.** An optional flag defaults to listed, which is how rosters filled with helpers.
- **No hello for anything behind the scenes.** An operator who keeps a bot out of their list still made it for something, and its hello is how it learns what.
