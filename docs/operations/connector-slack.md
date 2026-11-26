# A Slack connector with your own app

**Draft.** Connectors are new in 0.4.0, and no step below has been run against Slack yet. What this page says about Slack comes from Slack's documentation and is **Assumed** until a sign-in confirms it.

**Not reachable in 0.10.0.** The apps of this release have no screen that takes your app's client, and a bot refuses a server that needs one, so a Slack connector can't be added now ([decision 0068](../decisions/0068-settings-lists-what-the-bots-added.md)). The steps below stay for the release that brings that screen back; a Slack connector added before 0.10.0 keeps working.

Slack's MCP server does not let a client register itself (dynamic client registration), so J3 Bots cannot sign in to it on its own. You create a Slack app and give J3 Bots its client ID and secret when you add the connector. J3 Bots keeps them in its secrets and never replaces that app with one of its own ([Server: connectors](../architecture/server.md#connectors)).

## Where your sign-ins return

Slack sends the browser back only to a redirect URL registered on the app, matched exactly, trailing slash included. J3 Bots gives each authorization server a path of its own under `/oauth/callback`, named after its issuer: `slack.com` here (**Assumed**, from the issuer Slack's metadata names). So sign in in a way that returns to a fixed address:

| You sign in from | The redirect URL to register |
| --- | --- |
| Any device, with the server at an `https:` address (`publicOrigin`) | `https://<your server>/oauth/callback/slack.com` |
| The desktop app, running the bots on its own computer | `http://127.0.0.1:3737/oauth/callback/slack.com`, with the server's port |

The first row is the one to prefer. Whether Slack accepts a plain-`http` loopback address is not settled (**Assumed** that it may not). A sign-in relayed by the desktop or Android app from a server elsewhere returns to a port the app picks each time, which an exact match cannot cover. The web client's pasted sign-in returns to `http://127.0.0.1/oauth/callback/slack.com`, which is one fixed address, with the same question about plain `http`.

## Create the app

1. At Slack's app management page, create an app from scratch in your workspace.
2. Under **OAuth & Permissions**, add the redirect URL from the table, and the user token scopes the MCP server asks for. J3 Bots asks for the scopes the server names in its sign-in challenge, or else in its metadata.
3. Turn on the app's Model Context Protocol access. Slack lets only internal apps and apps published in its directory use its MCP server.
4. Copy the client ID and the client secret from **Basic Information**.

## Add the connector

Open Slack in the gallery. Its page shows these steps and the redirect address for the way you are signing in, and names Slack's issuer (**Assumed** `https://slack.com`, the one Slack's metadata names): give it the client ID and the secret, then sign in. J3 Bots uses the app only with that issuer, so the secret never reaches another server, and sends it only to Slack's token and revocation endpoints.

## What to expect

- A redirect URL that differs in any character fails at Slack's consent page, before anything reaches J3 Bots. Fix it on the app, save, and sign in again.
- Removing the connector revokes its tokens where Slack offers that, and leaves your app as it is.
