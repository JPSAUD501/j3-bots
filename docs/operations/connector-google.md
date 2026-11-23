# A Google connector with your own app

**Draft.** Connectors are being built for 0.4.0, and no step below has been run against Google yet. What this page says about Google comes from Google's documentation and is **Assumed** until a sign-in confirms it.

Google does not let a client register itself (dynamic client registration), so J3 Bots cannot sign in to a Google MCP server on its own. You register an app of your own in Google Cloud and give J3 Bots its client ID and secret when you add the connector. J3 Bots keeps them in the vault and never replaces that app with one of its own ([Server: connectors](../architecture/server.md#connectors)).

## Where your sign-ins return

Google sends the browser back to an address you register on the app, and refuses any other. Every address ends in `/oauth/callback/accounts.google.com`: J3 Bots gives each authorization server a path of its own, named after its issuer. Which one you need depends on how you sign in:

| You sign in from | The address the browser returns to | Google client type |
| --- | --- | --- |
| Any device, with the server at an `https:` address (`publicOrigin`) | `https://<your server>/oauth/callback/accounts.google.com` | Web application |
| The desktop app, running the bots on its own computer | `http://127.0.0.1:3737/oauth/callback/accounts.google.com`, with the server's port | Desktop app |
| The desktop or Android app, connected to a server elsewhere | `http://127.0.0.1:<port>/oauth/callback/accounts.google.com`, with a port the app picks each time | Desktop app |
| The web client, pasting the address back | `http://127.0.0.1/oauth/callback/accounts.google.com` | Desktop app |

A Desktop app client accepts a return to loopback on any port and path, as native apps need (RFC 8252), so it covers the last three rows with nothing to register (**Assumed** for the path). A Web application client needs each address registered exactly, and covers the first. If you sign in more than one way, pick the type for the way you use most, or make two connectors.

## Register the app

1. In the Google Cloud console, pick or create a project, and enable the API of the service whose MCP server you connect.
2. Configure the OAuth consent screen: an **Internal** app if your account is in a Google Workspace organization, else **External**, with yourself as a test user. Add the scopes the MCP server asks for. J3 Bots asks for the scopes the server names in its sign-in challenge, or else in its metadata.
3. Create an OAuth client ID of the type from the table. For a Web application, add the redirect URI from the table under **Authorized redirect URIs**.
4. Copy the client ID and the client secret. Google treats a Desktop app's secret as one that cannot be kept, but its token endpoint still expects it (**Assumed**), so give J3 Bots both.

## Add the connector

Add the connector by its address, and give its own OAuth app: the issuer `https://accounts.google.com`, the client ID and the secret. Then sign in. J3 Bots uses the app only with the authorization server you named: a connector whose metadata names another is refused, so the secret never reaches a server other than Google's. It sends the secret only to Google's token and revocation endpoints, in a Basic authorization header.

## What to expect

- An External app left in **Testing** gets refresh tokens that Google ends after seven days, according to Google's documentation. The connector then needs a new sign-in. Publishing the app, or using an Internal one, avoids that.
- Removing the connector revokes its tokens at Google, and leaves your app and its client as they are. Delete the client in the console if you no longer want it.
- A client ID or secret you mistyped fails at the first sign-in with a refused client. Fix it by adding the connector again.
