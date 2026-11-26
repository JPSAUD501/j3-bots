# 0049: The bots manage MCP servers and skills

**Status:** Accepted

## Context

Until 0.9.0 a bot could do one thing about the services it reached: put a card in its conversation suggesting a connector (`suggest_connector`), which the operator then added from Settings ([decision 0026](0026-a-bot-uses-connected-services-through-j3-bots.md)). Skills were folders: the shared ones, linked into each harness home only when the engine started, and a bot's own under `skills/` in its workspace, which no harness listed and the bot found only because the base prompt pointed it there.

The owner wants what Claude Code offers, and more: to ask a bot to configure an MCP server, and the bots adding and keeping their MCP servers and skills themselves. With that, J3 Bots' own approval of what a connector offers goes in the same release (decision 0047 removes the tool review): the harness's permission mode is the one gate, as it is for every other thing a bot does with its tools.

What the pieces allow:

- **A `j3` tool is approved by name or not at all.** J3 Bots' own tools run without asking because each harness is given their exact names ([decision 0027](0027-connector-tools-reach-a-bot-through-the-j3-bridge.md)). A `j3` tool left off that list falls under the bot's permission mode like a shell command: an approval card in Supervised, the provider's reviewer in Auto, and a run in Full access.
- **Both harnesses read project skills from the session's folder, but not the same one.** Claude Code lists `.claude/skills`, Codex `.agents/skills` and `.codex/skills`; both follow a link to a skill's folder (**Verified** with Claude Code 2.1.328 and Codex 0.170.0, [Engine](../architecture/engine.md#behaviors-j3-bots-designs-around)). Neither reads the bot's `skills/`.
- **Both harnesses watch their skill folders.** Claude Code 2.1.332 keeps a watcher on its skill and command folders, and Codex 0.172.0 a skills watcher that clears its skills cache (**Read** in each release's shipped build). That a session already running lists a skill linked meanwhile is **Assumed** on both, not run.

## Decision

**A bot adds, changes and removes MCP servers and skills with `j3` tools that are not pre-approved, and J3 Bots asks nothing of its own: the permission mode is the gate.**

- **Who may do what.** The primary bot manages every server and skill: its own, any other bot's, and those for every bot. Every other bot manages only its own: a server whose bots are itself alone, and the skills in its own workspace. The server checks this on every call, for the bot whose turn the call is matched to. The operator does all of it from Settings → MCP and skills, on every client.
- **The tools.** `search_mcp_servers` and `list_mcp_servers`, `list_skills`: read only, and pre-approved as J3 Bots' other reading tools are. `add_mcp_server`, `update_mcp_server`, `remove_mcp_server`, `set_mcp_server_bots` (primary only), `save_skill`, `install_skill` and `remove_skill`: not pre-approved. Each call is matched to the bot's running turn as a connector call is, so it acts once and only for that turn, and a call the operator declined does nothing.
- **A new server is for every bot when the primary bot adds it**, and for the bot that adds it otherwise; the primary bot can name one bot. An address in the operator's own network, and a gallery entry that needs an app the operator registers, are added from Settings only: both need the operator's own word.
- **A key is a reference, never a value.** A value a server needs (a header, an argument, a variable) may be written `${secret:<name>}`; the server resolves it when it makes the request or starts the process, for the bot the call is for, through Secrets ([decision 0046](0046-secrets-the-operator-types-a-bot-uses-a-reference.md)). A bot asks the operator for a secret it lacks with Secrets' own tool; it never types or pastes one.
- **A sign-in is the operator's.** A server that needs an OAuth sign-in is added, and its sign-in goes to the operator as a card in that bot's conversation; the tool answers that it waits for it.
- **Skills are Agent Skills**: a folder with a `SKILL.md` whose frontmatter names it and says when it applies, and the files beside it. A bot's own live in its workspace's `skills/`, and the server links each one into the folders each harness reads in that workspace; shared ones in the shared skills, linked into each harness home at once, not only at the engine's next start. A skill is saved from text or from a folder of the bot's workspace, or installed from a public git repository at one commit, which is recorded: fetched over HTTPS, with nothing in it run and no link in it followed. The names and sizes are a template's ([decision 0023](0023-a-bot-template-is-a-file.md)), and a bot's skill cannot take the name of a shared one, nor the reverse: Claude Code would list only one.
- **Every change says who made it and when**: the operator or which bot. It shows as a step of the bot's work, and beside the server or skill in Settings.

## What it costs

- **A bot that adds a command server runs code on J3 Bots' machine as the server's user**, governed only by its permission mode. In Full access nothing asks. That was already true of the bot's shell; it is now true of a server the bot keeps running for every other bot it is granted to.
- **A bot can be talked into a server or a skill.** A page it reads can name a server that serves misleading tools, or a skill whose text becomes standing instructions to every bot it is shared with. The base prompt tells a bot to add only what its operator asked for or plainly needs, and in Supervised the operator sees the call; in Auto and Full access, only the step and Settings show it afterwards.
- **Skills install through `git`**, which must be on the server's `PATH` at version 2.37 or later.
- **Two more tables' worth of records** (who changed each server and skill), and the base prompt grows by a section every bot pays for.

## What was rejected

- **A confirmation card of J3 Bots' own for each change.** The harnesses already ask in Supervised and review in Auto; a second gate would ask twice there and override the operator's choice of Full access.
- **Every bot manages everything.** A bot the operator made for one task could then reshape what every other bot reaches.
- **Bot skills in one folder both harnesses read.** There is none; links from each harness's folder to the bot's `skills/` keep one copy.
- **Installing a skill by running its installer, or from a package registry.** Code from the repository would run on the server before anyone read it.
