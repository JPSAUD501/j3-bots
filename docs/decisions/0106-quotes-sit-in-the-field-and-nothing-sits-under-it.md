# 0106: Quotes sit in the field, a passage takes a comment, and nothing sits under the field

**Status:** Accepted. Amends [0094](0094-a-message-quotes-messages-a-reply-whole-a-quote-a-passage.md) (how a quote looks, and a comment on a passage) and [0097](0097-whats-new-ships-with-the-apps-and-follows-the-servers-version.md) (where What's new is).

## Context

The owner used Reply and Quote for a release and asked for three things.

- **Quotes looked heavy.** A reply was a strip over the composer and each passage a card, each with a colored bar along its edge. In a sent message, the cards sat over the bubble, outside it. T3 Code's own client shows a cited selection as a small chip inside its composer and lets the person add a comment to it from the selection's popover (**Read** in `pingdotgg/t3code` at `v0.1.13`, `apps/web/src/components/chat/AssistantSelectionToolbar.tsx`). A comment says what the operator wants about those words, without writing it around them.
- **Lines kept appearing under the composer.** The dictation status, why a prompt was cut, a draft that could not be saved, a file that could not be sent and a failed send were each a line under the field. They pushed the field up as they came and went, and a phone's keyboard hid some of them.
- **What's new stayed in the roster's footer for good**, a row someone had already read.

The quick access window also showed scrollbars, horizontal and vertical, where everything fit.

## Decision

**A reply or quote in the draft is a compact chip inside the composer, above the text. In a sent message, it is a quiet block inside the bubble, above the words. A quoted passage can carry the operator's comment on it. The composer shows nothing under its field: whatever it has to say is in the field. What's new shows in the roster only while something is unseen, and is always in Settings → About.**

### Quotes

- **In the composer.** Each quote is a chip inside the field's box, above the text. The chip shows a reply arrow or a quote mark, then the face of the bot that said it (or "You"), then the start of the words, cut with an ellipsis. A passage's chip has a pencil to add or change a comment where the server takes one. Each chip has an × to take it out. The chips sit on one line, which wraps on the web and scrolls sideways on a phone. 0094's limits hold: up to three quotes, at most one whole.
- **In a sent message.** The quotes sit inside the bubble, above its words. Each is a quiet rounded block, filled with the bubble's own ink at low opacity, so it reads in the operator's bubble and a bot's alike, in either theme. A block shows who said it and up to two lines of the words. A passage's comment follows its block, in the bubble's text. There is no colored edge anywhere. A tap still goes to the original.
- **Quoting a selection.** On the web, the desktop and quick access, Quote by the selection opens a small card with an optional comment and Quote. Enter quotes, Shift+Enter starts a new line, Escape closes it. On Android, the Quote part sheet has an optional comment field under the message's words. Against a server that takes no comments, Quote quotes at once, as before, and the sheet has no comment field.
- **The comment.** It goes only on a passage, as the operator's words about those words: up to 2,000 characters, trimmed, one per passage. A reply carries none, since the message itself is the answer. A comment goes with a message that has words or a file of its own: a draft of quotes alone, commented or not, has nothing to send yet. Quoting a passage again keeps its comment, unless the new quote brings one. The server keeps the comment with the quote, and refuses a comment on a whole message with `Invalid("quotes")`, nothing written.
- **What the bot reads.** A comment is the operator's word, so it is in the operator's message: `<comment quote="…">` inside `<message>`. Each quote's data block carries its number in the order sent (`n`), and the comment's `quote` names it: two passages of one message share its `id`, so the id alone would not say which passage a comment is on. The quote itself stays a data block outside it, as 0094 has it, and `QUOTES_LINE` says what a comment is.
- **Protocol 11 holds.** `comment` is an optional key of a passage's `QuoteRequest` and of a kept `MessageQuote`. A roster snapshot with `quoteComments: true` comes from a server that takes it, and a client offers a comment only then. An older client drops the key and shows the quote without it. The quotes live in the message's stored body, so nothing needed a migration.

### Nothing under the field

- **The rule, for every composer** (web, desktop, quick access, Android): nothing sits under the field. A status, a hint or a progress goes in the field's box: as a short line at its top, in the controls' row, or as the field's placeholder. A control may change its look. Each one says what it shows in an accessible label, or through a polite live region when it changes. None of them blocks typing unless the field already takes no edit, as during a send.
- **The lines that moved.** These each moved to a line at the top of the field's box, above the quote chips: the dictation status and why dictation stopped (with the phone's button to its settings), files dropped before the draft could take them, a prompt's text that was cut, a draft not saved on this device, a file that could not be sent, and a failed send. A problem is announced as an alert, and the rest politely. What sits above the composer (a draft that could not be read, one replaced from another device, the mention and prompt lists) stays there.
- **Other work on the composer follows the rule.** What it adds goes in that line, in the controls, or in the placeholder.

### What's new

- **Web and desktop.** The row in the roster's footer shows only while the newest release is unseen on this device. Once it is opened, the row goes when its dialog closes. Settings → About and updates has a What's new section, with See what's new, whenever there is a release to show.
- **The phone.** The line over the roster already showed only while unseen. What's new moves from the end of Settings to the end of About.
- 0097's mark, its storage and what it follows are unchanged.

### Quick access's scrollbars

The cause was the message actions. Reply and React sit beside a bubble in its column, and in quick access's narrow column they reached past its edge. The conversation then scrolled sideways, and both scrollbars showed. A bubble that has actions beside it now leaves them room (`calc(100% - 4rem)` at most), so nothing goes past the column. The vertical bar is left only where the conversation really has more to read.

## Costs

- **A comment is one more thing to read in a quote.** It is optional, and only on a passage.
- **The top line is short.** A long note is cut short in the field: to one line on a computer, where its tooltip has all of it, and to two on a phone. A screen reader hears all of it.
- **Who still has a web client from before this change** sees the footer row as before until they update. That is harmless.

## Rejected

- **A comment as a second message.** It would wake the bot twice, or reach it split from the passage it is about.
- **A comment on a reply.** The message that replies is already the operator's word on it.
- **A message of commented passages alone.** Its own text would be empty: blank in the roster's preview, in a reply to it and in what a bot reads of that reply. The comment goes with the operator's own words instead.
- **Comments as part of the quote's data block.** The quote is data, and the comment is the operator's own word. Putting the comment in the block would make it data too.
- **Keeping the status lines and reserving their height.** The field would then sit higher than it needs to, all the time, for lines that are mostly empty.
- **Hiding quick access's scrollbars.** That would leave the overflow, and the actions it cut off, in place.
