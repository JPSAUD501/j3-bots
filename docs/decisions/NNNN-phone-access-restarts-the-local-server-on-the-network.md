# NNNN: Phone access restarts the local server on the network

**Status:** Proposed

## Context

The desktop app's own server listens on `127.0.0.1` ([decision 0024](0024-the-local-server-is-a-supervised-child-of-the-app.md)), so only that computer reaches the bots. An operator with no always-on machine still wants them on a phone at home. The server already knows how to serve a local network safely: `lan` listens on every IPv4 interface, serves private addresses only, refuses to start while any is public, closes a connection that reached any other address, and over plain HTTP answers only a request whose `Host` is an address, `localhost` or its `publicOrigin` ([Security](../architecture/security.md#j3-bots-own-surface)). A server listens where it was started; it cannot move to other interfaces while it runs.

## Decision

**Phone access is a choice the app keeps, and the server starts on `lan` while it is on.** The desktop settings keep `phoneAccess`, off by default. Each start the supervisor makes asks where to listen: `127.0.0.1` while it is off, `lan` while it is on. Changing the choice stops the server and starts it again through the same start path as every other start, an update's transition included. While bots have work running, the page asks before that restart, since it stops the work.

**The server's own `lan` rules are the only rules.** The app adds no listener, proxy or Host list of its own. It reads the machine's addresses before each start and keeps the server on `127.0.0.1` while one is public, saying why, as the server would refuse `lan` there. A start on `lan` that ends without the server answering is followed by one on `127.0.0.1`, so the app is never left without its server, and the operator sees what the server said and can try again.

**A phone pairs as any device does.** The page asks the server on the admin pipe for a pairing code and shows the pairing link, `<origin>/pair#<code>`, for a private origin the server reports. The page never gets a token for the phone.

## Consequences

- Turning phone access on or off restarts the bots, which stops their running work. The operator is asked when there is work to stop.
- Over plain HTTP on the local network, anyone on it can read a device token in transit. Settings says to turn it on only on a trusted network.
- The app watches no network change. It reads the addresses at each start, each change of the choice, each Try again, each time Settings or a pairing code is shown and on wake. A public address that appears while the server runs on `lan` is refused by the server, connection by connection.
- Paired phones stay paired while it is off, and reconnect once it is on again.
- The system's firewall may ask once (Windows, macOS) or silently drop connections (ufw). Settings says which for the operator's system.
- A start on `lan` that fails during an update's transition counts as the new release not getting ready, so the update rolls back; Try again then starts the new release again (**Assumed** from the transition's code; not run).

## Rejected

- **A second listener, or a proxy in the app, on the network.** It would need its own address checks, Host checks and TLS story beside the server's, and two ways in to keep equal.
- **Listen on `lan` always, with access decided per request.** The server would be reachable from the network, and its pairing page with it, even for an operator who never wanted a phone.
- **A stricter Host list in the app's mode (only the origins shown).** Over plain HTTP the server already answers only addresses, `localhost` and `publicOrigin`. DNS rebinding needs a name, which this already refuses. Listing only the shown origins would refuse the Android emulator's `10.0.2.2` and an address that appeared after the list was made, and protect against nothing more.
- **Watch the network and restart when it changes.** Interfaces come and go with sleep, VPNs and Wi-Fi roaming; each change would stop the bots' work. The server's per-connection check already refuses a public address that appears.
