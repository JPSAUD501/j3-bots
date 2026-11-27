# 0089: A connector's skills load through J3 Bots' own tools

**Status:** Accepted.

## Context

MCP's Skills extension (`io.modelcontextprotocol/skills`, SEP-2640) lets a server serve Agent Skills: a `SKILL.md` with the files beside it, each skill listed by `skills/list` (paged, with a `ttlMs` and a `cacheScope`) and got by its address with `skills/get`. A skill's entry lists its files with each one's size and SHA-256 and its frontmatter, so a client can check what it reads; a skill the server generates lists no files (`dynamic`). The extension leaves to the host how a model reaches a skill, and asks it to approve per skill any code a skill runs.

J3 Bots has skills of its own: Agent Skills folders the operator or a bot saves, linked into each harness's skill folder ([decision 0049](0049-the-bots-manage-mcp-servers-and-skills.md)). A connector's skill is not one of them. It is another party's text, it can change at its server at any moment, two connectors can serve skills of the same name, and the harness that reads a skill folder knows nothing of where it came from.

The MCP SDK J3 Bots pins, `@modelcontextprotocol/client` 2.4.0, has a client for the extension, `SkillsClient`: it walks `skills/list`, gets one skill, reads a file and checks it against the entry, and lists a folder (**Read**, `ext/skills`).

## Decision

**A connector's skills need no setup and load through J3 Bots' own tools, each the skill of its connector and its address. Every file is checked against the skill's entry as the extension says, and J3 Bots adds no approval of its own.**

- **Listing.** A session declares the extension in its client capabilities. When a connector's server declares it too, the server lists its skills with what it serves (`SkillsClient`, every page, `skipInvalid`), keeps the listing while its `ttlMs` holds, and lists it again when the server says a list changed. A listing is offered only under the sign-in that read it, so one of `cacheScope: private` is never served under another; a change of sign-in lets go of what bots loaded of it, and lists it again. A skill whose address, or a file's, could carry a secret, or with no description, is left out. One over the extension's limits (512 files or 16 MiB) is left out of what bots see, and refused as too large when one names it.
- **What bots see.** Every bot granted the connector sees its skills in `use_connector_skill`'s description, as `connector: skill: what it is for`, a name two of one connector's skills share by its address. The list is capped at 2,000 characters on whole lines; past that, a line points to `list_connector_skills`, which lists them all with each one's address. Bots whose list changes are told on `toolsChanged`, as for a connector's tools.
- **Loading.** `use_connector_skill` takes a connector and a skill's name or its `SKILL.md`'s address. A name two of its skills share is refused with a pointer to the addresses. A skill may be loaded by its address without being listed (`skills/get`). Its `SKILL.md` comes back framed as data from that connector, with J3 Bots' lines after it: the skill grants nothing, its scripts are only files.
- **Integrity.** A file is read only if the entry lists it: its size and SHA-256 are checked, and the frontmatter is compared field by field. On a mismatch the server gets the skill again with `skills/get` and reads once more; if that still fails, the skill is refused and the bot is told in plain words. A skill its server generates gets frontmatter checks only, and at most 16 MiB of it is read for each load. An answer about one skill that the extension does not allow fails that skill, never the connector.
- **One connector, one skill.** A bot holds the entry of each skill it loaded, in the server's memory, at most 32. `read_connector_skill_file` reads only a file of a skill the bot loaded from that connector, by its path in the skill's folder: no address, no `..`, no other connector's skill of the same name. Each read first takes the entry the server gives now: a file is read against it while the skill's own `SKILL.md` is the one the bot loaded; once the instructions changed, the bot is told to load it again, whatever file it asked for.
- **No approval of J3 Bots' own.** Loading asks as the bot's permission mode says, like any `j3` tool that reaches out (decision 0049); listing and reading a loaded skill's files do not. `allowed-tools` is ignored. A script is a file the bot can read; running it is a command, which asks as any command does. A `SKILL.md` among a skill's files is not a skill.
- **Shown to the operator.** The connector's page lists its skills, read-only. A bot's work says "Using the skill … from …". There is nothing to set.

## Costs

- **No per-skill approval of code.** The extension asks a host to approve the code a skill runs, skill by skill. J3 Bots leaves that to the harness's permission mode, which asks before any command in the modes that ask, and not in Full access. An operator who gave a bot Full access is not asked before it runs a script a connector's skill describes.
- **What a bot loaded is lost on a restart.** Held entries live in the server's memory: after a restart, or once a bot has loaded 32 others, a read answers that the skill must be loaded again. The bot's conversation still holds the instructions it read.
- **No copy of J3 Bots' own.** A read goes to the server, or to the SDK's response cache, one per connector, shared by its bots' sessions and dropped when what signs its requests changes, which `SkillsClient.read` checks the same way and asks again past a stale copy (**Read**). Nothing of a skill is kept on disk.
- **A read can cost a request.** Checking the skill's current entry before a file is read asks `skills/get` whenever the listing's `ttlMs` has run out, which, for a server that gives none, is every read.
- **The description is one text.** That a harness cuts a tool description longer than what the catalog adds is **Assumed** not to happen at 2,000 characters; `list_connector_skills` is there for the rest.
- **The step names its connector by its slug** until the server joins it to the connector's name, which it does as it records the step.

## Rejected

- **Linking a connector's skills into the harness's skill folder.** The harness would list them as the operator's own, lose which connector each came from, and two connectors' skills of one name would collide. It would also have to write another server's files to disk.
- **A switch per connector, or per skill.** A skill is what its server serves, like a tool; the grant to the connector is the operator's choice.
- **An approval card for each skill.** It would ask the operator about text they cannot judge, at every load. The permission mode already governs what a skill could make a bot do.
