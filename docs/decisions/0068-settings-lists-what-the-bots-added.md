# 0068: Settings lists what the bots added, and adds nothing itself

**Status:** Accepted. Amends [decision 0049](0049-the-bots-manage-mcp-servers-and-skills.md).

## Context

Since 0.9.0 a bot adds, changes and removes MCP servers and skills itself ([decision 0049](0049-the-bots-manage-mcp-servers-and-skills.md)). Settings kept everything it had before that: a library of featured connectors and a registry search, a form that adds a server by its address or by a command, with headers and an OAuth client, and a form that writes or installs a skill. It also listed J3 Bots' own skills (`j3-…`), the ones every bot is given, beside the operator's.

The owner's complaint was that Settings showed what doesn't matter to them. A person opening Connectors met a catalogue, two ways to add the same thing a bot adds from one sentence, and a list of skills they never wrote and can't remove. Two ways in also meant two sets of rules to explain: what the form asks for, and what a bot asks for.

## Decision

**Settings lists the connectors and skills the bots added, and lets the operator look after them. Adding is done by asking a bot.**

- **Connectors.** Settings → Connectors, and Connectors in a bot's details, list the connectors that exist. Each one's page signs it in, takes a new value for a field, chooses its bots, accepts its changed tools and disconnects it. On the web and the desktop, a command connector's page keeps **Change command** and its confirmation: a command whose settings carry a value a bot can't fix, or a program at a path that moved, is the operator's to change.
- **Skills.** The list shows the skills a bot saved or installed, by name. A skill's page still shows its `SKILL.md` and lets the operator edit or remove it. J3 Bots' own skills are not listed: the bots still have them, and nobody can remove them.
- **No library, no add forms.** The featured list, the registry search, the add-your-own form and the new-skill form are gone from the web, desktop and Android clients, with the client code only they used.
- **An empty list says, in one line, to ask a bot.**
- **The server is unchanged.** Its RPCs that only those screens used (`connectors.list`, `connectors.search`, `connectors.get`, `connector.add`, `skill.install`) stay, so a client of protocol 11 from before this change keeps working. Current clients don't call them ([Server](../architecture/server.md#connectors)).

## Costs

- **Two kinds of connector can't be added from 0.10.0 clients.** An address in the operator's own network, and a gallery entry that needs an app the operator registers (Google and Slack), need the operator's own word, so a bot refuses them ([decision 0049](0049-the-bots-manage-mcp-servers-and-skills.md)), and the form that took that word is gone. One already added keeps working. Bringing them back needs a way for the operator to give that word in a conversation, which is a design of its own.
- **A connector is added only through a bot's turn**, which costs a model call and follows the bot's permission mode. In Supervised, the operator still sees each call; in Auto and Full access, only the step and the list show it afterwards.
- **A protocol-11 client from before this change still has the forms.** Nothing in the server tells it apart, and nothing needs to: what it adds is what it could add before.

## Rejected

- **Keep the forms behind an "Advanced" entry.** It keeps both sets of rules and their screens, for the two cases a bot refuses; those want a way to say yes in a conversation, not a second way in.
- **Remove the RPCs with the screens.** Protocol 11 stays in this release, and a client from before it would fail on a call its own screen makes.
- **List J3 Bots' own skills apart, read-only.** The operator can do nothing with them, and the bots' conversations already say what they can do.
