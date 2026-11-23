# 0019: Codex runs with a home folder of its own; the commands it runs keep the user's

**Status:** Accepted

## Context

Each harness the engine runs has a configuration folder J3 Bots owns, `<J3_HOME>/providers/<harness>`, given to it as `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, so that bots do not inherit the coding instructions, hooks, skills, MCP servers or sign-in of the person whose machine they run on ([Engine: isolation](../architecture/engine.md#isolation)). The engine passes `HOME` on to every harness, since a bot works in the person's environment: its shell reads their profile, and `git` and `gh` read their configuration from there.

Codex reads more than its configuration folder. Beside `$CODEX_HOME/skills` it lists the skills in `$HOME/.agents/skills` as user skills, and it reads plugin marketplaces and other capability locations from `$HOME` (**Read** in Codex 0.171.0: `ext/skills/src/host_roots.rs` adds `<home>/.agents/skills` for the user layer, with `home` from `dirs::home_dir()`; `core-plugins/src/marketplace.rs` and `exec-server/src/discoverV2/capability_manager.rs` read the home too). So a Codex bot was offered every skill the person keeps in `~/.agents/skills` ([#48](https://github.com/JPSAUD501/j3-bots/issues/48)). **Verified** with Codex 0.171.0 through its app server's `skills/list`, with a fresh `CODEX_HOME`: given the person's `HOME`, it listed their `~/.agents/skills/<name>` with scope `user`; given an empty folder as `HOME`, it did not. On a personal computer, where the desktop runs the server as the person ("Usar neste computador"), every Codex bot would see them.

Codex has no setting that turns that location off. Its `[skills]` configuration enables or disables single skills, by name or by the path of their `SKILL.md` (**Read**, `config/src/skills_config.rs`), so turning off the person's skills would mean listing them at each start and missing any added while the engine runs. Its `skip_host_skill_discovery` feature turns off every skill on the host, J3 Bots' shared skills and the project's included, and is marked under development (**Read**, `features/src/lib.rs`, `core/src/session/turn_context.rs`).

Claude Code is not affected. With `CLAUDE_CONFIG_DIR` set, it lists neither `~/.claude/skills` nor `~/.agents/skills`. **Verified** with Claude Code 2.1.330: a session started with the person's `HOME`, holding a skill in each, and a fresh `CLAUDE_CONFIG_DIR`, listed neither in the `skills` of its `init` message; without `CLAUDE_CONFIG_DIR` it listed the one in `~/.claude/skills`. It never listed the one in `~/.agents/skills`.

## Decision

**The Codex process runs with a home folder of its own,** `<J3_HOME>/engine/j3/codex-homes/<instance>`, which the adapter creates and leaves empty. The engine's settings give that instance `HOME` as a variable of its own, which the engine sets for the Codex processes it starts, its probes included (**Read** at `59651c1`, `mergeProviderInstanceEnvironment`, used by `CodexDriver.ts`). What Codex looks for there, user skills and plugin marketplaces, is not there.

**The commands a Codex bot runs get the person's `HOME` back, in a login shell.** The adapter writes two things into the instance's `config.toml`:

- `[shell_environment_policy.set]` with `HOME = "<the server user's HOME>"`. Codex sets it in the environment of every command it runs: its shell tool, `exec_command` and hooks (**Read** in Codex 0.171.0, `protocol/src/shell_environment.rs` `populate_env`).
- `[features]` with `shell_snapshot = false`. Codex's shell snapshot, on by default, runs the login shell once at a session's start with Codex's own environment, whose `HOME` is the empty folder, and then runs each command in a plain shell that reads what that run captured (**Read**, `core/src/shell_snapshot.rs`, `core/src/tools/runtimes/mod.rs` `maybe_wrap_shell_lc_with_snapshot`). A bot's commands would never read the person's profile, so `PATH` entries and variables set there would be missing. Without the snapshot, each command runs as a login shell (`bash -lc`) with the `HOME` above (**Read**, `core/src/shell.rs` `derive_exec_args`), and reads the person's profile as a Claude Code bot's commands do.

**Verified** with Codex 0.171.0 through a real `exec_command`, with the `config.toml` and the environment the adapter provisions, and a stand-in model that asked for one command: the command saw the person's `HOME`, a variable their `~/.profile` exports, and a program their `~/.profile` puts on `PATH`. With the snapshot turned back on, the same command saw the person's `HOME` but neither the variable nor the program.

The adapter owns both tables and writes them at every start, from the server's environment, so the path follows the home the server runs with and is not data to carry when a home moves.

**Only when the server has a `HOME`.** The folder of its own is set only together with the `HOME` the commands get back. A server with no `HOME`, as is usual on Windows, gives Codex its own environment unchanged. With the folder of its own as `HOME` there, Git for Windows would read the empty folder before `USERPROFILE` (**Assumed**, from Git for Windows' documentation), and a Codex bot would lose the person's `git` identity.

## Consequences

- On Linux and macOS, a Codex bot lists only J3 Bots' shared skills, the skills of its project folder and Codex's own system skills, as a Claude Code bot does.
- A Codex bot's commands run in a login shell with the person's `HOME`, so they read the person's profile, `git` configuration and `gh` sign-in. Each command starts its own login shell, as without J3 Bots when the snapshot is off; a profile that is slow to load slows every command.
- With the snapshot off, no file holds a capture of the shell's environment. The connection's key, which a capture held, still reaches a command through its live environment (**Verified** with Codex 0.171.0, through `exec_command`; [Security: secrets](../architecture/security.md#secrets)).
- Codex's own work that reads the home folder does so in the empty one: a plugin marketplace the person set up is not offered, and the workspace section Codex builds for its realtime mode does not name the person's home (**Read**, `core/src/realtime_context.rs`).
- The MCP servers Codex starts, J3 Bots' `j3` bridge among them, inherit Codex's own `HOME`. The bridge reads nothing from it.
- A person who sets `shell_environment_policy.set` or `[features]` in the instance's `config.toml` by hand loses it at the next start: J3 Bots owns those tables. Codex itself writes `[features]` only from its terminal client and its `codex features` command (**Read**, `core/src/config/edit.rs` `set_feature_enabled`), and a bot runs with neither.
- **On Windows, a Codex bot is still offered the person's `~/.agents/skills`.** There `dirs::home_dir()` asks the system for the profile folder (`SHGetKnownFolderPath(FOLDERID_Profile)`) and reads no variable (**Read**, `dirs-sys` 0.5.0, `lib.rs`). **Verified** on Windows 11 with Codex 0.171.0, through its app server's `skills/list` with a fresh `CODEX_HOME` and a skill in the person's `%USERPROFILE%\.agents\skills`: the skill was listed as `user` and enabled with the person's environment, with `HOME` set to an empty folder, and with `HOME`, `USERPROFILE`, `HOMEDRIVE` and `HOMEPATH` all set to it; the system call itself answered the person's profile under the same variables. So no environment J3 Bots can give Codex hides that folder, and Codex 0.171.0 has no setting that turns only that location off: neither has 0.173.0-alpha.4 nor Codex's `main` on 2026-11-24 (**Read**). Turning every host skill off (`features.skip_host_skill_discovery`) would drop J3 Bots' shared skills too, and the catalogs Codex takes in their place come from the client that starts the thread, which is the engine (decision [0001](0001-t3-code-as-unmodified-engine.md)). A per-skill rule, rejected below, did turn the skill off in the same run, while `skills/list` still listed it, disabled. This is a known limit until Codex finds the home through `HOME` or offers a setting for that location ([#168](https://github.com/JPSAUD501/j3-bots/issues/168)). Where the server has no `HOME`, as is usual there, Codex also reads plugin marketplaces from the person's profile: its marketplace lookup takes `HOME`, then `USERPROFILE` (**Read**, `core-plugins/src/marketplace.rs`).

## Rejected

**A home of J3 Bots' own for the whole engine, or for Codex and its commands.** It closes the same gap and costs a bot the person's environment: `gh` would be signed out, `git` would have no name to commit with, and the shell would read none of the person's profile. Claude Code bots keep that environment, so Codex bots would work differently from them for no gain in isolation: a bot's commands run as the person and can read their files whatever `HOME` says ([Security: secrets](../architecture/security.md#secrets)).

**Giving the commands their `HOME` back and keeping the shell snapshot.** The `HOME` a command gets is right, but the profile was read once, with the empty folder, so what it sets is missing.

**Turning the person's skills off one by one** in the instance's `[skills]` configuration. It would list the person's skills at each start, write their paths into J3 Bots' configuration, and miss a skill added while the engine runs.

**Leaving it as a known gap.** On a personal computer, the person's skills are written for their own coding, and a bot offered them would act on instructions it was never meant to have.
