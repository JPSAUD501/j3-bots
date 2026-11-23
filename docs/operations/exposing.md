# Reaching J3 Bots from elsewhere

Out of the box, the server answers plain HTTP on the machine's private addresses: your home network, and Tailscale if the machine is on a tailnet. That is enough for a browser on the same network. This guide covers HTTPS, Tailscale, a domain served through a proxy, webhooks, and what each choice exposes. Configuration changes are made in `~/.j3-bots/config.json`, followed by `systemctl --user restart j3-bots` ([Configuration](operating.md#configuration)).

## Who can reach it

Bots run with full access to the user that runs J3 Bots. Whoever can open the server's address can open its pairing page. A pairing code is made only on the machine, by `j3-bots pair`, and works once, for five minutes, so reaching the page is not enough to pair. But wrong codes from anyone count towards the lock: after five in fifteen minutes, pairing is locked for everyone for fifteen minutes ([Pair a device](install.md#pair-a-device)). `j3-bots pair --unlock` lifts it at once. Wrong codes you did not type mean someone else reaches the server; the lasting answer is to stop exposing pairing to them, the `/pair` page and `POST /api/pair` alike, with a [sign-in gate](#a-sign-in-gate) or by not publishing the server at all.

Every other request needs a paired device's token, which the server checks itself. Webhooks are the exception: their address is their credential ([Webhooks](#webhooks)).

