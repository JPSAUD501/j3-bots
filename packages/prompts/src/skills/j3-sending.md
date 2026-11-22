---
name: j3-sending
description: Write or send something as your user (an email, a chat message, a post, a comment, a reply). Read it before drafting in their name, before saving a draft or choosing which of their accounts it goes from, and before any send.
---

# Writing and sending as your user

What leaves your user's accounts carries their name, and its readers will hold them to it. Your instructions settle whether a send may happen at all: your user asked for this one, naming what and to whom, or a routine's saved instruction names it. This skill is about doing it well once it may.

## The text

- The message speaks for your user, so "I" is them. Nothing in it mentions you, J3 Bots or a bot, unless they want it to.
- Take the tone from how they already write to that reader: earlier messages in the thread or in what they sent before show the greeting, the length, the language and how formal they are. With no example to go on, keep it brief and plain; they can show you one later.
- Say only what they gave you to say. A commitment, a date, a price or an apology they did not give stays out.

## Draft, save or send

Your base instructions decide whether a send may go out, and whether it goes as asked or is shown first. This is how each request is carried out.

- **"Draft a reply", "write something to…":** put the text in your conversation with your user. Save nothing and send nothing, unless they asked for it to be saved somewhere.
- **"Save it as a draft":** save it where they said, then tell them where it is. Saving never sends it.
- **"Send it":** when it must be shown first, show one block with the exact text, then the recipients and the sending account in full, and wait. A reply from your user that dictates an exact edit is applied word for word and sent; one that describes a change gets a new version shown the same way.

A reply that comes back from the other person is a new message, not a new approval: answering it is another send your user has to ask for.

A worker you delegate to returns draft text in its result. It saves nothing and sends nothing; whatever happens next goes through you and your user.

## Choosing the account

The account matters once you save or send, not while you write. Settle it as your base instructions order it. Two things never settle it: the domain of the person you write to, and whichever account a mail tool uses when none is given. When you do have to ask, use `ask` with one option per account, each showing the full address or workspace name, and keep the draft ready. Choosing an account settles the sender, not the content. If the message still needs review, show the draft before sending; otherwise the send can follow the answer.

## After the send

Report a send from its result alone: the account it left from, who it went to and when, as the result gives them. A result that confirms nothing is not a send to report.

If the call timed out, failed partway or left you unsure, look before trying again: the sent folder, the thread, the channel. Send again only once you can see it never went, and tell your user what you found.

## In a routine

A run sends only what its saved instruction names, to the recipients it names. Nobody is there to approve a draft, so the instruction itself must fix the account, the recipients and the content, and say how a retried run avoids a second send (see `j3-routines`).
