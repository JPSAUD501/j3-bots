# 0108: The operator sets up each AI account, and picks a bot's model as in T3 Code

**Status:** Accepted. Amends [0066](0066-connecting-an-ai-is-picking-the-account-you-have.md) (Settings now lists each account the operator set up, by the harness that runs it) and [0082](0082-a-bots-effort-sits-beside-its-model-and-the-default-is-the-harnesss-own.md) (a bot's maker may choose its model and effort, at the operator's request, and fast mode sits beside effort).

## Context

The owner compared J3 Bots with T3 Code, which J3 Bots runs as its engine ([0001](0001-t3-code-as-unmodified-engine.md)), and found J3 Bots hid too much. T3 Code's Settings → Providers lists every provider instance, each with a switch, its version and status, a display name, and the harness's binary path, home and launch arguments, with a "+" to add another instance of a kind, as a second Claude account. Its model picker has a rail of instances, a searchable list with favourites, the reasoning levels of the model in a column beside it, and Standard or Fast below. J3 Bots offered two fixed accounts, Claude and ChatGPT, with nothing to set up, and a plain list of models in the bot's form.

What the engine runs, and what J3 Bots can run on it, are not the same (**Read** at `bc0f04d`):

- **The engine's harnesses.** Claude Code and Codex, each an engine driver with settings for its binary, home and launch arguments; and Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, Muse and fx, each a driver of its own, most of them agents spoken to over the Agent Client Protocol.
- **What a bot needs of a harness.** A bot speaks only through J3 Bots' `say` tool ([0004](0004-speech-is-a-tool.md)), and reaches every other J3 Bots tool the same way. J3 Bots gives Claude Code and Codex those tools by writing its tool server into the harness's own home, which it owns. The engine gives an ACP agent only the engine's own MCP server, and the other drivers take their tools from their own configuration, which J3 Bots does not write. On any of them, a bot could think and could not say a word.

## Decision

**Settings → Providers lists every account the operator set up, Claude Code's and Codex's, with T3 Code's controls; a bot's model is chosen in one picker, T3 Code's in shape, wherever a model is chosen; and the harnesses J3 Bots cannot give a bot's tools to are not offered.**

- **An account is a provider instance.** Each is one Claude Code or Codex sign-in, in a home of its own under `<J3_HOME>/providers/<id>`. The first of each harness is the one J3 Bots always had (`claude-code`, `codex`), kept so every bot and the first run go on as before. **Add** creates another of a harness, with a name the operator gives, as a second Claude plan; it is then signed in as the first is ([0085](0085-signing-in-is-one-row-and-the-browser-opens-by-itself.md)), in its own home. One the operator added can be removed, with its home; the first of a harness can only be turned off.
- **What the operator sets of each:** its name, whether it is on, and under a folded **Advanced**: the harness's executable, the launch arguments it starts with after J3 Bots' own, and the folder it keeps the account in. The folder is shown, not chosen: J3 Bots writes the bots' tools and its prompt settings into it, so pointing it at the operator's own `~/.claude` or `~/.codex` would put J3 Bots' tool server into their personal setup. A second account needs a second folder, which **Add** makes.
- **The engine is changed through its own settings.** The server keeps the accounts (migration `0071`) and writes them at every provisioning, as it always wrote its two. While the engine runs, a change goes to the engine as T3 Code's own client sends it: `server.updateSettings` with a `providerInstanceMutation`, `upsert` for a new or changed account and `remove` for one removed. A change of anything but the name rebuilds the instance, which ends what its bots run there; the form says so before Save.
- **The picker.** Where a bot's model is chosen (a new bot, its settings, a template's bot), one picker: a rail of the accounts, with the starred models first; a search over the models; each model's levels of effort beside it, Default first ([0082](0082-a-bots-effort-sits-beside-its-model-and-the-default-is-the-harnesss-own.md)); and Standard or Fast below, for a model the engine reports a fast mode for. On Android the same in a sheet. Stars are the operator's, kept on the server, so every device lists the same first.
- **Fast mode is a bot's setting, beside effort.** The engine reports it as Claude Code's `fastMode` switch and as Codex's `serviceTier` select with a `fast` choice (**Read** at `bc0f04d`, `claudeModelOptions.ts`, `codexModelOptions.ts`); the bot stores it as `fast`, and the adapter sends it only while the engine reports it for the model, as it sends effort. A change of model to one without it turns it off in the same save.
- **A bot whose account is gone or off says so.** Its conversation and its settings say the account it ran on was removed, or name it and say it is turned off, and offer the picker. It does not move to another account by itself: which plan a bot spends is the operator's choice.
- **The bots' tools.** `create_bot` and `update_bot` take an account, a model, an effort and fast mode, and `list_models` lists what the accounts offer. The tools say to keep the default unless the operator asked for another in that message. A routine runs on its bot's AI, so it has no model to choose.
- **Harnesses the engine runs and J3 Bots does not offer:** Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, Muse and fx. Each needs J3 Bots' tools written into its own configuration, and a prompt delivered its own way, before a bot on it can speak. That is work per harness, each to be **Verified** against the real harness, and is not part of this decision. Settings does not list them, since nothing there could be done with them.

The contract grows additively (`ProviderStatus.setup`, `ProviderModel.fast`, `Bot.fast`, `Settings.favoriteModels`, the requests `engine.addProvider`, `engine.setUpProvider` and `engine.removeProvider`, and a `providerId` on a sign-in), and protocol 11 is unchanged. A client offers none of it to a server that does not report `setup`.

## Costs

- **More on the screen.** Settings now shows harness names, Claude Code and Codex, where [0066](0066-connecting-an-ai-is-picking-the-account-you-have.md) kept them under Details. The first run is unchanged: it still asks for Claude or ChatGPT, and makes no second account.
- **A rebuild ends work.** Changing an account's executable, arguments or switch rebuilds its engine instance, and what ran there ends, as an update of its harness does ([0045](0045-j3-bots-keeps-its-own-copies-of-the-harnesses.md)).
- **The provider connection is shared.** An endpoint set with `j3-bots provider connect` serves every Claude Code and Codex account alike, as it served the two.
- **A chosen executable is the operator's.** J3 Bots neither installs nor updates it, and the account runs it whatever its version. Only the accounts on J3 Bots' own copy follow its updates.
- **An added account signs in from the app.** `j3-bots provider login` signs in the first account of a harness only. An added one signs in from J3 Bots on the server's own computer, as the desktop app does, so a server with no app on its computer can add accounts it cannot yet sign in.
- **Nothing of it has run against a real harness on CI.** The engine's settings mutation is **Read** at `bc0f04d`, and was already **Verified** for a change of executable ([0045](0045-j3-bots-keeps-its-own-copies-of-the-harnesses.md)); fast mode is **Read** only.

## Rejected

- **Offering every harness the engine runs.** A bot on Cursor or Antigravity today could not speak or use any of J3 Bots' tools. A choice that yields a mute bot is worse than no choice.
- **Letting the operator choose an account's home.** It would let J3 Bots' tool server and settings land in the operator's own harness setup.
- **Moving a bot whose account was removed to another by itself.** It would spend a plan the operator did not choose for it.
- **Favourites per device.** The operator picks models for the same bots from every device, and would star them again on each.
