# 0090: A connector signs in as a service, with credentials the operator gives

**Status:** Accepted.

## Context

J3 Bots signed a connector in one of two ways: a person's OAuth sign-in (the authorization code with PKCE, [decision 0047](0047-j3-bots-is-a-complete-mcp-host-at-the-current-specification.md)), or a key the connector's form or headers carry ([decision 0049](0049-the-bots-manage-mcp-servers-and-skills.md)). Some servers sign in no person. A build server, an internal tool or a company's own service takes a client the operator registers at it, and that client gets its own token with the client credentials grant (RFC 6749 §4.4). MCP describes this in its OAuth client credentials extension, `io.modelcontextprotocol/oauth-client-credentials`, stable with revision 2026-07-28: the client proves itself with an assertion its private key signs (RFC 7523 §2.2, recommended) or with its secret; the authorization server lists `private_key_jwt` or `client_secret_basic` among its methods, and its signing algorithms for a key; the token request carries the `resource`. No registration takes place (**Read** in the extension's specification, `modelcontextprotocol/ext-auth`). J3 Bots could not connect to such a server at all: discovery refused it for having no authorization endpoint or no PKCE.

The owner asked for it to be well made: the bot connects and uses connectors, and the person does not configure them. Whoever registers the client is the operator; only they can give its values, and no bot may see them ([decision 0046](0046-secrets-the-operator-types-a-bot-uses-a-reference.md)).

Three parts of sign-in hardening were checked at the same time. A person's sign-in already checks the `iss` an authorization server sends on its redirect (RFC 9207), and a code from one authorization server cannot finish a sign-in at another, since each has a redirect path of its own. A 2025-era server's `-32042` error, which names a step the operator must finish on the server's own page, reached the bot as the call's error.

## Decision

**The bot asks for the client's values on one card, and gives the connector references to them. J3 Bots does the rest: it pins the authorization server, gets the token, and tells the bot in plain words when the service refuses the values.**

- **One card, every value.** `ask_for_secret` takes `kind: values`: two to four values, each with a name, a label in plain words, and whether it is shown as typed (a client ID) or hidden (a secret or a key). It may name the `https:` page where the service issues them (`setup`), which every ask's card links to. The card is one `secret-ask` entry with `values` and `setup`, answered with `secrets.addFromAsk`, which saves each value as a single-value secret under its own name, for the bot that asked or every bot, and refuses an answer that leaves one out. The bot is answered with every reference and woken with each of them; it never sees a value. This is [decision 0081](0081-one-secret-card-asks-for-every-value-at-once.md)'s rule, one card for what goes together, for J3 Bots' own secrets.
- **References, never values.** `add_mcp_server` and `update_mcp_server` take `clientCredentials` for a connector added by address: the client ID, and the client secret or the private key, never both, each a `${secret:<name>}` reference, the secret or key a whole reference and never typed; optionally the issuer the service names and the scopes. They are checked and kept as any reference a connector's settings name.
- **The issuer, pinned.** When they are given, J3 Bots finds the authorization server as a sign-in does and keeps its issuer with them. It must offer the grant, when it lists grants, and a way for the credential to prove itself; an issuer the bot named must be the one found. The values go to that issuer's token endpoint alone. Changing them keeps the issuer. When the connector's server names another authorization server later, nothing is sent there: the connector is `failing` (`issuer-changed`), and only removing it and adding it again, which the operator sees, takes another.
- **The assertion is good once, at one server.** A key signs an assertion that names the client as issuer and subject and the issuer alone as audience, as the update of RFC 7523's audience rules asks (draft-ietf-oauth-rfc7523bis), good for five minutes with a random `jti`. A secret goes in a Basic header where the server takes one, else in the body.
- **The token stays in memory.** It is asked for with the `resource` and the scopes, kept in memory only, and replaced when a call finds it within a minute of expiry: the grant gives no refresh token, so a new token is the refresh. One request runs at a time per connector.
- **A refusal is plain words, once.** A token endpoint that refuses the client, or a key nothing can be signed with, makes the connector `needs-secret` (`refused`), naming the credential's secret, and the bot's call is told to ask for new values with one card. The service is asked nothing more with those values, told apart by a digest kept in memory, until they change. A token the connector's server refuses is replaced once; refused again, the values are.
- **No sign-in card where none can work.** A server whose authorization server offers the client credentials grant and not the authorization code one gets no `connector-auth` card: `add_mcp_server` tells the bot to ask for the values instead. Credentials given to a connector that had a person's sign-in sign it out.
- **Declared.** Every session puts the extension in the client's capabilities.
- **`-32042` is a card.** Each step, up to three, becomes the `connector-input` card for a page, which the operator opens on their device. The call waits, within its time, until the server says the step is finished, then goes again once. A step declined or left unfinished ends the call, and the bot is told which in fixed words. 2026-07-28 has no such error: its servers ask with `input_required`, which J3 Bots already answers (**Read** in `@modelcontextprotocol/server` 2.4.0, which refuses to send `-32042` at that revision).
- **No new protocol.** Every contract change is an optional key or a new literal in an open list, so protocol 11 holds.

## Costs

- **An older client cannot answer a card for several values.** It shows one input, and its answer is refused (`Invalid("answer")`), so the card stays open until the operator answers it on an updated client.
- **What is not taken.** `client_secret_jwt` (an assertion signed with the secret), mutual TLS, and a key that is encrypted or of another kind than RSA of 2,048 bits or more, P-256, P-384, P-521 or Ed25519.
- **A restart forgets.** The token and the digest of refused values live in memory, so a restart asks for a new token once, and asks once more with values the service refused.
- **A moved authorization server needs the operator.** The bot cannot follow it, by design.
- **Tested against a fake.** The tests run a fake authorization server and MCP server that check what a real one checks, the assertion's signature and audience included. That real services answer as the fake does is **Assumed**.

## Rejected

- **The SDK's own client credentials providers.** They would get tokens inside the SDK's transport, outside J3 Bots' guarded HTTP client, its secret references, its redaction and its issuer pin, while J3 Bots is already the connector's OAuth client.
- **A secret kind for client credentials.** One record holding the ID and the secret or key would change every client's secrets screen and the protocol. Single values, one per input, change neither.
- **A form on the connector's page.** Clients add no connector since [decision 0068](0068-settings-lists-what-the-bots-added.md): the operator asks a bot, and the bot asks for what only the operator has.
- **Following the authorization server the connector's server names.** A server that turns hostile, or is taken over, could then send the operator's credentials anywhere.
- **An audience of the token endpoint, or a list.** RFC 7523 allowed either. An issuer alone is good at no other server.
