# 0023: A bot template is a file, built and imported by the server

**Status:** Accepted

## Context

An operator who has shaped a bot over weeks wants to hand that bot to someone else, or keep a copy to start from: "share it as a template". The person on the other end runs their own J3 Bots, on their own machine and subscriptions, so the two servers share nothing. What travels is whatever the operator sends through a mail, a chat or a drive.

A bot holds two kinds of things. What makes it do its job: its profile, its job, the model it runs on, its permission mode, its skills and its routines. And what it has learned and done for this operator: its memory, its conversation, the files it produced, the secrets its routines' webhooks carry, the operator's time zone, the paths of its workspace. A template must carry the first kind, all of it, and none of the second: the second is personal, and it often names people, accounts and machines.

Whoever opens a template did not write it. Its job and its routines' instructions become standing instructions to a bot ([Security: who can give instructions](../architecture/security.md#who-can-give-instructions)), its skills become files the bot reads when a task calls for them, and its permission mode says how much the bot may do without asking. A template is untrusted input that asks to become trusted.

## Decision

**A template is a file, `<name>.j3bot`**: indented JSON, media type `application/vnd.j3bots.bot+json`, at most 1 MiB, with a `format` (`j3-bots/bot-template`) and a `version` (1). Its schema is `BotTemplate` in `packages/contracts/src/template.ts`, the one definition every client and the server decode with. It holds:

| In the template | How |
| --- | --- |
| Profile | Name, title, avatar, job |
| Model | The provider and model ids, as a suggestion |
| Permission mode | As a suggestion, never more than the default unless the operator picks it |
| Skills | Up to 16, each a name and the text of its `SKILL.md`, up to 20,000 characters |
| Routines | Up to 16, each a name, an instruction and a trigger: a cron schedule, or a webhook |

| Never in the template | Why |
| --- | --- |
| Memory: the profile note and the log | What the bot learned about this operator |
| The conversation and its attachments, and the files the bot produced | This operator's work |
| A schedule's time zone | The operator's; the importing operator's own takes its place |
| A webhook's URL and secret | A credential; the new routine gets its own |
| One-time routines | A moment in this operator's life, not part of the job |
| Provider accounts, logins, secrets, devices, settings | The machine's, not the bot's |
| Paths, the workspace's other files, anything a skill folder links to | The machine's; a skill is only a real folder's own regular `SKILL.md` |

**The server builds it and the server imports it**, through two RPCs, `bot.template` and `bot.createFromTemplate`. The template is assembled from named fields of the stored bot, its routines and its skill folders, never by copying anything larger and removing parts, so what is left out cannot leak in when the bot gains something new. A client cannot build one: skills exist only in the bot's workspace on the server.

**Importing is a preview, then one command.** A client reads the file (refusing it unread when it is over the size limit, and showing nothing of a file that does not decode whole), shows everything the bot will be and do, every skill's and routine's full text included, with the model it will run on here and the permission mode it will start with, and creates nothing until the operator presses Create. `bot.createFromTemplate` then makes the bot, its routines and its skill files in one transaction, idempotent by command id: a schedule that cannot run, or a skill that cannot be written, leaves no bot behind.

**An imported template is held to these rules**, on the server whatever the client sends:

- It decodes with the schema or is refused: a skill's name is a single lowercase folder name (`triage`, never `../memory`), names are distinct, and every limit holds.
- Its routines are created paused, and appear in the bot's details for the operator to turn on.
- Its permission mode is the less permissive of the template's and the server's default for the model (supervised when it names one this build does not know), unless the command names another: only a paired client, which is the operator, sends one, and both clients send the mode the preview showed, which the operator may raise there.
- Its model is used only when this server offers it; otherwise the client's choice, else the server's default.
- Its text goes only into the new bot: its profile, its routines, and files under its own workspace's `skills/`. Nothing of it reaches another bot, the shared memory or the operator's settings, and the new bot is never made primary.

## Consequences

- A template from a later version of J3 Bots is refused with a message saying so, rather than created with parts this build cannot show.
- A template is plain text the operator can read and edit before sharing it; a hand-edited one is held to the same rules.
- Routines arrive paused, so a template with a morning digest does nothing until its new operator turns it on. That is one more step for every routine, on purpose.
- A skill that is more than its `SKILL.md` (a folder with scripts or references beside it) travels as its `SKILL.md` alone.
- Sharing a bot does not tell its operator what it leaves out field by field; the share screen shows everything that goes, and one line says what stays.

## Rejected

**Building the template in the client.** It would need a new RPC to read skills anyway, and the import would still have to run on the server to create routines and skill files in one transaction.

**Exporting everything and filtering it.** Simpler to write, and the wrong default: a field added to a bot later would travel until someone remembered to remove it.

**Carrying memory as an option.** It is the bot's knowledge of one person. An operator who wants a bot to start knowing something writes it in the job or a skill, where the receiving operator reads it before creating the bot.

**Starting routines as they were.** A template's routine wakes the bot on someone else's schedule, with someone else's instruction, spending the importing operator's subscription before they have looked at the bot once.
