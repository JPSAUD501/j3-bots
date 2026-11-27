# Proposal: a typed secret in the engine's browser

**Status:** Withdrawn by [decision 0110](../decisions/0110-j3-bots-runs-its-own-browsers-and-the-engines-is-off.md). It was never sent to T3 Code.

It asked T3 Code for a `type` action that takes a one-use secret reference and checks, beside the page, which field has focus and which frame it is in. J3 Bots filled a saved login as a viewer of the engine's browser, which could not tell either ([decision 0037](../decisions/0037-the-server-types-a-saved-login-into-the-bots-tab.md)).

J3 Bots now runs its own browsers, so its own driver can make both checks before it types. Nothing is asked of T3 Code.
