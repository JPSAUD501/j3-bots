# 0025: A file stands where the operator placed it, as a mark in the draft's text

**Status:** Accepted

## Context

An operator writes "compare this one with this one" and attaches two images. Until now a message's files followed its text, in the order they were attached, so the words lost what "this one" pointed at, on screen and for the bot. T3 Code's composer lets files stand in the text: its prompt editor is Tiptap (ProseMirror), whose inline nodes are its chips (**Read** at `c1464d67`, `apps/web/src/components/ComposerPromptEditor.tsx`).

Where a file stands has to survive everything a draft goes through: typing on two windows, a restart, mentions whose positions are offsets into the same text, the outbox, and an older client that knows nothing of places. Each harness receives a turn's files apart from the text: Claude Code and Codex as a line per file after it and as image blocks, in the order of the turn's files (**Read** at `59651c1`; details in [Wake envelopes](../prompts/architecture.md#wake-envelopes)). That the engine keeps a dispatch's order up to its adapter, and an ACP agent's order, is **Assumed**.

## Decision

- **The contract keeps offsets.** `message.send` and `MessageEntry` have an optional `attachmentOffsets`: one UTF-16 offset per file, never decreasing, none inside a character. Files are listed in reading order, so the order the harness receives them in is the order the text names them. Left out, the files follow the text, which is what every message sent before this, and every bot's message, does. The field is additive: no protocol version changes, and a client that does not draw places shows the files after the text, as before.
- **A draft keeps a mark.** In a draft, each file is U+FFFC (the object replacement character) in the text, one per file, in the order of the files. The text is the single record of where files stand, so everything that already follows edits of it (mentions, the revisions that settle two windows, the stored draft) follows the files with no second structure. Send turns the marks into offsets. The draft always holds one mark per file: extra marks are dropped, missing ones go after the text.
- **The envelope writes each file where it stands.** An `<attachment n="…"/>` is written at its place in the operator's text, numbered by its position in the list the harness receives, so "the second image" means the same file in the text and in the harness ([Wake envelopes](../prompts/architecture.md#wake-envelopes)).
- **Each client draws chips in its own field.** The web uses a `contenteditable` field in `plaintext-only` mode with uneditable chips, without an editor library: it needs text and chips only. Android uses an `EditText` of the app's own (`modules/chip-field`) with a span per chip, since React Native's `TextInput` draws only text.

## Consequences

- An old message, one with no text, or one whose offsets do not match its files shows its files after the text, as cards.
- A U+FFFC the operator types or pastes is not kept in a draft: the character means a file there. It is kept in a message's text, which has no marks.
- The app owns a small native view on Android, with its own event reconciliation, instead of a library field. iOS has no such field yet: the files of an iOS draft follow its text.
- A bot can refer to the operator's files by place; its own files, sent with `say`, still follow its text.

## Rejected

**A list of `{fileKey, offset}` beside the draft's text.** Every edit, every mention shift and every merge between windows would have to move it in step with the text; a mark moves with the text by construction.

**A rich-text editor (Tiptap, Lexical) on the web.** A document model, a schema and a serializer to hold text and one kind of chip. `contenteditable` in `plaintext-only` mode keeps the field plain text, which is what the draft is.

**A row of chips above the Android field, with places chosen elsewhere.** It does not let the operator put a file between two words, which is the point.
