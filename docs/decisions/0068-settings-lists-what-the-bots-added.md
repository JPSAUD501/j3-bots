# 0068: Settings lists what the bots added, and adds nothing itself

**Status:** Accepted. Amends [decision 0049](0049-the-bots-manage-mcp-servers-and-skills.md).

## Context

Since 0.9.0 a bot adds, changes and removes MCP servers and skills itself ([decision 0049](0049-the-bots-manage-mcp-servers-and-skills.md)). Settings kept everything it had before that: a library of featured connectors and a registry search, a form that adds a server by its address or by a command, with headers and an OAuth client, and a form that writes or installs a skill. It also listed J3 Bots' own skills (`j3-…`), the ones every bot is given, beside the operator's.

The owner's complaint was that Settings showed what doesn't matter to them. A person opening Connectors met a catalogue, two ways to add the same thing a bot adds from one sentence, and a list of skills they never wrote and can't remove. Two ways in also meant two sets of rules to explain: what the form asks for, and what a bot asks for.

## Decision

**Settings lists the connectors and skills the bots added, and lets the operator look after them. Adding is done by asking a bot.**

- **Connectors.** Settings → Connectors, and Connectors in a bot's details, list the connectors that exist. Each one's page signs it in, takes a new value for a field, chooses its bots and disconnects it. On the web and the desktop, a command connector's page keeps **Change command** and its confirmation: a command whose settings carry a value a bot can't fix, or a program at a path that moved, is the operator's to change.
- **Skills.** The list shows the skills a bot saved or installed, by name. A skill's page still shows its `SKILL.md` and lets the operator edit or remove it. J3 Bots' own skills are not listed: the bots still have them, and nobody can remove them.
- **No library, no add forms.** The featured list, the registry search, the add-your-own form and the new-skill form are gone from the web, desktop and Android clients, with the client code only they used.
- **An empty list says, in one line, to ask a bot.**
- **What needs the operator's own word is a card in the conversation.** An address in the operator's own network, and a gallery entry that signs in only with an app the operator registers (Google and Slack), are added only on their yes. The bot's `add_mcp_server` adds nothing yet: it shows a `connector-ask` card, which names the address in plain words ("Ana wants to connect to a service on your own network at 192.168.1.20:8123. Allow?"), or shows the entry's setup steps and takes the app's client ID and secret, as `ask_for_secret`'s card takes a value. Only the operator's answer to that card records the yes; on it, the server runs the add the bot asked for, and wakes the bot with how it ended. The client goes to the connector's secret only, and the bot never sees it ([Server: the operator's yes](../architecture/server.md#the-operators-yes)).
- **The server's other RPCs stay.** Those only the removed screens used (`connectors.list`, `connectors.search`, `connector.add`, `skill.install`) stay, so a client of protocol 11 from before this change keeps working; current clients don't call them. `connectors.get` is read again, by the card, for an entry's setup ([Server](../architecture/server.md#connectors)). Protocol 11 holds: the card is a new kind of entry, which a client before it shows as one it needs a newer version for, and its answer a new `card.answer` variant.

## Costs

- **An ask lives in the server's memory.** What the bot asked to add can carry a key, in an address or a value, and J3 Bots keeps such values only in its sealed secrets, which hold a connector's, not a request's. So an open ask is closed as expired when the server restarts, and the bot asks again. An ask nobody answers closes after 24 hours.
- **A connector is added only through a bot's turn**, which costs a model call and follows the bot's permission mode. In Supervised, the operator still sees each call; in Auto and Full access, only the step and the list show it afterwards.
- **A protocol-11 client from before this change still has the forms.** Nothing in the server tells it apart, and nothing needs to: what it adds is what it could add before.

## Rejected

- **Keep the forms behind an "Advanced" entry.** It keeps both sets of rules and their screens, for the two cases that need the operator's word; those take a yes in the conversation, where the bot asked, not a second way in.
- **Let the bot say the operator agreed.** A flag on `add_mcp_server` would make a model's word the operator's, which anything the bot read could forge. The yes is recorded only from the operator's answer to the card.
- **Keep what the bot asked to add in the database, to survive a restart.** It would put an address or a value that can carry a key where J3 Bots keeps no secret. Asking again after a restart costs one turn.
- **Remove the RPCs with the screens.** Protocol 11 stays in this release, and a client from before it would fail on a call its own screen makes.
- **List J3 Bots' own skills apart, read-only.** The operator can do nothing with them, and the bots' conversations already say what they can do.
