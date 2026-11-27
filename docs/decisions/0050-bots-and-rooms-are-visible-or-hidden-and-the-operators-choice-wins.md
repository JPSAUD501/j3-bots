# 0050: Bots and rooms are visible or hidden, and the operator's choice wins

**Status:** Accepted, amended by [0101](0101-a-bot-is-its-name-and-its-title-and-a-helper-waits-behind-the-scenes.md): the operator reads "behind the scenes" where this record says hidden, the bots' tools take a required `listed` and `set_listed` in place of `hidden` and `set_visibility`, and a helper a bot makes behind the scenes says no hello. The rest stands.

## Context

A bot that builds a team for the operator makes bots and rooms the operator may never talk to: a worker it directs itself, a room where only bots coordinate. Each one is a row in the roster, and a roster full of helpers hides the teammates the operator does talk to. The operator could already hide a bot, from its menu, and nothing else could: rooms had no such switch, and no bot could keep what it made out of the way.

A bot choosing what the operator sees is a bot deciding something about the operator's own screen. The operator has to stay in charge of it: whatever they chose must stay as they chose it, and nothing hidden may stop working, stop telling them things, or become hard to find.

## Decision

**Visibility is a property of every bot and every room, visible by default, set by the operator and, within limits, by bots.**

- **Hidden means out of the list, not out of reach.** A hidden bot or room leaves the roster's rows and the desktop tray, and is listed under "Hidden conversations" at the roster's end. It keeps running: its turns, routines, rooms and teammates are untouched, and what it says notifies the operator as anything else does, since hiding is about the list, not about being told. Search finds it, and so does everything that refers to it: a notification, a mention, a notice, a teammate list, a room's members. Its details say it is hidden, with Show.
- **The operator sets it** when they create a bot (also from a template) or a room, and afterwards when they edit one, from its menu or from the hidden conversations. The server records each of these as the operator's choice (`visibility_by_operator`), shown or hidden alike.
- **A bot sets it through its tools:** `create_bot` and `start_room` take `hidden`, and `set_visibility` shows or hides a bot or a room later. A bot may change what it made (`made_by_bot_id`, kept while the maker exists), and the primary bot may change any bot or room. Never the primary bot, which only the operator shows or hides, and never what the operator chose: once they have made, shown or hidden something, no bot changes it. Each change is decided in the transaction that saves it, so a choice the operator just made wins over a call already on its way.
- **What came before is the operator's.** Every bot and room from before migration 41 counts as the operator's choice: they have had it in their list, and nothing records which bot made it.
- **The prompt says when.** A bot hides only helpers the operator did not ask to see, and keeps visible anything they asked for, by name or role, or will talk to themselves. It tells the operator when it hides or shows something they have seen.
- **No version bump.** `Room.hidden` decodes as false from an older server, and the new payload fields are optional, which an older server ignores, as decision 0022 did for sections.

## What it costs

- Two columns on bots and three on rooms, a tool, and a rule with four cases to keep right in two places (bots and rooms), which one function decides.
- A bot can still hide something the operator would have wanted to see, as long as they never chose it. The hidden conversations row and the bot's own `say` are what bring it back to their attention.
- An older server takes a new client's switch on a new room without hiding it, and says nothing.

## What was rejected

- **Muting hidden things.** Hiding was asked for to clear the list, and a bot that hides a helper would then also decide what the operator hears from it. A muted bot or room is a separate feature, if ever wanted.
- **Letting a bot override the operator, or the operator's choice expire.** Either makes the operator's choice something to defend. One rule, "the operator's choice stands", is simpler to trust.
- **Recording the last chooser instead of a flag.** A bot's choice after a bot's choice changes nothing about who may change it next, so who chose last is noise beside whether the operator ever did.
- **Treating a bot's creation as visible to everyone forever.** A bot made visible by its maker may still become a helper the operator did not want listed; until the operator chooses, its maker or the primary bot may hide it.
- **A protocol bump.** It would protect nothing an older client can see, and would lock installed apps out of every newer server.
