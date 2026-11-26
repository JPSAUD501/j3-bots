# Installing J3 Bots

This guide takes a Linux machine from nothing to a browser paired with your own J3 Bots server and a first bot that answers. The server runs as a systemd user service of one user, and bots act as that user. Once it runs, [Operating J3 Bots](operating.md) covers configuration, logs, updates, backups and removal, and [Reaching it from elsewhere](exposing.md) covers HTTPS, Tailscale, proxies and webhooks.

> On a Linux x64 or Windows x64 computer of your own, the desktop app can run the bots itself, with nothing to install but the app: choose "Use this computer" on its first screen ([Clients: Desktop](../architecture/clients.md#desktop)). The bots then sleep when the computer sleeps. This guide is for a server of its own, which keeps them awake.

> The one-line command below installs the latest published release. To run code no release has yet, install [from a checkout](#from-a-checkout), or build a release archive and install it from a local mirror as [Releasing](releasing.md#trying-an-install-locally) describes.

## Supported systems

| System | Status |
| --- | --- |
| Linux on x64 or arm64, with a systemd user manager | Supported. CI runs each release archive on Ubuntu 24.04, x64 and arm64: `doctor`, the server, its web client and one bot turn, then an install and removal with `install.sh` (**Verified**, on every pull request). A Raspberry Pi 4 on 64-bit Raspberry Pi OS runs the server as a user service, from a checkout and from a release archive, installed, updated, rolled back and removed (**Verified**: [Raspberry Pi](#raspberry-pi)). |
| Linux without a systemd user manager: most containers, WSL without systemd | The command only (`--no-service`); you start the server yourself with `j3-bots serve`. Whether bots run that way has not been checked: the engine starts each harness with `systemd-run --user --scope`. On WSL, `doctor` gives the steps that turn systemd on. |
| macOS | Not supported for the server. The service is a systemd unit, and the engine starts each harness in a systemd scope. |
| Windows 10 and 11 on x64 | Supported only as the desktop app's local server: the app starts the server as its own child, in a private home in the app's data, and stops it when it quits. There is no `j3-bots` command, service or installer on Windows, so this guide does not apply there. CI runs the server's and the engine adapter's tests on Windows Server 2025, except those of the command line, the service, the installer and the admin socket, then a smoke of the built server as the desktop app runs it, the real engine included, and starts the server runtime each Windows package carries (**Verified**, on every pull request). Each bot's harness runs as the user's own process, not in a systemd scope ([Engine: isolation](../architecture/engine.md#isolation)). |

Clients run anywhere: the web client in a browser, and the desktop app on Linux, macOS and Windows ([Releasing](releasing.md)), each connected to your server over the network. On Linux x64 and Windows x64 the desktop app can also be the server, for the bots on that computer.

## What you need

- About 3 GB of free disk. The engine is about 200 MB once downloaded; the database and the bots' files grow with use.
- About 1.5 GB of free memory while a bot works: the server takes about 120 MB and the engine about 400 MB with no turn running, and each harness adds its own while it runs, about 225 MB for Claude Code ([measured on a Raspberry Pi 4](#raspberry-pi)).
- `sh`, `tar`, `curl` or `wget`, `sha256sum` or `shasum`, and OpenSSL 3 or newer, which checks the release's signature. Debian 12, Ubuntu 22.04 and Raspberry Pi OS bookworm ship OpenSSL 3; on an older system, install it before you run the installer. A release carries its own Node: no Node, pnpm, Git or Docker is needed.
- Root access only for `loginctl enable-linger`, so the service starts at boot, and to create a dedicated user if you make one. The installer itself refuses to run as root.
- A way for bots to reach their models: an endpoint in front of your subscriptions, or a harness signed in ([Connect the providers](#connect-the-providers)).

## Choose the user it runs as

A bot in full access can do anything its user can do: read every file that user can, use their SSH keys, run `sudo` if they may. On a machine that holds keys to other machines or data you care about, run J3 Bots as a **dedicated user**: one with no SSH keys, in no group that can become root (such as `sudo` or `docker`), with its own provider sign-ins and no access to your own home ([Security](../architecture/security.md#running-on-a-machine-that-matters)). `doctor` warns when the user it runs as keeps an SSH private key in `~/.ssh` or is in such a group, and gives these steps:

```sh
sudo useradd --create-home --shell /bin/bash j3bots
sudo loginctl enable-linger j3bots
sudo -iu j3bots
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
```

`enable-linger` starts that user's systemd manager at boot, with no login. `XDG_RUNTIME_DIR` lets `systemctl --user` find that manager from a `sudo -i` shell. Do everything below as that user, including installing and signing in to the harnesses.

If you run J3 Bots as your own user instead, turn lingering on for yourself, so the service survives a logout and starts at boot. `doctor` reminds you while it is off:

```sh
sudo loginctl enable-linger "$(id -un)"
```

## Install

As the user J3 Bots runs as, never as root:

```sh
curl -fsSL https://github.com/JPSAUD501/j3-bots/releases/latest/download/install.sh | sh
```

That address answers only once a release that is not a pre-release is published. A pre-release is installed from its own tag, by name:

```sh
curl -fsSL https://github.com/JPSAUD501/j3-bots/releases/download/v0.1.0-rc.1/install.sh | sh -s -- --version 0.1.0-rc.1
```

`install.sh` refuses root, a system other than x64 or arm64 Linux, a machine without OpenSSL 3, and, unless given `--no-service`, a user with no systemd user manager. Then it:

1. finds the latest release, or the one `--version` names (a pre-release or a nightly, which it never picks by itself);
2. downloads the release's `SHA256SUMS` and its signature, `SHA256SUMS.sig`, and checks the signature with the J3 Bots release key it carries; then downloads the archive for this machine and checks it against its digest in `SHA256SUMS`. It installs nothing when either check fails, and says which ([Releasing: what verifies a release](releasing.md#what-verifies-a-release));
3. unpacks it into `~/.local/share/j3-bots/versions/<version>/`, outside the data directory;
4. writes the `j3-bots` command, `~/.local/bin/j3-bots`, which runs that version, and records where it is in `~/.local/share/j3-bots/launcher`;
5. runs `j3-bots doctor` ([What doctor says](#what-doctor-says)), then `j3-bots service install` ([The service](#the-service)), unless `--no-service`;
6. says what is next: connect the providers, then pair.

Most systems put `~/.local/bin` on `PATH` at the next login. Until then, run the command as `~/.local/bin/j3-bots`; `install.sh` says so when it is not on `PATH`.

`J3_INSTALL_DIR` and `J3_BIN_DIR` move the first two folders, and `J3_HOME` the data directory (default `~/.j3-bots`). The install folder, its `versions/` and the folder of the command must be yours and written by no other account: what is in them runs as you, so `install.sh` refuses any other, and says which and why. A folder your own group may write, as `umask 002` makes them, is accepted; one another group may write is not. Every folder the way to them passes through, from `/` down, must be yours or root's and written by no other account, unless it is sticky, as `/tmp` is: an account that could write to one could move your folder away and put its own, or a link, in its place. A link on the way is checked where it is, and the way goes on from where it leads. `j3-bots update` checks the same before it changes anything. It writes its own folders with no write access for group or others, whatever your `umask`.

Run it again with the same version to restore the command, its record and the service. It uses the release already in `versions/<version>/` as it is, so a damaged release there is fixed by `j3-bots uninstall`, then the command again. It never removes a folder it did not make: a `versions/<version>/` that is not a release, with no `release.json`, is refused and kept. It refuses to install another version over an installed one: `j3-bots update` changes version ([Update and roll back](operating.md#update-and-roll-back)).

With `--no-service`, nothing runs yet: start the server in a terminal with `j3-bots serve`, or install the service later with `j3-bots service install`.

## What doctor says

`install.sh` runs `j3-bots doctor` once, before it installs the service; run it again whenever something looks wrong. It changes nothing, and is safe while the service runs. Its one request to another machine is the engine download check below. Right after `install.sh`, with the service running and no provider connected yet, it says:

```text
✓ Node            Node 26.13.1.
✓ This user       j3bots keeps no SSH private key directly in ~/.ssh and is in no group that can become root.
✓ Configuration   /home/j3bots/.j3-bots/config.json is valid.
✓ Data directory  /home/j3bots/.j3-bots, open to this user only.
✓ Disk space      101.8 GB free where /home/j3bots/.j3-bots is.
✓ Snapshot        None yet: `j3-bots update` copies the databases before it changes release.
✓ Server          J3 Bots 0.0.0 is running at http://0.0.0.0:3737.
✓ Ports           The running server listens on http://0.0.0.0:3737, the bot tools on 3739, and the engine answers on 3738.
✓ Engine          T3 Code 0.1.11 is running.
✗ Claude Code     Claude Code has no way to reach its models yet: no provider connection is stored, and it is not signed in inside its J3 Bots home.
                  Fix: Either connect an endpoint that serves its models, such as a proxy in front of your subscriptions, with `j3-bots provider connect`, which restarts the engine; or sign Claude Code in with its own account with `j3-bots provider login claude-code`.
✗ Codex           Codex has no way to reach its models yet: no provider connection is stored, and it is not signed in inside its J3 Bots home.
                  Fix: Either connect an endpoint […]; or sign Codex in with its own account with `j3-bots provider login codex --device-auth`, which shows a code to enter in a browser on any device.
✓ Web client      The running server serves it.
! Pairing         No device is paired yet.
                  Fix: Run `j3-bots pair`, then open J3 Bots on the new device and enter the code.
✓ User manager    This user's systemd manager answers.
✓ Service         Installed, enabled and running.
✓ Start at boot   Lingering is on: the service runs without a login session.
✓ Memory limit    The service's memory limit applies.
✓ Command         j3-bots runs J3 Bots 0.0.0, as the service does.

2 problems to fix, 1 warning.
```

The two problems go once you [connect the providers](#connect-the-providers), and the warning once you [pair a device](#pair-a-device).

Each line is ✓ (fine), `!` (a warning: the server runs, but something is missing or not ready yet), ✗ (a problem to fix) or `-` (not checked). A warning or a problem carries its fix when `doctor` knows one. Fix every ✗. `doctor` exits with status 1 when it reports any problem.

| Check | What it looks at |
| --- | --- |
| Node | The Node running it has the major version J3 Bots is built on. A release runs its own. |
| This user | A warning when the user it runs as keeps an SSH private key directly in `~/.ssh`, or is in a group that can become root (`sudo`, `wheel`, `admin`, `docker`, `lxd` or `incus`, as `/etc/group` names them), with the steps to a [dedicated user](#choose-the-user-it-runs-as). It does not look for keys elsewhere, nor follow links in `~/.ssh` ([Security](../architecture/security.md#running-on-a-machine-that-matters)). |
| Configuration | `config.json` and, while the service is not installed, the `J3_*` variables decode and pass the checks the server makes at start: a public address without TLS, two settings on one port, a TLS certificate and key that do not load as a pair, a web client folder that overlaps the data directory, a data directory inside a Git checkout. With the service installed, every check describes the service: its data directory, its `config.json` and its `PATH`. |
| Shell settings | With the service installed, a warning for each `J3_*` variable in your shell, which the service does not get, and a problem for one whose value the server would refuse. |
| Data directory | It is a folder this user owns and can write to, and no group or other user can open it. Otherwise the server does not start, and `doctor` gives the fix when it has one, such as the `chmod` or `chown` command. |
| Disk space | Free space where the data directory is: less than 1 GB is a problem, less than 3 GB a warning. |
| Snapshot | The snapshot `j3-bots update --rollback` would put back. A rollback that has not finished is a problem, with `j3-bots update --rollback` as its fix; until it does, Server, Service and Command wait for it ([Update and roll back](operating.md#update-and-roll-back)). |
| Server | Whether a server answers on the admin socket, its version and the address it listens on. Something that is not a socket where the admin socket goes is a problem, with the `mv` command that clears it. |
| Ports | With the server running, the ports it listens on, and a problem if the engine's port was taken. With no server running, that the server's port, the bot tool port and the engine's port are free. |
| Engine | That the pinned engine has a release for this machine, whether it is installed yet, and, with the server running, the state the server reports for it. While it is not installed and no server answers, whether its download on GitHub answers, with one `HEAD` request: a problem when it does not, since the server downloads it on its first start. That request does not go through `HTTPS_PROXY`, and neither does the server's download. |
| Browser | On Linux, what the engine's browser needs from the system: a sandbox AppArmor allows, the libraries it loads (once the engine has downloaded it) and fonts. Something missing is a warning, since only a bot you give the browser uses it, with the commands that fix it: `sudo` with the system's own `tee`, `apparmor_parser` and `apt-get` or `dnf`, which run nothing as root that the service's account can change ([The browser](operating.md#the-browser)). Not shown elsewhere. |
| Claude Code, Codex | That the harness is on the `PATH` the service runs with (your shell's while the service is not installed). When it is only on your shell's, the fix is to install the service again from that shell ([A harness the service does not find](#a-harness-the-service-does-not-find)); when it is nowhere, the fix names the page where its maker says how to install it. With the server running, what the engine reports about it once it is ready. Until then the harness cannot be checked: that is a warning, with the Engine line's fix, which is to run `doctor` again in a minute while the engine is still starting. One with no way to its models gets both ways to one: `provider connect` or `provider login`. Right after the engine starts, as after `install.sh`, `j3-bots update`, `provider connect` or a restart, it has not finished checking a harness yet, which can take up to a minute: that is a warning saying it is still checking, with running `doctor` again in half a minute as its fix. A check that has not ended within a minute and a half failed. A harness the engine cannot run is a problem that says why, with the engine's own words when it gave any, and what fixes it: one the engine did not find, although `doctor` did, needs the service started again with the `PATH` that has it; one whose check failed needs `claude --version` (or `codex --version`) run by hand to see what it says, then the service restarted; one turned off on the server needs its settings read in the log ([When the engine cannot run a harness](#when-the-engine-cannot-run-a-harness)). |
| Web client | Whether the running server serves the web client. With no server running, whether a client is where the server would serve it from. |
| Pairing | How many devices are paired. |
| User manager | That this user's systemd manager answers. With the service installed, one that does not is a problem; without it, a warning, since `j3-bots serve` starts without it. `doctor` tells a machine systemd did not start (most containers, WSL without systemd) from a shell that cannot reach the manager (one opened with `su` or `sudo -u`), and gives the fix for each. The service is then not checked. |
| Service | That the unit is installed, enabled and running, and has not failed. A unit still `activating` is a warning: it is starting or restarting, and the log says which. |
| Start at boot | That lingering is on for this user. |
| Memory limit | That the kernel lets the service's `MemoryHigh` apply. |
| Command | For an install made by `install.sh`, that the `j3-bots` command runs the release the service runs. |

## The service

`install.sh` runs `j3-bots service install`. It stops at the first step that fails, and a failure before it writes the unit leaves an installed unit as it was:

1. checks the configuration as the service will run it, and the data directory, `~/.j3-bots`, which must be open to this user only;
2. creates the data directory, readable by this user only, if it does not exist;
3. writes `~/.j3-bots/config.json` with the defaults, if there is none. An existing file is never rewritten;
4. checks that nothing but a socket is at `~/.j3-bots/admin.sock`, and that `host` is still an address of this machine;
5. stops if a server you started yourself with `j3-bots serve` is running for the data directory;
6. writes the unit `~/.config/systemd/user/j3-bots.service` whole, through a new file that replaces the old one, so an interruption never leaves half a unit;
7. enables and starts it;
8. waits up to a minute for the service's server to answer, and says whether it did and what state the engine is in.

On its first start the server downloads the engine it is pinned to into `~/.j3-bots/engine`, so the engine may still be starting when `service install` returns. Its log, the first run and Settings say how far the download has come, and `j3-bots doctor` does too. If the server does not answer, run `j3-bots doctor`, then read why in the log: `journalctl --user -u j3-bots -n 100`. What the unit does on a failure, a stop or high memory is in [Operating: the service](operating.md#the-service).

### When `lan` is refused

The default `"host": "lan"` serves every IPv4 address of the machine as long as each one is private. If the machine has a public IPv4 address, `lan` is refused, and `doctor` and `service install` say so, naming the address. Nothing is created then, so create the data directory and the configuration yourself, with `host` set to one private address of the machine, such as its home network or Tailscale address (`ip -4 addr` lists them):

```sh
mkdir -m 700 ~/.j3-bots
cat > ~/.j3-bots/config.json <<'EOF'
{
  "host": "192.168.1.40"
}
EOF
j3-bots doctor
j3-bots service install
```

Settings left out of `config.json` take their defaults ([Configuration](operating.md#configuration)). To serve the public address itself, set `host` to it and `tls` to a certificate and key ([HTTPS](exposing.md#https-with-your-own-certificate)).

## Connect the providers

Bots run on Claude Code and Codex, each with a home of its own in `~/.j3-bots/providers`, so they use none of your own setup or sign-ins. Until one of them reaches a model, the app's first run shows how to connect one, and a first bot created meanwhile says hello once a model is connected; `doctor` says what is missing too. In the desktop app running the bots on its own computer, the first run signs the harnesses in itself ([From the app](#from-the-app-on-the-same-computer)); everywhere else it shows the command below, with a button that copies it. There are two ways.

**An endpoint in front of your subscriptions.** An endpoint that speaks Anthropic's Messages API and OpenAI's Responses API, such as CLIProxyAPI, serves both harnesses. With the service running:

```sh
j3-bots provider connect --base-url http://127.0.0.1:8317
```

It asks for the endpoint's key without showing it; a script can pipe the key on standard input instead. Without `--base-url`, it asks for the base URL first. Give the base URL without `/v1`: each harness adds what it needs. It must be `https`, or `http` to this machine, since the key travels with every request. The key goes only into the engine's secret store. Run it again to change the endpoint or the key: both change together. The command restarts the engine so every bot uses the new connection at once. A restart stops the work bots have running, so when any bot has some, it asks first; `--yes` answers for you, and a script that pipes the key without `--yes` is refused and changes nothing. The providers show as ready a few seconds after the engine is back, once it has checked them; `j3-bots doctor` shows each one's state. A bot can use the models the engine lists for its provider, so the endpoint has to route those names.

**Signing each harness in with its own account.** Install the harness as this user, from its maker's page ([Claude Code](https://code.claude.com/docs/en/setup), [Codex](https://developers.openai.com/codex/cli)), then, with the service installed and started once:

```sh
j3-bots provider login claude-code
j3-bots provider login codex --device-auth
```

Each runs the harness's own sign-in in your terminal, with the harness's home in the service's data directory (`~/.j3-bots/providers/<harness>`) as its configuration folder, so the sign-in is stored there and your own `~/.claude` and `~/.codex` stay as they are. It says where before it starts. The sign-in gets the environment the engine gives harnesses, plus your terminal, language and browser variables, so your shell's other settings for the harness, such as `ANTHROPIC_*`, `OPENAI_*` or its own configuration folder, do not apply. It finds the harness where the engine does, on the `PATH` the service runs with, and it refuses:

- when the data directory does not exist yet: start the service once first;
- when the harness is not on the service's `PATH`, with the fix `doctor` gives ([below](#a-harness-the-service-does-not-find));
- when the provider home, the `providers` folder above it or Claude Code's `.credentials.json` is a symbolic link, which could make the sign-in act on what it points to;
- `--device-auth` for Claude Code, which has no such option.

`--device-auth` makes Codex show a page and a code to enter in a browser on any device. Without it, Codex opens a browser on this machine and waits for it to come back, which a browser on your laptop cannot do over SSH. Codex revokes the sign-in it finds in its home before it starts a new one, so `provider login codex` runs it in a new, empty folder inside the home, private to you, and moves the `auth.json` it writes into the home only once the sign-in succeeded: a failed or cancelled sign-in leaves the one there as it was, and the folder is removed however the sign-in ends.

The engine notices a new sign-in when it checks its providers again. `j3-bots doctor` shows what it reports; `systemctl --user restart j3-bots` makes it check now, and stops the work bots have running.

While a provider connection is stored, J3 Bots sets the harnesses up to use it, so a sign-in is not expected to be used then, and `provider login` says so. No command removes a stored connection yet. Each sign-in has been started on a test machine, where Claude Code printed its sign-in page and Codex 0.171.0 a page and a code, and stopped there; none has been completed with a real account ([open question 2](../open-questions.md#2-does-a-subscription-sign-in-work-inside-a-j3-owned-provider-home)).

### From the app, on the same computer

When the desktop app runs the bots on its own computer, its first run, and Settings → Providers, show a button for each harness the server finds there: **Sign in with Claude** and **Sign in with ChatGPT (Codex)**. The server runs that harness's own sign-in for J3 Bots' home for it, as `provider login` does, and the app opens the sign-in page in your browser; once you finish there, the harness is signed in and the engine checks it again at once. Bots use your own plan, so their usage counts toward your limits. While a sign-in waits, the app can open its page again or cancel it, and it gives up after 10 minutes. Settings → Providers also says where the server finds each harness, or that it does not, and looks again whenever the engine's account of a harness changes. On Windows the server looks in the folders on the `PATH` it started with and in those your user's and the machine's `PATH` settings name now, so a harness installed after the app started is found.

**Advanced: use an endpoint** opens a form for an endpoint's base URL and key, which does what `provider connect` does, restart included: when bots have work running, it says so and restarts only once you confirm.

In the app on another computer, in a browser or on a phone, the first run shows the command instead, since the sign-in page has to open on the computer the server runs on.

### When J3 Bots can't use your sign-in

J3 Bots signs each harness in anew, in its own home. It never reads, copies or signs out your own sign-in, it reuses nothing of your own setup, and no harness the engine runs uses your own `~/.claude` or `~/.codex` ([Engine: isolation](../architecture/engine.md#isolation)). A sign-in from the app or `provider login` cannot help:

- **When the harness is not installed, or the server does not find it.** The app offers **Install**, and the server installs its own copy ([below](#when-the-engine-cannot-run-a-harness)). Where it cannot, the app lists where to install each one; once you have, **Look again** asks the server to look again in the folders on its `PATH`, so a harness installed into one of them is found with no restart. One installed in a folder the server's `PATH` does not have needs the server started again with it; for the service, the fix is [below](#a-harness-the-service-does-not-find).
- **When the browser is not on the computer the server runs on.** The page returns to the harness through a server it listens on at `localhost`, which only a browser on that computer reaches. On a machine you reach over SSH, use `j3-bots provider login codex --device-auth`, which shows a code to enter on any device, or an endpoint; Claude Code has no such option.
- **When the harness can only sign in from a terminal.** One that gives the app no page within 30 seconds, or ends saying it needs a terminal, is reported as such, and the app offers an endpoint instead. `provider login`, in a terminal on that computer, still works.
- **For an account with only an API key.** A sign-in needs an account the harness's maker signs in; use an endpoint that takes the key.
- **When Codex keeps its sign-in in the system's keyring.** Set so, it writes no `auth.json`, which is where J3 Bots finds a Codex sign-in, so the sign-in reports that nothing was left to use. Use an endpoint, or keep Codex's default.
- **When the computer is managed.** A policy installed for T3 Code on this computer (`/etc/t3code/policy.json` on Linux) applies to the engine too and can refuse what J3 Bots asks of it, and one installed for Claude Code or Codex themselves applies to J3 Bots' harnesses as it does to yours.
- **While a provider connection is stored.** The endpoint still serves the models, and the app says so after a sign-in. No command removes a stored connection yet.

### When the engine cannot run a harness

Settings → Providers, the first run's last step and `doctor` say why the engine cannot run Claude Code or Codex, and the app shows the engine's own words under it when it gave any:

- **Not installed on this computer** (or **on the server**, from another device): the engine did not find the harness on the `PATH` it runs with. Press **Install**: the server downloads the harness from its maker, checks it against the maker's checksum, and runs the provider on that copy, which it keeps in its data directory and updates by itself ([Operating: J3 Bots' own harnesses](operating.md#j3-bots-own-harnesses)). It shows how far the download has come, and **Cancel** stops it; one that did not finish says why, with **Try again**. Where the server cannot install it (a system J3 Bots installs no build for, such as 32-bit ARM or Intel macOS, or a server older than 0.8.0), install it yourself as the user the server runs as, from its maker's page, which the app links to, then press **Look again**. The app's server, and the service, already have the folders the harnesses' own installers and npm use on that `PATH`, so a harness installed there is found with no restart. One installed elsewhere needs the server started again with a `PATH` that has it ([above](#a-harness-the-service-does-not-find)); in the desktop app, quit it and open it again. On Windows, both the engine and the app's sign-in buttons also look in the folders your user's and the machine's `PATH` settings name, which an installer changes, so a harness whose installer added its folder there is found without that. A harness the engine finds and cannot start, as a Codex executable it is not allowed to run, also reads as not installed, as the engine reports it; the engine's words under it say which. The engine cannot install a harness itself at the version J3 Bots pins ([decision 0044](../decisions/0044-j3-bots-installs-and-updates-the-harnesses.md)).
- **Found, but it failed to start**: the engine found the harness, but checking it failed, or took longer than the engine allows (20 seconds for its version, as on a slow first start). **Try again** asks the engine to check it again. When it keeps failing, run the harness's `--version` yourself as that user to see what it says, and read the server's log: J3 Bots writes the engine's words there, as a warning that starts "The engine cannot run a provider". In the app's own server that log is `<userData>/server/server.log` ([Operating: the server the desktop app runs](operating.md#the-server-the-desktop-app-runs)); for the service, `journalctl --user -u j3-bots`.
- **Turned off on the server**: the engine's settings turned the provider off, which happens when it could not safely set the provider up. No client turns it back on; the log names the file it could not use.

On the first run, **Create** waits while no provider can run a bot, the engine's first start included, since the server would refuse it, and says so; it can be pressed again as soon as one can.

### A harness the service does not find

The service runs with the `PATH` of the shell that ran `service install`, and the engine looks for `claude` and `codex` there. After you install a harness in a folder that was not on it, `doctor` warns that it is not on the service's `PATH` and gives the fix with your data directory:

```sh
J3_HOME=/home/j3bots/.j3-bots j3-bots service install
```

Run it from a shell whose `PATH` has the harness, so the service gets that `PATH`. `J3_HOME` keeps the service on its data directory: a bare `service install` from a shell with another `J3_HOME`, or none, would point the service at that shell's.

Whatever reaches the models, a bot runs commands as this user, so it can read the provider key or the sign-in from its shell (**Verified** for the key in a Codex command's environment; [Security: secrets](../architecture/security.md#secrets)). Treat everything a bot can reach as yours to lose.

## Pair a device

```sh
j3-bots pair
```

```text
Pairing code: 7Q2MV-K9XDA

It works once, for the next 5 minutes.
The server is reached at:
  http://192.168.1.40:3737
  http://100.101.102.103:3737
On the new device, open J3 Bots at one of these addresses and enter the code.

Scan this with a phone's camera to open J3 Bots at http://192.168.1.40:3737 with the code filled in.
For another address, run `j3-bots pair --address <address>`.
(a QR code, drawn in the terminal)
```

`pair` asks the running server for the code over its admin socket, `~/.j3-bots/admin.sock`, which only this user can open: it works only on this machine, as the user that runs the service. The addresses come from the server: its port and scheme and, with `lan`, the machine's private addresses, leaving out container and virtual-network interfaces such as `docker0`.

On the new device, open one of those addresses in a browser: the server serves the web client there, and it asks for the code. On a phone, scan the QR code instead: it opens the address it carries, at `/pair`, with the code filled in; check the server it names and press Pair. The QR code carries the first address listed that is not a loopback address: `publicOrigin` when it is set ([Exposing](exposing.md#publicorigin)), then the machine's addresses in the order the machine lists its interfaces. For a phone that reaches the machine on another one, such as over Tailscale, name it: `j3-bots pair --address http://100.101.102.103:3737`. `--address` takes a bare address (scheme, host and port, no path) that is one of the listed addresses, or an `https` address the machine is reached at, such as a domain a proxy serves. When the terminal is too small for the QR code, or the output goes to a file or a pipe, `pair` prints the link as text instead. A code typed in lower case, or with spaces or dashes, works too. A paired device shows the same in Settings → Devices.

A plain-HTTP address other than `localhost` is not secure to a browser, which then does not install J3 Bots as an app (a PWA). For that, serve HTTPS ([Exposing](exposing.md)).

After five wrong codes within fifteen minutes, from anywhere, the server locks pairing for fifteen minutes, and even the right code is refused until then. `j3-bots pair` then makes no code and says until when. To pair now, run `j3-bots pair --unlock`: it lifts the lock and prints a code. Wrong codes you did not type mean someone else reaches the server ([Exposing: who can reach it](exposing.md#who-can-reach-it)).

## Meet your first bot

The app's first run asks for your first bot's name and look, each with a default, and creates it. The bot then speaks first, once a provider is ready, and asks what you want it for, one question at a time. From there, the roster's "New bot or room" adds more.

## Raspberry Pi

J3 Bots runs on a Raspberry Pi 4 with 4 GB of memory or more, on 64-bit Raspberry Pi OS (`uname -m` prints `aarch64`). Raspberry Pi OS has everything `install.sh` needs.

**Verified** on a Pi 4 with 4 GB, as a dedicated user with lingering on: `install.sh --version 0.1.0-rc.1` installed the release, and `doctor` reported no problem once a provider's endpoint was connected. A device paired over the LAN through `/api/pair`. `j3-bots update` to 0.1.0, `j3-bots update --rollback` and `j3-bots update` again each worked, and the device stayed paired: its token still got a socket ticket. `j3-bots uninstall --delete-data` left no unit, process, command, release or data behind. 0.1.0 then installed from `releases/latest/download/install.sh`, and `doctor` warned only that no device was paired yet.

- **Memory.** Measured on a Pi 4 with 4 GB (release 0.0.0 from a checkout, engine 0.1.11-nightly.20261120.4969): the server about 120 MB and the engine about 400 MB with no turn running, and Claude Code about 225 MB while it runs. The service peaked at about 1.3 GB over its first start and one turn. The service's `MemoryHigh` is 60% of the machine's memory, about 2.4 GB on a 4 GB Pi.
- **Memory controller.** Raspberry Pi OS kernels may disable the kernel's memory controller, which `MemoryHigh` needs. `doctor` reports that case; the fix is `cgroup_enable=memory` at the end of the single line in `/boot/firmware/cmdline.txt`, then a reboot.
- **Addresses.** Behind a carrier's modem, an address in 100.64.0.0/10 may be the carrier's NAT rather than Tailscale; it counts as private, so `lan` serves it. Check `ip addr` before you rely on it.
- **Backups.** An update keeps its snapshots in `~/.j3-bots/backups/`, which must stay on the same filesystem as the data directory: do not make it a link to a USB drive ([Update and roll back](operating.md#update-and-roll-back)).
- **Logs.** If `journalctl --user` shows nothing, the journal is not stored on disk: run `sudo mkdir -p /var/log/journal` and `sudo systemctl restart systemd-journald`.
- **A Pi 5** uses 16 KiB memory pages, and neither J3 Bots' archive nor the engine has been run on one (**Assumed** to work).

## From a checkout

For development, or to run a commit no release has. Needs Node 26 (J3 Bots is built and tested on 26.13.1), pnpm 12 and Git:

```sh
git clone https://github.com/JPSAUD501/j3-bots.git ~/j3-bots
cd ~/j3-bots
pnpm install --frozen-lockfile
pnpm build
mkdir -p ~/.local/bin
ln -sf ~/j3-bots/apps/server/dist/bin.mjs ~/.local/bin/j3-bots
j3-bots doctor
j3-bots service install
```

`pnpm build` builds the server into `apps/server/dist/` and the web client into `apps/web/dist/`, which the server serves. The server bundle carries every dependency it needs. The unit records the real path of the Node that ran `service install`, so run `service install` again after you install Node somewhere else. `install.sh` refuses to write its command over this link, and `j3-bots uninstall` refuses a checkout: remove its service with `j3-bots service uninstall`.
