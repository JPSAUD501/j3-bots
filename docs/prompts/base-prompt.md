# Base prompt, v0.3

**Status:** reviewed in three council rounds, not yet run against a model. Expect it to change once the [behavior evals](architecture.md#evaluation) exist.

The text every bot shares lives in one place, the template the server renders it from: [`packages/prompts/src/templates/base.md`](../../packages/prompts/src/templates/base.md). The bot's profile and pinned memory follow it, from [`bot.md`](../../packages/prompts/src/templates/bot.md) in the same folder. On Claude Code both go into the bot's `.j3/system.md`; on Codex the base prompt is the provider instance's `developer_instructions` and the rest is the workspace's `AGENTS.md` (see [Prompt architecture](architecture.md#how-each-layer-reaches-each-harness)).

Placeholders in double braces are filled at render time. Above the profile, the only placeholder is `{{user.name}}`, which is the same for every bot of an installation: on Codex the base prompt is set once per provider instance and shared by all bots, so anything per-bot belongs in the profile.

Changing either template changes the prompt version every new session records, and is reviewed as a change to bot behavior.

Notes for editors:

- The prompt explains why a rule exists wherever the reason is not obvious. A bot that understands the reason applies the rule to cases the text did not foresee.
- It is written in the second person, in prose, with few absolute words. Emphasis is reserved for the few rules where a mistake cannot be undone or where the host pulls hardest the other way.
- It must stay short enough to be read on every session start. The budget is 3,000 words for `base.md`, counted as runs of non-whitespace that contain a letter or a digit, so Markdown markers do not count. A structure test enforces it.
- It is original text. See [Prior art](../research/prior-art.md).
