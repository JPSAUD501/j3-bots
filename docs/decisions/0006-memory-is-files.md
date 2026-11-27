# 0006: Memory is files

**Status:** Accepted

## Context

A bot's memory could live in J3 Bots' database behind tools, in a vector store, or in files in the bot's workspace.

## Decision

Memory is Markdown files in the bot's workspace: a small pinned note and a dated log. Shared memory, what every bot may know about the operator, is a folder like a bot's own, with its pinned note and its log. Bots change memory through tools (`remember`, `forget`) that keep the files tidy and deduplicated, and search it with `recall`, which is plain text search. The pinned notes, the bot's and the shared one, are rendered into the system prompt.

## Consequences

- The operator can read, edit, diff, back up and version a bot's memory with ordinary tools.
- A bot can read its own memory with the harness's file tools if a J3 Bots tool is unavailable.
- Memory survives any change to J3 Bots' database, its engine or its model.
- No embedding model, no extra service.
- Text search finds what shares words with the query and misses paraphrases. If that proves limiting, an index can be built from the files without changing where the truth lives.
- Files are readable by anything running as the same user. Memory is not a place for secrets.

## Rejected

**A vector store.** Better recall on paraphrase, at the cost of an embedding dependency, an opaque store, and memory the operator cannot simply open.

**Rows in the database.** Easy to query, invisible to the bot's own tools and to the operator.
