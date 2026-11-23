# 0019: Codex runs with a home folder of its own; the commands it runs keep the user's

**Status:** Accepted

## Context

Each harness the engine runs has a configuration folder J3 Bots owns, `<J3_HOME>/providers/<harness>`, given to it as `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, so that bots do not inherit the coding instructions, hooks, skills, MCP servers or sign-in of the person whose machine they run on ([Engine: isolation](../architecture/engine.md#isolation)). The engine passes `HOME` on to every harness, since a bot works in the person's environment: its shell, `git` and `gh` read their configuration from there.

Codex reads more than its configuration folder. Beside `$CODEX_HOME/skills` it lists the skills in `$HOME/.agents/skills` as user skills, and it reads plugin marketplaces and other capability locations from `$HOME` (**Read** in Codex 0.171.0: `ext/skills/src/host_roots.rs` adds `<home>/.agents/skills` for the user layer, with `home` from `dirs::home_dir()`; `core-plugins/src/marketplace.rs` and `exec-server/src/discoverV2/capability_manager.rs` read the home too). So a Codex bot was offered every skill the person keeps in `~/.agents/skills` ([#48](https://github.com/JPSAUD501/j3-bots/issues/48)). **Verified** with Codex 0.171.0 through its app server's `skills/list`, with a fresh `CODEX_HOME`: given the person's `HOME`, it listed their `~/.agents/skills/<name>` with scope `user`; given an empty folder as `HOME`, it did not. On a personal computer, where the desktop runs the server as the person ("Usar neste computador"), every Codex bot would see them.

Codex has no setting that turns that location off. Its `[skills]` configuration enables or disables single skills, by name or by the path of their `SKILL.md` (**Read**, `config/src/skills_config.rs`), so turning off the person's skills would mean listing them at each start and missing any added while the engine runs.

Claude Code is not affected. With `CLAUDE_CONFIG_DIR` set, it lists neither `~/.claude/skills` nor `~/.agents/skills`. **Verified** with Claude Code 2.1.330: a session started with the person's `HOME`, holding a skill in each, and a fresh `CLAUDE_CONFIG_DIR`, listed neither in the `skills` of its `init` message; without `CLAUDE_CONFIG_DIR` it listed the one in `~/.claude/skills`. It never listed the one in `~/.agents/skills`.

## Decision

**The Codex process runs with a home folder of its own,** `<J3_HOME>/engine/j3/codex-homes/<instance>`, which the adapter creates and leaves empty. The engine's settings give that instance `HOME` as a variable of its own, which the engine sets for the Codex processes it starts, its probes included (**Read** at `59651c1`, `mergeProviderInstanceEnvironment`, used by `CodexDriver.ts`). What Codex looks for there, user skills and plugin marketplaces, is not there.

**The commands a Codex bot runs get the person's `HOME` back.** The adapter writes `[shell_environment_policy.set]` with `HOME = "<the server user's HOME>"` into the instance's `config.toml`, and Codex sets it in the environment of every command it runs: its shell tool, `exec_command` and hooks (**Read** in Codex 0.171.0, `protocol/src/shell_environment.rs` `populate_env`). So a Codex bot's shell, `git` and `gh` read the same configuration as a Claude Code bot's. **Verified** with Codex 0.171.0's own `codex sandbox`, which builds a command's environment the same way: run with the folder of its own as `HOME`, a command saw the person's.

The adapter owns that table and writes it at every start, from the server's environment, so the path follows the home the server runs with and is not data to carry when a home moves.

## Consequences

- A Codex bot lists only J3 Bots' shared skills, the skills of its project folder and Codex's own system skills, as a Claude Code bot does.
- Codex's own work that reads the home folder does so in the empty one: a plugin marketplace the person set up is not offered, and the workspace section Codex builds for its realtime mode does not name the person's home (**Read**, `core/src/realtime_context.rs`).
- The MCP servers Codex starts, J3 Bots' `j3` bridge among them, inherit Codex's own `HOME`. The bridge reads nothing from it.
- A person who sets `shell_environment_policy.set` in the instance's `config.toml` by hand loses it at the next start: J3 Bots owns that table.
- On Windows, `dirs::home_dir()` asks the system for the profile folder rather than reading a variable (**Assumed**, from the `dirs` crate's documentation), so `HOME` would not move what Codex reads there. Local mode on Windows needs its own answer before Codex bots run there.

## Rejected

**A home of J3 Bots' own for the whole engine, or for Codex and its commands.** It closes the same gap, and costs a bot the person's environment: `gh` would be signed out, `git` would have no name to commit with, and the shell would read none of the person's profile. Claude Code bots keep that environment, so Codex bots would work differently from them for no gain in isolation: a bot's commands run as the person and can read their files whatever `HOME` says ([Security: secrets](../architecture/security.md#secrets)).

**Turning the person's skills off one by one** in the instance's `[skills]` configuration. It would list the person's skills at each start, write their paths into J3 Bots' configuration, and miss a skill added while the engine runs.

**Leaving it as a known gap.** On a personal computer, the person's skills are written for their own coding, and a bot offered them would act on instructions it was never meant to have.
