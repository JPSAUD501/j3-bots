# Running J3 Bots on a Raspberry Pi

This guide sets up the J3 Bots server as a systemd user service on a Raspberry Pi 4 running 64-bit Raspberry Pi OS. Any arm64 or x64 Linux machine with systemd works the same way. Clients reach the server from the local network, or over Tailscale.

## What you need

- A Raspberry Pi 4 with 4 GB of memory or more, on 64-bit Raspberry Pi OS (`uname -m` prints `aarch64`).
- About 3 GB of free disk. The engine is about 200 MB once downloaded. The database and the bots' files grow with use.
- About 1.5 GB of free memory while a bot works. Measured on a Raspberry Pi 4 with 4 GB (release 0.0.0, engine 0.1.11-nightly.20261120.4969): the server takes about 120 MB and the engine about 400 MB with no turn running, and a harness adds its own while it runs, about 225 MB for Claude Code. The service's memory peaked at about 1.3 GB over its first start and one turn.
- Node 26 (J3 Bots is built and tested on 26.13.1), pnpm 12 and Git. One way to get Node is [fnm](https://github.com/Schniz/fnm): `fnm install 26.13.1`. pnpm then installs with `npm install --global pnpm@12.16.1`.
- The harnesses your bots will run on, such as Claude Code (`claude`) or Codex (`codex`), installed and signed in as the user that runs J3 Bots.

No Docker and no root access are involved, except one `sudo loginctl` command so that the service starts at boot.

## Choose the user it runs as

A bot in full access can do anything its user can do. On a Pi that holds SSH keys to the rest of your network, run J3 Bots as a **dedicated user**: one with no SSH keys, no sudo, its own provider sign-ins and no access to your own home ([Security](../architecture/security.md#running-on-a-machine-that-matters)).

```sh
sudo adduser --disabled-password --gecos "" j3bots
sudo loginctl enable-linger j3bots
sudo -iu j3bots
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
```

`enable-linger` starts that user's systemd manager at boot, with no login. `XDG_RUNTIME_DIR` lets `systemctl --user` find that manager from a `sudo -i` shell. Do everything below as that user, including installing Node, pnpm and the harnesses, and signing in to them.

## Install

```sh
git clone https://github.com/JPSAUD501/j3-bots.git ~/j3-bots
cd ~/j3-bots
pnpm install --frozen-lockfile
pnpm build
mkdir -p ~/.local/bin
ln -sf ~/j3-bots/apps/server/dist/bin.mjs ~/.local/bin/j3-bots
```

`pnpm build` builds the server into `apps/server/dist/` and the web client into `apps/web/dist/`, which the server serves on its own address. The server bundle carries every dependency it needs. You can drop the development tools with `pnpm install --prod --frozen-lockfile`, but building again then needs a full `pnpm install` first.

Most systems put `~/.local/bin` on `PATH` at the next login. Until then, run the commands as `~/.local/bin/j3-bots`.

## First run

```sh
j3-bots doctor
j3-bots service install
```

`doctor` checks the machine before anything starts ([what it checks](#what-doctor-checks)). Fix every ✗ it reports. A `!` is a warning: the server still runs.

`service install` does the following, in this order, and stops at the first step that fails. A failure in any step before it writes the unit leaves an installed unit as it was:

- checks the configuration as the service will run it, and the data directory, `~/.j3-bots`, which must be open to this user only and writable by it. A refused configuration leaves the data directory as it was, or uncreated;
- creates the data directory, readable by this user only, if it does not exist yet;
- writes `~/.j3-bots/config.json` with the defaults, if there is none yet. An existing file is never rewritten;
- checks that nothing but a socket is at `~/.j3-bots/admin.sock`, where the admin socket goes, and that `host` is still an address of this machine, by listening on it for a moment on a port the system picks;
- stops if a server you started yourself, with `j3-bots serve`, is already running for the data directory. A server that answers the way this release does names its process, and it is the service's only if that process is the unit's main process. One that answers otherwise, such as an older release, is the service's only if the kernel shows the unit's main process holding the admin socket; when that cannot be told, `service install` stops and asks you to stop that server first;
- writes the unit `~/.config/systemd/user/j3-bots.service`, whole: to a new file beside it first, which then replaces it, so a full disk or an interruption never leaves half a unit;
- enables the unit and starts it;
- waits up to a minute for the service's own server to answer (its process must be the unit's main process), and says whether it did and what state the engine is in.

From the unit on, a failure leaves the new unit installed: systemd may still refuse the start request, as while its start limit holds ([The unit](#the-unit)), or the server may fail to start or not answer within that minute. Run `j3-bots doctor` to see what state the service and the server are in, then read why in the log: `journalctl --user -u j3-bots -n 100`.

On its first start, the server downloads the engine it is pinned to into `~/.j3-bots/engine`, so the engine may still be starting when `service install` returns.

The unit records the real path of the Node that ran `service install`, this checkout's server bundle and the `PATH` of the shell you ran it from, so the engine finds the harnesses. Each folder on that `PATH` is recorded by its real path, and folders under `XDG_RUNTIME_DIR`, such as the per-shell links fnm makes, are left out because they are gone after a reboot. Two cases need `service install` again:

- after you install Node somewhere else;
- after you install a harness in a folder that was not on that `PATH`.

The service does not see `J3_*` variables from your shell, nor from the user manager's environment (the unit unsets them): it runs with `config.json` alone. `service install` checks the configuration without them and names any it finds, and `doctor` warns about them while the service is installed. Put lasting settings in `config.json`. `J3_ENGINE_BINARY` is for testing an engine build by hand; it has no `config.json` key, and the service never uses it.

If you did not create a dedicated user, turn lingering on for your own user so that the service survives a logout and starts at boot. `doctor` and `service install` both remind you:

```sh
sudo loginctl enable-linger "$(id -un)"
```

### Connect the providers

Bots run on Claude Code and Codex, each with a home of its own in `~/.j3-bots/providers`, so they use none of your own setup or sign-ins. Give them a way to their models: an endpoint that speaks Anthropic's Messages API and OpenAI's Responses API, such as CLIProxyAPI in front of your subscriptions. With the service running:

```sh
j3-bots provider connect --base-url http://127.0.0.1:8317
```

It asks for the endpoint's key without showing it; a script can pipe the key on standard input instead. Run without `--base-url`, it asks for the base URL first. Give the base URL without `/v1`: each harness adds what it needs. It must be `https`, or `http` to this machine, as here, since the key travels with every request. The key goes only into the engine's secret store. Run it again to change the endpoint or the key: the base URL and the key change together. The command restarts the engine so every bot uses the new connection at once, and says when the engine is back. A restart stops the work bots have running, so when any bot has some, it says so and asks before changing anything; `--yes` answers for you, and a script that pipes the key without `--yes` is refused and changes nothing. With no work running it restarts without asking. The providers show as ready a few seconds after the engine is back, once it has checked them: `j3-bots doctor` shows each provider's state, and until one is connected says to run this command. A bot can use the models the engine lists for its provider, so the endpoint has to route those names.

Without such an endpoint, sign each harness in inside its J3 Bots home instead, as this user: `CLAUDE_CONFIG_DIR=~/.j3-bots/providers/claude-code claude auth login` and `CODEX_HOME=~/.j3-bots/providers/codex codex login`. This release has not been tested that way ([open question 2](../open-questions.md)).

### When `lan` is refused

If the Pi has a public IPv4 address, the default `"host": "lan"` is refused, and `doctor` and `service install` say so, naming the address. Nothing is created then, so create the data directory and the configuration yourself, with `host` set to one private address of the Pi, such as its home network or Tailscale address (`ip -4 addr` lists them):

```sh
mkdir -m 700 ~/.j3-bots
cat > ~/.j3-bots/config.json <<'EOF'
{
  "host": "192.168.1.40",
  "port": 3737,
  "toolPort": 3739,
  "enginePort": 3738,
  "webClient": null,
  "tls": null
}
EOF
j3-bots doctor
j3-bots service install
```

To serve the public address instead, set `host` to it and `tls` to a certificate and key ([Configuration](#configuration)).

### The unit

- `Restart=on-failure` restarts the server five seconds after it fails. systemd allows five starts in five minutes, and counts every start, by hand or by restart, failed or not. Past that, it stops trying, and for the rest of those five minutes refuses to start the service again, even once the cause is fixed. A stop that outlasts `TimeoutStopSec` also leaves the unit failed. Either way, `doctor` reports the service as failed: read why with `journalctl --user -u j3-bots -n 100`, clear the limit with `systemctl --user reset-failed j3-bots`, then run `systemctl --user restart j3-bots`. `doctor` says so too.
- `MemoryHigh` is 60% of the machine's memory: about 2.4 GB on a 4 GB Pi. Above it the kernel reclaims the service's memory first, which leaves room for the rest of the system. It covers the processes in the service's cgroup, the server and the engine. The harnesses the engine starts (Claude Code, Codex) run in systemd scopes of their own, outside it, so it does not limit them. It needs the kernel's memory controller. Raspberry Pi OS kernels may disable it. `doctor` reports that case, and the fix is `cgroup_enable=memory` at the end of the single line in `/boot/firmware/cmdline.txt`, then a reboot.
- On stop, systemd sends SIGTERM to the server alone (`KillMode=mixed`). The server stops the engine and its children itself. Its shutdown budget is about 17 seconds: 5 for open requests, 2 for open WebSockets to close, and 10 for the engine. The hard bound is systemd's: after 30 seconds (`TimeoutStopSec`) it kills whatever is left. A connection still open when the 5 seconds are up, such as one whose request never finished arriving or a TLS handshake that never completed, is cut then, so it cannot hold the stop until systemd kills the engine too. The server exits with status 130 when SIGTERM stops it, which the unit counts as success (`SuccessExitStatus=130`), so a stop or a restart that ends within those 30 seconds does not leave the unit `failed`. It does not reset the start limit either: a start after a clean stop is still refused once five starts fall within five minutes.

## Configuration

`~/.j3-bots/config.json` holds every setting at its default:

```json
{
  "host": "lan",
  "port": 3737,
  "toolPort": 3739,
  "enginePort": 3738,
  "webClient": null,
  "tls": null
}
```

`"host": "lan"` serves every IPv4 address of the Pi, as long as each one is private: a home network, or Tailscale. The server refuses to start while any of them is public, with or without a TLS certificate, and it closes, unread, any connection that reaches it on an address that is not private, such as one that appears after it started. On a Pi behind a carrier's modem, an address in 100.64.0.0/10 may be the carrier's NAT rather than Tailscale; it counts as private, so check `ip addr` before you rely on it. A `host` set to one address must be an IP address the Pi has when the service starts at boot, or the start fails; `lan` has no such dependency. Edit the file, then run `systemctl --user restart j3-bots`. An unknown key or an invalid value stops the start with a message that names it. The full list, with the environment variables that override each setting, is in [Server: configuration](../architecture/server.md#configuration).

## Pair a device

```sh
j3-bots pair
```

```text
Pairing code: 7Q2MV-K9XDA

It works once, for the next 5 minutes.
The server listens at:
  http://192.168.1.40:3737
  http://100.101.102.103:3737
On the new device, open J3 Bots at one of these addresses and enter the code.

Scan this with a phone's camera to open J3 Bots at http://192.168.1.40:3737 with the code filled in.
For another address, run `j3-bots pair --address <address>`.
(a QR code, drawn in the terminal)
```

`pair` asks the running server for the code over its admin socket, `~/.j3-bots/admin.sock`. Only this user can connect to that socket, so the command works only on the Pi, as the user that runs the service. The addresses come from the server too: the port and scheme it listens on and, with `lan`, the Pi's private addresses, leaving out container and virtual-network interfaces such as `docker0`.

On the new device, open one of those addresses in a browser: the server serves the web client there, which asks for the code. On a phone, scan the QR code with the camera instead: it opens the address it carries, at `/pair`, in the browser with the code filled in, and you check the server it names and press Pair. The QR code carries the first address listed, and the addresses are listed in the order the Pi lists its network interfaces, so which network comes first depends on the Pi, not on a rule. For a phone that reaches the Pi on another of them, such as over Tailscale, name that address: `j3-bots pair --address http://100.101.102.103:3737`. `--address` takes a bare address (scheme, host and port, no path) that the phone reaches exactly as written: one of the listed addresses, or an `https` address the Pi is reached at, such as a domain a proxy serves; `https` only where the server or its proxy serves HTTPS. Any other value is refused before a code is made. The QR code is printed last, under the lines that say where it goes; the terminal must be large enough for those lines, the QR code and the prompt after it. When it is not, or when the output goes to a file or a pipe, `pair` prints the link as text instead and says how large the terminal must be. A device already paired shows the same in Settings → Devices, where you can pick another address for the QR code. A code typed in lower case, or with spaces or dashes, works too. `j3-bots doctor` says whether the server serves the web client.

A browser treats a plain-HTTP address other than `localhost` as insecure, and on such an address it does not install J3 Bots as an app (a PWA). To install it on a phone, serve HTTPS: put a certificate and key in `tls` (paths relative to the data directory work), or serve it through a platform that holds the certificate ([Serve it through a container](#serve-it-through-a-container)). With Tailscale, `tailscale cert <machine>.<tailnet>.ts.net` issues one for the Pi's tailnet name. Over HTTPS, `pair` prints the names on the certificate, such as `https://<machine>.<tailnet>.ts.net:3737`, and no bare addresses, which the browser would not accept. A wildcard name names no one host, so it is not printed; for a certificate with only wildcards, open a name it covers.

## Serve it through a container

Some platforms publish only containers, behind a proxy of their own that holds the certificate: Coolify, for one, or a tunnel that does the same. For them, [`deploy/container-proxy/compose.yaml`](../../deploy/container-proxy/compose.yaml) runs a small Caddy container that forwards HTTP and WebSocket traffic, unchanged, to the server on the host. The server keeps running as its systemd user service.

1. Leave `host` at `"lan"` and `tls` at `null` ([Configuration](#configuration)). The container reaches the server at `host.docker.internal`, which Docker points at the host's address on its bridge network. That address is private, so `lan` serves it.
2. On the platform, create a Docker Compose app from this repository, with `deploy/container-proxy/compose.yaml`, on the machine that runs J3 Bots. Give its `proxy` service your domain on port 8080, such as `https://bots.example.com:8080`. If the server listens on a port other than 3737, set `J3_PORT` to it.
3. Deploy. The container counts as healthy while the server answers, so the platform routes to it only then.

On a new device, open your domain and pair as usual. `j3-bots pair` prints the server's own addresses, not the domain; for a QR code to the domain, run `j3-bots pair --address https://bots.example.com:8080`. Devices, opened at the domain, puts the domain in its QR code.

The server authenticates every request itself, with the device's token, and sets no cookies, so the proxy needs no settings for cookies, origins or WebSockets. A proxy that asks for a sign-in first, such as a single sign-on gate, works in front of it too. The web client sends credentials when it asks for its manifest, so the browser still offers to install it. Behind such a gate, sign in on the phone before you scan a QR code, or pair by typing the code instead: a phone that is not signed in yet is sent to the identity provider's page, and the browser carries the link's fragment, which is the pairing code, along with that redirect to the provider's address (**Verified** in Chromium with a cross-origin redirect).

Bots run with full access to the user that runs J3 Bots. On an address the internet can reach, anyone can open the pairing page. A pairing code is made only on this machine and works once, for five minutes, but a sign-in gate in front adds a second lock that does not depend on this release's code. Use one if your platform has it.

## Logs

```sh
journalctl --user -u j3-bots -f          # follow
journalctl --user -u j3-bots -n 200      # the last 200 lines
systemctl --user status j3-bots
j3-bots service status
```

The server writes one JSON object per line. If `journalctl --user` shows nothing, the journal is not stored on disk. Then run `sudo mkdir -p /var/log/journal` and `sudo systemctl restart systemd-journald`.

## Update

```sh
cd ~/j3-bots
git pull
pnpm install --frozen-lockfile
pnpm build
systemctl --user restart j3-bots
j3-bots doctor
```

The server migrates its database when it starts. If the new release pins another engine version, the server downloads that version on its first start. The server looks for the web client when it starts: if it was not built then, it is served only after a restart.

## Back up

Everything J3 Bots keeps is in the data directory: the configuration, the database, the bots' memory and workspaces, attachments and the engine's own data. Stop the service while you copy it, so that the database and the files match:

```sh
systemctl --user stop j3-bots
(umask 077 && tar -C ~/.j3-bots --exclude=./engine/j3/runtime --exclude=./admin.sock \
  -czf ~/j3-bots-$(date +%F).tar.gz .)
systemctl --user start j3-bots
```

`umask 077` creates the archive readable by you alone from the start. It holds the bots' files, the device tokens' hashes, the providers' key in `engine/userdata/secrets` and `engine/j3/credential.json`, the bearer credential the server signs in to its engine with, which lets whoever has it start agents with full access. Keep it where only you can read it. `engine/j3/runtime` is the downloaded engine, which the server downloads again.

To restore:

1. Stop the service.
2. Move `~/.j3-bots` aside.
3. Run `mkdir -m 700 ~/.j3-bots && tar -C ~/.j3-bots -xzf <archive>`.
4. Start the service.

## Remove

```sh
j3-bots service uninstall
```

This stops the service, disables it and deletes its unit. The data directory stays, and the command names it: the one the unit ran with, which `service status` also shows. Delete it yourself if you mean to.

## What `doctor` checks

Each line is ✓ (fine), `!` (a warning: the server runs, but something is missing), ✗ (a problem to fix) or `-` (not checked). A warning or a problem carries its fix when `doctor` knows one. `doctor` exits with status 1 when it reports any problem.

| Check | What it looks at |
| --- | --- |
| Node | The Node running it has the major version J3 Bots is built on. |
| Configuration | `config.json` and, while the service is not installed, the `J3_*` variables decode and pass the checks the server makes at start. Some examples: a public address without TLS, two settings on one port, a TLS certificate and key that do not load as a pair, a web client folder that overlaps the data directory, and a data directory inside a Git checkout. With the service installed, every check describes the service: its data directory, its `config.json` and its `PATH`. |
| Shell settings | With the service installed, a warning for each `J3_*` variable in your shell, which the service does not get, and a problem for one whose value the server would refuse. |
| Data directory | It is a folder this user owns and can write to, and no group or other user can open it. Otherwise the server does not start, and `doctor` reports the cause, with the fix when it has one, such as the `chmod` or `chown` command. |
| Disk space | Free space where the data directory is: less than 1 GB is a problem, less than 3 GB a warning. |
| Server | Whether a server answers on the admin socket, its version and the address it listens on. Something that is not a socket where the admin socket goes is a problem, since no server can start, with the `mv` command that clears it. |
| Ports | With the server running, the ports it listens on, and a problem if the engine's port was taken. With no server running, that the server's port, the bot tool port and the engine's port are free on their addresses. |
| Engine | That the pinned engine has a release for this machine, whether it is installed yet, and, with the server running, the state the server reports for it. |
| Claude Code, Codex | That the harness is on the `PATH` the service runs with (your shell's while the service is not installed), and what the engine reports about the server's providers on it. |
| Web client | Whether the running server serves the web client, as it reports it. With no server running, whether a client is built where the server would serve it from. |
| Pairing | How many devices are paired. |
| Service | That the unit is installed, enabled and running, and has not failed. A unit that is still `activating` is a warning: it is starting or restarting, and the log says which. |
| Start at boot | That lingering is on for this user. |
| Memory limit | That the kernel lets the service's `MemoryHigh` apply. |

`doctor` reads; it changes nothing. It is safe to run while the service runs.

## Known limits in this release

- With Claude Code and Codex reaching their models through a CLIProxyAPI endpoint (the provider connection), the engine reads no usage limits for them, so the server reports none. That is the setup tested so far.
- Bots choose among the models the engine lists for each provider. An endpoint that names its models otherwise cannot be used for them yet.
