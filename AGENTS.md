# Working in this repository

Roster is in its design phase. The deliverable right now is documentation that is correct enough to build from.

## What this project is

Persistent AI teammates ("bots") on the user's own machine and subscriptions, built on an unmodified T3 Code server. Start with [docs/vision.md](docs/vision.md) and [docs/architecture/overview.md](docs/architecture/overview.md).

## Vocabulary

Use the terms in [docs/product/concepts.md](docs/product/concepts.md) exactly. The ones people most often mix up:

- **Bot**: the persistent teammate the user talks to. Not "agent", not "assistant".
- **Conversation**: what the user sees. Roster owns it.
- **Session**: an engine thread that gives a bot working context. Replaceable. The user never sees one.
- **Engine**: the T3 Code server Roster drives. Never "backend" or "T3" alone in user-facing text.
- **Wake**: anything that starts a bot turn (a message from the user, a routine, another bot, a room, a system event).

## Rules for documentation

- Write in English. Everything in this repository is meant to be published.
- Mark how well each engine fact is established: **Verified** (observed on a running server), **Read** (read in T3 Code source, with the commit), or **Assumed**. Never present an assumption as a fact.
- When a decision changes, rewrite the affected text. Do not append a second account next to the old one.
- A decision that would be expensive to reverse gets a short record in [docs/decisions](docs/decisions/README.md).
- Do not commit plans, scratch notes or research dumps. A merged change is the record.

## Rules that will apply to code

These are settled before the first line is written. Details are in [docs/engineering/standards.md](docs/engineering/standards.md).

- TypeScript, strict. `any` is not allowed; neither are unchecked casts at a boundary. Decode external data with a schema.
- Only `packages/engine-t3` may know anything about T3 Code: its protocol, its types, its file layout.
- Clients talk only to the Roster server, through `packages/contracts`.
- Test behavior that can break. No tests for what types already guarantee, and no tests that assert something removed stays removed.
- Fix the cause. No workarounds that leave the underlying problem in place.

## Intellectual property boundaries

- Prompts in this repository are original text. Third-party system prompts, including unofficial captures of commercial products, are never copied or committed here. See [docs/research/prior-art.md](docs/research/prior-art.md).
- Do not reproduce another product's brand assets, character art or screenshots. Visual references are described in words.
- T3 Code source may be studied and, under its MIT license, reused with attribution. Roster does not fork it.
