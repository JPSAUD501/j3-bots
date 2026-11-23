# 0020: The local desktop gets its device through the admin channel, never over TCP

**Status:** Accepted

## Context

The desktop app can run its own J3 Bots server, as a child process of its main process, on the same computer ([Clients: desktop](../architecture/clients.md#desktop)). Its page still talks to that server as every client does, with a device token over HTTP and a WebSocket. Something has to give the app that token, with no address to type and no pairing code to copy.

Every other client gets its token by pairing: a code made on a paired client or with `j3-bots pair`, sent to `POST /api/pair` on the client listener. That route is on the network, so it is guarded by a global lockout: five wrong codes in fifteen minutes lock pairing for everyone. Any web page in a browser on the computer can post to a loopback port, and so can anyone on the LAN while the server listens there, so routing the app's own pairing through it would let them hold the app out, or make the app lift a lock that protects against them.

The server already has a channel only its own OS user can reach: the admin socket, a Unix socket in the private home, which `j3-bots pair` uses to make codes. Windows has no such socket that is safe: Node serves a socket path there as a named pipe, whose default access other users of the machine have, and whose name another user can take first (**Assumed**, from Node's and Windows' documentation). A pipe the app passes to the server as an inherited descriptor has neither problem: it has no name, and only the two processes hold it.

## Decision

The desktop app gets the device it uses with the server it runs from that server's admin channel, never over TCP.

- The admin protocol has `POST /local-device {name, replaces}`, answering `{deviceId, token}`. It pairs a device as a successful pairing does, with no code and outside the lockout, and in the same transaction revokes `replaces`, the device the app kept before, as `device.revoke` does. The device is an ordinary one: listed, revocable from any client, `CurrentDevice` everywhere.
- The admin channel is the admin socket on Linux and macOS, and a pipe the server inherits on descriptor 3 from the app that starts it (`j3-bots serve --admin-fd 3`), which serves the same routes on every system and is the only admin channel on Windows. It is never a named pipe, and the client listener has no such route.
- The app never asks for a new device by itself after a revocation. A revoked desktop says it was signed out, and asks again only when the operator signs in again.

## Consequences

- No code is made for the app, none crosses the network, and the lockout neither applies to the app nor is lifted for it.
- Who can get a device this way is who can already run `j3-bots pair`: the server's OS user, which includes every bot's shell ([Security: trust model](../architecture/security.md#trust-model)). It gives no one a power they lacked.
- A crash between the mint and the moment the app stores the token leaves an orphan device; the next mint names it in `replaces` and revokes it, since the app keeps the device id even when it cannot open the sealed token.
- The pipe is one HTTP/1.1 connection for the life of the server: the server never closes it while idle, and a client that abandons a request loses the channel, so the app treats a closed pipe as a lost server ([Server: the admin channel](../architecture/server.md#the-admin-channel)).
- The app can get a device only from a server whose admin channel it reaches: the server it started, or one whose socket it can open as the same user.

## Rejected

**A pairing code from the admin socket, used on `/api/pair`.** Needs no new route. The code crosses loopback TCP for nothing, and the app would meet the global lockout and have to lift it on each sign-in, lifting with it the protection against the LAN.

**A one-time secret handed to the child, exchanged on the client listener.** This is T3 Code's approach for its own desktop: a secret on an inherited descriptor, traded at a loopback HTTP route for a session. The route that mints credentials then sits on the network listener, reachable from the LAN while phone access is on and from rebound pages, guarded only by the secret. A restarted server needs a new secret from the parent, so the app cannot use a server it did not start.

**A token file in the home.** Reachable by the same user as the admin socket, but it leaves a bearer at rest in plain text.

**Checking the peer's user on loopback TCP** (`/proc/net/tcp`, `SO_PEERCRED`). Linux-only and fragile.
