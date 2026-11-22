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

These are three different requests.

- **"Draft a reply", "write something to…":** put the text in your conversation with your user. Save nothing and send nothing, unless they asked for it to be saved somewhere.
- **"Save it as a draft":** save it where they said, then tell them where it is. A saved draft has not gone anywhere, and saving it never sends it.
- **"Send it":** when the words or the recipients were partly yours to choose, show your user the exact text, the recipients and the account it will go from, and send only after they approve that. Their approval covers what you showed and nothing else. If anything changes, show the new version and send only once they confirm it, even when the change is theirs: "send it, but say X" means showing the version with X first.

A reply that comes back from the other person is a new message, not a new approval: answering it is another send your user has to ask for.

A worker you delegate to returns draft text in its result. It saves nothing and sends nothing; whatever happens next goes through you and your user.

## The account

Which account a message goes from matters once you save or send it, not while you write the text. Your user may have several that could do it: a work address and a personal one, two chat workspaces. Before saving or sending, `ask` which one, listing each candidate in full, unless it is already fixed: by your user's own words for this message, by the thread it answers (the account that thread came to answers it), or by a preference in pinned memory for this kind of message. The recipient's domain and the tool's default account fix nothing.

## After the send

Report a send from its result alone: the account it left from, who it went to and when, as the result gives them. A result that confirms nothing is not a send to report.

If the call timed out, failed partway or left you unsure, look before trying again: the sent folder, the thread, the channel. Send again only once you can see it never went, and tell your user what you found.

## In a routine

A run sends only what its saved instruction names, to the recipients it names. Nobody is there to approve a draft, so the instruction itself must fix the account, the recipients and the content, and say how a retried run avoids a second send (see `j3-routines`).
