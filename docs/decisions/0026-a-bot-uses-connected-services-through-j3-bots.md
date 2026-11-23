# 0026: A bot uses connected services through J3 Bots, which holds the sign-in

**Status:** Accepted

## Context

A bot that keeps the operator's notes, tickets or calendar needs to reach the services that hold them. Most of those services now publish an MCP server, often a remote one behind an OAuth sign-in, and the [vision](../vision.md) puts a gallery of them in scope: J3 Bots builds no integration of its own for any service, and bots reach other services through MCP servers, those the harness already has and those the operator connects.

The harnesses can do this themselves, and neither way fits a bot:

- **Harness configuration is shared and slow to change.** Each harness instance has one MCP configuration, shared by every bot on it, which the adapter writes only while the engine is stopped ([Engine: provisioning](../architecture/engine.md#provisioning)). A server for one bot would mean a file in that bot's workspace (Claude Code's `.mcp.json`, Codex's project configuration), which the bot can edit to grant itself servers or change their credentials, and a change would reach the bot only in a new session.
- **A harness's own sign-in leaves the token within the bot's reach, and needs a browser on the server.** Claude Code and Codex can each sign in to a remote MCP server, keeping the token in the instance's home, which the bot's own shell can read; the sign-in opens a browser on the machine the harness runs on, which on a headless server is nobody's.

## Decision

**J3 Bots is the MCP client and the OAuth client for every connector, and holds every secret a connector needs.** A bot calls a connector's tools through J3 Bots ([decision 0027](0027-connector-tools-reach-a-bot-through-the-j3-bridge.md)); the server calls the connector, adding its token or key itself, and gives the bot the result. No token, key, client secret or header value reaches a bot, a harness's configuration, a prompt, an entry, a log line or a client. They live in the vault, sealed with the logins ([decision 0028](0028-one-secret-store-for-logins-and-connector-secrets.md)).

- **A connector** is a remote MCP server reached over Streamable HTTP, or one the server starts by command. Both are generic: the gallery is J3 Bots' own curated list (original text, glyphs J3 Bots draws) and the MCP Registry's search, and nothing in the server knows a particular service.
- **The operator connects; a bot only suggests.** Any paired client can add a connector, sign in to it and choose which bots use it. A bot can put a suggestion card in its conversation and nothing more: no bot tool adds a connector or grants one, since that would widen what the bot can reach on its own say.
- **A connector is the operator's for chosen bots.** Each has a grant: every bot, or a list. A new connector goes to the bot that suggested it, or, added from Settings, to the primary bot; the operator widens it to more bots or to all of them in one step. The server checks the grant on every call.
- **The operator accepts the tools.** What a connector offers is recorded when it is connected and shown to the operator, and a tool it adds later, or one whose description or input changes, is held from every bot until the operator accepts it. A server can change what its tools say at any time, and what they say is text the model reads.
- **Sign-in on the server.** The server runs the OAuth flow (discovery, client registration, PKCE, the resource indicator) and renews tokens. The browser opens on the device the operator uses, and the redirect returns to the server's own `https:` address, or to that device, which relays it, or, from the web client, as an address the operator pastes back.
- **An ended sign-in tells the operator once, when a bot needs it.** When a bot's call finds that a connector needs a new sign-in, that bot's conversation gets one card, which notifies. A sign-in that ends while no bot calls it changes only its status in Settings: nothing is pushed for a connector nobody is using.
- **Started by command only from the web and desktop apps, in this release.** Such a server runs on J3 Bots' machine as its user, with everything that user can reach. The Android app shows these connectors and adds none, so the riskiest form is not added from the device most easily lost. A paired phone holds the operator's authority all the same ([Security](../architecture/security.md#trust-model)), so this is the apps' convention, not a wall the server keeps.
- **Glyphs are J3 Bots' own.** A connector shows a glyph J3 Bots ships, or its first letter. No client fetches a remote favicon, which would tell a third party when the operator opens the gallery and show whatever image that host chose.

## What it costs

- J3 Bots now carries an MCP client, an OAuth client and a token renewal worker, and their upkeep as the MCP specification moves. It fetches addresses that remote servers name, so it needs a guard against requests into the operator's own network.
- One-tap sign-in works only with services that let any client register. Others, Google's and Slack's among them, need an OAuth client the operator registers, which a connector's page guides them through; a service that offers only a token takes it in a masked field.
- On a server reached over plain HTTP on the LAN, the browser cannot return to the server: the desktop and Android apps relay it, and the web client asks the operator to paste an address, which is clumsy.
- A connector's tools add to what every model call carries.

## What was rejected

- **MCP servers in the harness's configuration, per bot.** Files the bot can edit, and a new session for every change.
- **The harness's own sign-in.** The token would be within the bot's reach, and the sign-in would need a browser on the server.
- **Integrations of J3 Bots' own, per service.** Each one would be code to keep in step with a service J3 Bots does not control; the MCP server is the service's own.
- **Every bot by default.** A connector acts in the operator's accounts; one bot that needs it should not hand it to every other.
- **A push for every ended sign-in.** Most would be about a connector nobody needs at that moment.
