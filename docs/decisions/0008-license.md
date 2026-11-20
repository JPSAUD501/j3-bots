# 0008: License

**Status:** Proposed. The repository currently carries the GPL-3.0 text.

## Context

Roster is meant to be free software under a GNU license. T3 Code, which Roster runs but does not include or modify, is MIT licensed and compatible with either option.

## Options

**GPL-3.0-or-later.** Anyone who distributes Roster or a modified version must provide its source under the same terms. Someone could run a modified Roster as a hosted service without publishing their changes.

**AGPL-3.0-or-later.** The same, and additionally anyone who lets users interact with a modified version over a network must offer those users the source.

## Recommendation

AGPL-3.0-or-later. Roster is a server that people reach over a network, and its purpose is to be the self-hosted alternative to a hosted product. AGPL is the GNU license written for that situation: it keeps improvements to a hosted variant in the commons.

## Things to settle with the license

- Whether contributors assign or license their contributions (a contributor agreement, or a sign-off).
- The license of the prompt texts, which are part of the product: the same license as the code is the simple answer.
- Names and marks. "Roster" is a working name. The project must not use T3 Code's or any other product's name or marks as its own.
