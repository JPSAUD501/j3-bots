# 0043: A bot reads its rooms from anywhere, and posts there only on what it has seen

**Status:** Accepted

## Context

Since 0.7.0 a bot posts in a room it belongs to from any turn, its own conversation included (`message_bot` with the room's id). What it knows of a room comes only from its room envelopes: a turn of its own conversation carries routine deliveries, held teammate messages and profile changes, never a room's entries, and no tool read a room. `recall` searches memory, not rooms.

That leaves a bot acting on a stale view. Say several bots work on a report in a room, and one of them posts there that the report is delivered. Later, in the bot's own conversation, its user says the work is no longer needed, and the bot posts in the room to stop it and cancel what is pending. It does not know the work is done: its last room turn came before the "delivered" message, either because the room was past its quiet round, where a bot's post wakes nobody, or because the room's wake waited behind the private turn. Nothing lets it check.

Users expect what a group chat with bots in it gives: a bot's room turns are part of its one conversation, so it usually answers from memory, and when it does not remember or needs an exact detail it reads the room's latest messages, or searches them, from any conversation.

## Decision

**A bot reads a room it is a member of from any turn, and a post it makes there from outside that room's own turn goes out only on what the posting session has seen** ([Server](../architecture/server.md#what-a-bot-has-seen-of-a-room)).

- **`read_room`.** The room's newest messages, or those whose text or author's name holds a search, oldest first, framed as an envelope frames room entries and bounded in count and size, saying how many earlier ones it does not show. Any room the bot is listed in, archived ones included; any other id is refused. It is a turn tool, so a delegated worker cannot read.
- **One notion of seen, per session.** A session has seen a room through a place when it was shown the room's newest entries up to there, or, by an envelope or a refused post, told how many it was not shown. What shows it a room: the room envelopes the engine took into it, its reads of the room's newest messages that showed all it had not seen, and its refused posts. A read of fewer, for its count or its size, leaves the rest unseen: the bot chose not to see them, and a post on that view would be the stale one this decision prevents. A search shows a selection and moves no view. A view counts only for calls the bot wrote after it had it: a post written in the same model message as a read was written without what the read showed. A session that replaced another, or a routine's side session, starts with no view of what the other was shown, since none of it reached it.
- **The check.** From any turn but one of that room, a post to a room holding messages by others after what the session has seen posts nothing. The refusal shows what was missed, fitted and counted as an envelope's entries are, and asks the bot to decide again: post, adapt, or tell its user what changed. The refusal records that view, so the next post goes out unless something newer arrived. A refused post relays nothing of the operator's word.
- **Envelopes go by the same view.** A room envelope leaves out what the session it is written for was shown, so a read that showed all it had not seen spares the next envelope those entries; the entries that woke the bot are always carried. A session that replaced another is shown again, in its first room envelope, what only the old one was shown.
- **Rounds go by the same record.** What showed a turn the room, its envelopes, reads and refused posts, is one record, which both the check and the room's rounds ([0042](0042-a-room-counts-rounds.md)) read. A turn's next message there answers what a read or a refusal showed it, so it takes one round past the newest it showed since the operator's latest word, as it would after an envelope. Envelopes leave out also what an envelope not yet taken may have shown; the check and the rounds count only what surely showed the room.

## What it costs

- **A post from outside the room after others spoke takes two calls.** The first is refused with what was missed, the second goes out. A routine's run always pays it once when others wrote in the room, since its side session starts with no view of any room, unless it reads first.
- **A read is tokens in the session.** It is bounded, and the prompt asks the bot to answer from memory first.
- **A replaced session is shown a room again.** Its first room envelope carries again what others wrote there that only the old session was shown, the newest that fit, and its first post to such a room from elsewhere is refused once with them.
- **A table** (`room_views`) records how far each call that read or was refused a post was shown, and which of the session's calls the engine had recorded by then, and goes with its room and its turn.

## What was rejected

- **Every room's unseen entries in every private envelope.** It would cost on every turn of the bot's conversation, for rooms it may not touch, and group chats with bots in them do not do it: a bot reads a room when it needs to.
- **Checking posts inside a room's own turn.** Members of a room answer in parallel, and a reply beside another member's is accepted ([0040](0040-the-members-of-a-room-run-in-parallel.md)). A check there would refuse the overlapping replies that decision chose to allow.
- **Raising or removing the quiet limit.** The stale view did not come from the limit alone: a wake waiting behind a private turn leaves the same gap. And the limit, now the quiet round, is what keeps bots in a room from answering each other for good ([0042](0042-a-room-counts-rounds.md)).
- **A record of reads beside the record of what a turn was shown.** Rounds would count a turn's envelopes but not what it read, and a bot that read the room past its envelope would answer an older round than it knew of.
- **A view per bot rather than per session.** A routine's run, or a session since replaced, would mark the acting session as having seen what it never received, and it would post on it.