Over plain HTTP, open the server at an address or at `localhost`, as `j3-bots pair` prints it: the server answers `403` to a request for any other name, such as `http://<machine>.local:3737`, except the one in [`publicOrigin`](#publicorigin). The browser then shows one line saying which addresses the server answers, and the server's log names the refused name and what would serve it: behind a proxy or tunnel that serves it at that name, set `publicOrigin`. A web page on a name its owner points at your machine's address could otherwise talk to the server as if it were its own page ([Security](../architecture/security.md#j3-bots-own-surface)). Web pages cannot lock pairing either: only a JSON request counts as an attempt, and a page cannot send one to another origin.

The ways below, from least to most exposed:

| Way | Who reaches it | HTTPS |
| --- | --- | --- |
| The defaults (`"host": "lan"`) | Your local network | No: browsers do not install the app |
| [Tailscale](#tailscale) | Your tailnet | With `tailscale cert` |
| [Your own certificate](#https-with-your-own-certificate) | Whoever reaches the address you serve | Yes |
| [A proxy or a tunnel](#through-a-proxy-or-a-tunnel) | The internet, unless the platform gates it | Yes, at the platform |

## HTTPS with your own certificate

A browser treats a plain-HTTP address other than `localhost` as insecure, and on such an address it does not install J3 Bots as an app (a PWA). To serve HTTPS, put a certificate and its key in `tls`:

```json
{
  "host": "lan",
  "tls": { "cert": "tls/bots.crt", "key": "tls/bots.key" }
}
```

Paths are relative to the data directory. With TLS, `host` may be any address, a public one included; `lan` still serves private addresses only. `doctor` checks that the certificate and key load as a pair. Over HTTPS, `j3-bots pair` prints the names on the certificate, such as `https://bots.example.com:3737`, and no bare addresses, which the browser would not accept. A wildcard name names no one host, so it is not printed; for a certificate with only wildcards, open a name it covers.

## Tailscale

A machine on a tailnet has an address in 100.64.0.0/10, which counts as private, so the default `lan` serves it with no change. `j3-bots pair` lists it among the addresses; for a phone that reaches the machine over Tailscale, put it in the QR code:

```sh
j3-bots pair --address http://100.101.102.103:3737
```

For HTTPS, `tailscale cert <machine>.<tailnet>.ts.net` issues a certificate for the machine's tailnet name. Put the certificate and key it writes where the user that runs J3 Bots can read them, such as in the data directory, point `tls` at them, restart the service, and open `https://<machine>.<tailnet>.ts.net:3737`. Repeat when the certificate is renewed.

## Through a proxy or a tunnel

Some platforms publish only containers, behind a proxy of their own that holds the certificate: Coolify, for one, or a tunnel that does the same. For them, [`deploy/container-proxy/compose.yaml`](../../deploy/container-proxy/compose.yaml) runs a small Caddy container that forwards HTTP and WebSocket traffic, unchanged, to the server on the host. The server keeps running as its systemd user service.

1. Leave `host` at `"lan"` and `tls` at `null`. The container reaches the server at `host.docker.internal`, which Docker points at the host's address on its bridge network. That address is private, so `lan` serves it.
2. Set [`publicOrigin`](#publicorigin) to your domain, such as `"https://bots.example.com"`, and restart the service. The container forwards the `Host` the platform's proxy received, your domain, and over plain HTTP the server answers only an address or that name, so without `publicOrigin` every request through the domain gets `403`. The container's own health check asks at `127.0.0.1`, an address, and is answered either way (**Verified** with Caddy 2.10.2, which passes the client's `Host` on unchanged).
3. On the platform, create a Docker Compose app from this repository, with `deploy/container-proxy/compose.yaml`, on the machine that runs J3 Bots. Give its `proxy` service your domain on port 8080. If the server listens on a port other than 3737, set `J3_PORT` to it.
4. Deploy. The container counts as healthy while the server answers, so the platform routes to it only then.

A firewall on the host that drops incoming connections by default, such as ufw, drops the container's too: the container then stays unhealthy, and the platform answers 502. Let Docker's networks reach the server's port, for instance with `sudo ufw allow from 172.16.0.0/12 to any port 3737 proto tcp`, which covers the range Docker gives its bridge networks first by default (**Verified** on Ubuntu 24.04 with ufw active: unhealthy without the rule, healthy with it).

On a new device, open your domain and pair as usual. The server authenticates every request itself, with the device's token, and sets no cookies, so the proxy needs no settings for cookies, origins or WebSockets.

The container keeps no access log, and leaves the whole request, its path and headers, out of every line it does log. The platform's own proxy in front of it may log request paths, which matters for [webhooks](#webhooks).

## publicOrigin

When other machines reach the server at an address it does not listen on, such as a domain a proxy or a tunnel serves, tell it:

```json
{
  "publicOrigin": "https://bots.example.com"
}
```

It must be an `https` origin: no path, not even a trailing `/`, in lower case, without a default port. Then:

- a webhook routine's address names it, so the services that call it can reach it;
- `j3-bots pair` lists it first, and its QR code carries it. Settings → Devices, opened at the domain, puts the domain in its QR code too;
- over plain HTTP, the server answers requests for its name, which a proxy that keeps the client's `Host` forwards. Any other name gets `403`.

It changes nothing about where the server listens.

## Webhooks

A routine can run when a webhook is called. Ask a bot for one: the bot creates the routine and is given its address, `<origin>/hooks/<routine id>/<secret>`, which it passes on to you or to the system that will call it. The apps show a webhook routine and its runs, but not its address yet.

- **The origin.** With [`publicOrigin`](#publicorigin) set, the address names it. Without it, the address names the first address `j3-bots pair` would offer, which behind a proxy is a private address the caller cannot reach. Set `publicOrigin` before you create webhook routines. An address given before names the private origin; its path, with the secret, stays valid, so put your domain in front of it.
- **The secret is in the path.** Whatever logs request paths can keep it. The server leaves it out of its own log, and so does the container proxy. The platform's proxy in front of the container may not: Coolify's, for one, can keep access logs with paths, depending on its settings. Check them if you use webhooks.
- **A leaked address.** Change the routine to a schedule and back to a webhook, which gives it a new secret and so a new address.
- **What a caller can do.** Start the routine's run, with up to 64 KiB of UTF-8 text in the body, which reaches the bot as data, never as instructions. At most ten runs a minute per routine. A wrong secret and an unknown routine get the same `404`, and the server reads no body for them.

The full behavior is in [Server: webhooks](../architecture/server.md#webhooks).

## A sign-in gate

A proxy that asks for a sign-in first, such as a single sign-on gate on the platform, works in front of the server, and adds a lock on the pairing page that does not depend on J3 Bots' own code. Use one if your platform has it. The web client sends credentials when it asks for its manifest, so the browser still offers to install it.

Behind such a gate, sign in on the phone before you scan a pairing QR code, or type the code instead. A phone that is not signed in is sent to the identity provider's page, and the browser carries the link's fragment, which holds the pairing code, along with that redirect to the provider's address (**Verified** in Chromium with a cross-origin redirect).

A gate in front of webhooks stops their callers too, unless the platform lets you leave `/hooks/` outside it.
