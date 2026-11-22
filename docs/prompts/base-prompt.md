# Base prompt, v0.3

**Status:** reviewed in four council rounds. The routine and conversation cases in [`packages/prompts/evals`](architecture.md#evaluation) have run it against one small Claude model and one small GPT model; most scenarios in the behavior eval list still have no case.

The text every bot shares lives in one place, the template the server renders it from: [`packages/prompts/src/templates/base.md`](../../packages/prompts/src/templates/base.md). The bot's profile and pinned memory follow it, from [`bot.md`](../../packages/prompts/src/templates/bot.md) in the same folder. On Claude Code both go into the bot's `.j3/system.md`; on Codex the base prompt is the provider instance's `developer_instructions` and the rest is the workspace's `AGENTS.md` (see [Prompt architecture](architecture.md#how-each-layer-reaches-each-harness)).

Placeholders in double braces are filled at render time. Above the profile, the only placeholder is `{{user.name}}`, which is the same for every bot of an installation: on Codex the base prompt is set once per provider instance and shared by all bots, so anything per-bot belongs in the profile.

Some of what the prompt tells a bot is a product decision rather than wording, and changes only with a change to the product:

- **What the app shows.** The clients render paragraphs, inline code, fenced code blocks, bare web addresses and `@name`s, and nothing else, so the prompt asks for plain prose, bare links and no Markdown emphasis, headings or link syntax. A typed `@name` is only shown; the `mention` field of `say` is what wakes a member. When a client learns to render more, this text changes with it.
- **The operator's machine.** A bot runs on the operator's own computer with their files and signed-in accounts. Its workspace is its own; anywhere else it reads freely but asks before deleting, moving or overwriting anything, or installing software, unless the operator named that change.
- **Refusals are final.** A step the engine refused, or an approval the operator declined or let expire, is not retried by another route: another tool, a stored credential or an internal endpoint. A failure for another reason may be retried.
- **Secrets stay out of the conversation.** A bot never asks for one in chat; it uses the engine's `request_secret`. A secret the operator pastes anyway is used for that task only and kept out of messages, files and memory.
- **Watches end.** A routine that watches for one event ("let me know when X") ends when the event happens or on an end date: the one the operator named or implied, otherwise 14 days after the bot creates it. The bot names that date when it confirms the watch, and the last run tells the operator once that it stopped watching. A watch that never ends would keep spending the operator's allowance on something they have likely forgotten.
- **Days left open.** "Every morning" or "every day" runs every day. Only when the operator leaves the days open does a work subject run on weekdays and a personal one every day, and the bot says which it chose.

Changing either template changes the prompt version every new session records, and is reviewed as a change to bot behavior.

Notes for editors:

- The prompt explains why a rule exists wherever the reason is not obvious. A bot that understands the reason applies the rule to cases the text did not foresee.
- It is written in the second person, in prose, with few absolute words. Emphasis is reserved for the few rules where a mistake cannot be undone or where the host pulls hardest the other way.
- It must stay short enough to be read on every session start. The budget is 3,000 words for `base.md`, counted as runs of non-whitespace that contain a letter or a digit, so Markdown markers do not count. A structure test enforces it.
- It is original text. See [Prior art](../research/prior-art.md).
