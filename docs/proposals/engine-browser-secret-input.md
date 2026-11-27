# Proposal: a typed secret in the engine's browser

**Status:** Draft. Not sent to T3 Code, and not to be sent without the owner's decision.

J3 Bots fills a saved login into a bot's tab without the bot seeing it ([Server: filling a login](../architecture/server.md#filling-a-login)). It does this as a viewer of the engine's browser: it takes the tab, types where the page's focus is, and gives the tab back. Two things it cannot know from there leave a residual ([Security: filling a login](../architecture/security.md#filling-a-login)):

- **which element has focus.** A password field and a comment box take typing the same way;
- **which frame it is in.** The origin J3 Bots checks is the top page's, while the focus may be in an embedded frame of another origin.

The engine knows both: it runs the page. This proposal is the small, general change to T3 Code that would let J3 Bots, and any other client of T3 Code, fill a secret with a check made where the facts are. It fits [decision 0001](../decisions/0001-t3-code-as-unmodified-engine.md): J3 Bots still modifies nothing of T3 Code, and would take the change with a later pinned release once T3 Code has it.

## What T3 Code has now

All **Read** at `bc0f04d`, in the contracts J3 Bots vendors (`packages/engine-t3/vendor/t3-contracts`):

- The agent's `type` action takes `text` only, a plain string (`previewAutomation.ts`, `PreviewAutomationTypeInput`).
- `request_secret` already returns a one-use `secretRef` that the agent "passes to a tool that accepts a secretRef" and never sees the value of (`orchestratorMcp.ts`). No browser action accepts one yet.
- The viewer's `probe` answers a point with whether the element there is editable, and nothing about which element or which frame ([Engine: the bot's browser](../architecture/engine.md#the-bots-browser)).

## The change

**`type` accepts a `secretRef` in place of `text`**, and the engine checks the target before it types:

1. A client with the right scope (`preview:operate`, as a viewer already needs) asks the engine for a one-use reference to a value, with the origins the value may be typed into, and the kind of field: `username`, `current-password`, `one-time-code`. The engine keeps the value in memory until it is used or expires, as it does for `request_secret`.
2. The agent calls `type` with that `secretRef` and the locator of the field, as it does with `text` today.
3. The engine resolves the locator, then refuses unless:
   - the element is an `<input>` whose type and `autocomplete` match the kind (`type=password` for a password);
   - the origin of the frame that holds it, not only the top page's, is one of the reference's origins;
   - the frame's document has finished loading.
4. It types the value as it types `text`, spends the reference, and answers only whether it typed. The value never reaches the agent's result, its snapshot (a password field is already masked there), the transcript or the engine's logs.

The engine's other browser tools need no change. `evaluate` can still read a field's value afterwards. A client that wants to close that too submits the form in the same step, which a `submit` flag on the same call could do.

**Why this shape.** It reuses what T3 Code has: the one-use `secretRef` of `request_secret` and the `type` action. The checks are a few lines in the page, of the kind the engine already runs to find an editable element and to mask password fields. It helps every T3 Code user, not only J3 Bots: any agent that should sign in without holding a password gets the same guard. The bot still chooses the field, so the agent's flow does not change, but a wrong field is refused instead of filled.

## A smaller alternative

**The viewer's `probe` also says what has focus**: the focused element's `type`, `autocomplete` and the origin of its frame. J3 Bots would then check those itself before typing, as it checks the top page's origin now. This is a smaller change to T3 Code but helps only clients that type through a viewer. It also leaves a gap between the probe and the typing that the `secretRef` path does not have.

## What J3 Bots would change

With either, the fill would refuse a field that is not the login's kind, and a frame of another origin, and [Security: filling a login](../architecture/security.md#filling-a-login) would drop those two rows of its residual. With the `secretRef` path, J3 Bots would no longer need to hold the tab while it types, and the bot's `fill_credential` would hand the bot a reference to pass to `type`. It is also the way toward a field the bot cannot read back, the accepted residual today: typed and submitted by the engine in one step, the value is in the page only while the engine acts. A script the bot set in the page beforehand could still catch it; closing that is the engine's too, for example by refusing a secret `type` on a page where the agent ran a script.
