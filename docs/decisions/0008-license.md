# 0008: License

**Status:** Accepted

## Decision

J3 Bots is licensed under the GNU Affero General Public License, version 3 or later (AGPL-3.0-or-later). This covers the code and the prompt texts, which are part of the product.

## Why

J3 Bots is a server people reach over a network, and its purpose is to be the self-hosted alternative to a hosted product. Under the plain GPL, someone could run a modified J3 Bots as a hosted service without publishing their changes. The AGPL closes that gap: anyone who lets users interact with a modified version over a network must offer those users its source.

T3 Code, which J3 Bots runs but does not include or modify, is MIT licensed. Running it, and reusing parts of its source with attribution, is compatible with the AGPL.

## Consequences

- Companies that avoid AGPL software will not adopt or contribute to J3 Bots. Accepted.
- Every source file will carry an SPDX identifier once code exists.
- How outside contributions are licensed, and how that interacts with distributing the mobile app through app stores, is [open question 5](../open-questions.md).
- The project must not use T3 Code's or any other product's name or marks as its own.
