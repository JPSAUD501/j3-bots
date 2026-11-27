# Security policy

The latest release is the supported one: a fix ships in a new release, not as a patch to an older one. Reports about the code on `main` are welcome too.

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue, pull request or discussion for it.

Say what is affected, how to reproduce it, and what an attacker gains. Use fictitious hosts, addresses and data in what you send.

This is a project maintained in spare time. Reports are answered on a best-effort basis, there is no bug bounty, and a fix ships when it is ready; you will hear whether the report is accepted, and you are credited in the fix unless you ask not to be.

## In scope

The code in this repository:

- the J3 Bots server and its `j3-bots` command (`apps/server`);
- the web, desktop and Android clients (`apps/web`, `apps/desktop`, `apps/mobile`);
- the packages under `packages/`, including the engine adapter and the client contract.

Examples of what matters most: a way to pair a device or use a device token without the operator, to reach the server's private state from the network, to make a bot act on text it read as if the operator had written it, or to read a credential or a pairing code that should not be readable.

What the design accepts on purpose is described in [docs/architecture/security.md](docs/architecture/security.md), with its known gaps. A report that one of those holds less than the document says is in scope.

## Out of scope

- T3 Code, the agent harnesses it runs (such as Claude Code and Codex) and the model providers: report those to their own maintainers. How J3 Bots uses them is in scope.
- Anything that needs the operator's own user on the host, which the design trusts fully: that user can already read the database and every bot's files.
- Denial of service by someone who can already reach the server, beyond what the documentation promises. Locking pairing with wrong codes is expected, and the operator lifts the lock from the host.
- Findings from automated scanners without a way to exploit them.
