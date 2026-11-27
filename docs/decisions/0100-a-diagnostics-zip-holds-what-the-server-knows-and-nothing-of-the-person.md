# 0100: A diagnostics zip holds what the server knows, and nothing of the person

**Status:** Accepted.

## Context

The owner asked for a way to download a zip of events and diagnostics, with no sensitive data in it. The operator could attach it to a ticket, or send it to whoever helps them, the owner included, so that person can understand a server that behaves oddly.

Until now, what someone helping needed was spread over several places:

- the server's log, in the journal on a service install and in a file of the desktop app's;
- the engine's own trace file;
- `j3-bots doctor`;
- the database.

Gathering it by hand meant a shell on the operator's machine. Gathering it also meant judging, line by line, what was safe to pass on.

What was open:

- where the operator asks for the zip;
- what goes in it;
- how it is kept free of messages, names and secrets;
- how big it may get on a small host;
- how a client knows the server can make one.

## Decision

**The server makes the zip, from what it already records. One scrubber goes over every file. A client downloads the zip from Settings → About, behind a sheet that says what it holds. `j3-bots diagnostics` writes the same file on the server's machine.**

### Where

**Settings → About and updates**, as its last row: **Download diagnostics** ("Baixar diagnóstico").

- Any paired device may download it. A paired device holds the operator's authority ([Security](../architecture/security.md#trust-model)), and the zip is server-wide.
- The row opens one small sheet. The sheet lists what is inside (the logs of the last 7 days, failures and updates, versions, settings and counts) and what never is (the operator's messages, names of bots, rooms or people, and passwords, keys or other secrets). It offers Cancel and Save. There are no per-item choices: what is safe to pass on is settled here, not by the operator.
- The web client and the desktop app save the file through the browser's download. The Android app hands it to the system's share sheet, for the operator to send where they choose.
- **`j3-bots diagnostics [--out <file>]`** writes the same zip on the server's machine, for when no client opens.
  - It reads the data directory and changes nothing, whether the server is running or stopped.
  - It never writes over a file that is already there.
  - A running server tells it, over the admin channel, what only the server knows: the engine's state and when it started. A stopped one leaves that out, and the command says so.

### What the zip holds

A `README.md` inside explains each file for a person or an AI:

| File | What it holds |
| --- | --- |
| `manifest.json` | J3 Bots' release, the engine it is pinned to and the protocol; the client that asked, with its version and system; the server's OS and architecture; the install kind; uptime and time zone; when the zip was made; and, per log, how many lines it holds and whether older ones were left out. |
| `server-log.jsonl` | The server's log for the last 7 days, oldest first, each line re-encoded from the server's own shape. A line that does not decode as that shape is dropped rather than trusted. An error's cause is cut at 8 KiB. |
| `engine-log.jsonl` | The engine's work that went wrong over the same days, from T3 Code's trace file. Only spans that failed, were interrupted or logged a warning or an error are kept, in J3 Bots' own shape: the span's name, how long it took, the name of its error (never the error's message), and the level and message of what it logged, each cut at 300 characters. |
| `engine.json` | The engine's state and each provider's: whether it is ready, whether it is signed in, why it cannot run, the harness's version and J3 Bots' own copy of it. |
| `failures.json` | The failures the server told the operator of in the last 7 days, newest first, at most 500. Each gives its class, its target by id, and when it happened. |
| `updates.json` | The last update of J3 Bots, and the engine release recorded. |
| `migrations.json` | The database changes applied, in order. |
| `counts.json` | How many bots, rooms, routines, connectors (catalog and custom), conversations and paired devices there are. Numbers only. |
| `settings.json` | The server's settings. Any setting that could hold a secret or a path reads `set` or `not set`. The words taught to dictation, which may be names, appear only as a count. |
| `telemetry.json` | What the server sends to J3 Bots' developers on its own. |

- **Telemetry.** Today the server sends nothing, so the file says `{ "sends": "nothing" }`. One function makes it (`telemetry()` in `apps/server/src/diagnostics/build.ts`). Once the server can send telemetry, that function says whether it is on and what it sent lately, from the same list Settings shows.
- **The client's own log.** No client keeps one today: the desktop app's file is the log of the server it runs, which the zip holds already. A client that keeps a log later adds it through the same route.
- **The server keeps its own copy of its log**, `<J3_HOME>/logs/server.log`: the same JSON lines it writes to the console. The file is moved aside at 4 MiB, and at most 5 files (20 MiB) are kept. A service install wrote its log only to the journal before, and the zip should not depend on reading it.

### One scrubber, every file

`apps/server/src/diagnostics/scrub.ts` goes over the text of every file before it enters the zip. It replaces, in this order, so a broader rule never half-replaces a value:

1. **The exact values the server holds as secrets**, read fresh for each zip, as they are and as JSON escapes them. These are:
   - the operator's and the connectors' sealed secrets;
   - the webhook secrets and tokens;
   - the push registrations' tokens;
   - the engine's credential, and each value in the engine's secret store;
   - the bridge key.

   Each becomes `[secret]`.
2. **Credentials** in a URL, and bearer and basic authorization, become `[credentials]` or `[token]`.
3. **Token-shaped strings** become `[token]`: JWTs, known prefixes (`sk-`, `ghp_`, `phc_` and others), and long runs of hex or of mixed-case base64.
4. **Email addresses** become `[email]`.
5. **The operator's home folder** becomes `~`. Their OS user name becomes `[user]`, and the machine's name `[host]`.
6. **IPv4 and IPv6 addresses** become `[ipv4]` and `[ipv6]`. Loopback and the unspecified address are kept, since they say nothing about the machine.

Bots, rooms, conversations and the rest appear only by their ids. Those ids are random, short and lowercase, so they never look like tokens, and they stay in the zip: someone helping can follow one flow from file to file.

A query for secret values that fails stops the zip. Without those values, the scrubber could miss a secret.

### Bounded, and streamed

- **The whole zip is at most 24 MiB** (`MAX_DIAGNOSTICS_SIZE`).
  - The server's log takes at most 14 MiB of text, and the engine's at most 6 MiB.
  - When a log has more, the oldest lines are left out, and the manifest says so.
  - Every other file is small by what it holds.
- The server builds the zip as the client reads it, file by file, deflated as it goes. It holds at most one log's kept lines in memory at a time, so a 4 GB host can make one beside its bots.

### The contract

- The route is plain HTTP beside the protocol: `POST /api/diagnostics/v1`.
  - It carries the device token as a bearer, and a JSON body that names the client.
  - It answers `401` without a valid token, `415` for any type but JSON (before the body is read), `400` for a body that does not decode, and `413` for one over 4 KiB.
- A server that has the route names its version in `ServerInfo.diagnostics`. A client shows the row only then, so an older server shows no row. **Protocol 11 holds**: the field is optional.

## Costs

- **The server writes its log twice** on a service install: once to the journal and once to its own file, with up to 20 MiB of disk for the file.
- **A scrubber is a pattern list, not a proof.**
  - It catches every value the server holds, and anything shaped like a token, an address or an email.
  - A secret the operator typed into a bot's conversation is not in the zip at all, since no message is.
  - A secret of a shape the scrubber does not know, somewhere the server logs it, would still pass.
- **The engine's warnings keep their message, cut at 300 characters and scrubbed.** That T3 Code's warnings carry no conversation text is **Assumed** from reading its log calls, not proved for every one.
- **The command run while the server is stopped knows less**: the zip says nothing of the engine's state or the providers'.
- **The client's own log is missing**, until a client keeps one.

## Rejected

- **Per-item checkboxes.** They would make the operator judge what is safe to share. The answer would be different for each operator, and no safer.
- **Reading the journal.** Only a service install has one, and only on a host with systemd. The desktop app and a checkout write none, and `j3-bots diagnostics` should not depend on what `journalctl` keeps.
- **The engine's trace file as it is.** Its spans carry attributes the zip cannot vouch for: no one has proved that none of them holds something the operator typed. Only what says something went wrong leaves, in J3 Bots' own shape.
- **Building the zip in memory, then sending it.** A Raspberry Pi has little memory to spare beside its bots.
- **Sending the zip anywhere from J3 Bots.** The operator chooses where it goes.
