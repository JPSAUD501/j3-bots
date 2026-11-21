# 0008: License

**Status:** Accepted

## Decision

J3 Bots is licensed under the GNU Affero General Public License, version 3 or later (AGPL-3.0-or-later), with one additional permission under the license's section 7: it may be distributed through an app store whose terms conflict with the AGPL, as long as the same source is also available under the AGPL through a channel without those terms ([LICENSE-APP-STORE](../../LICENSE-APP-STORE)). The license covers the code and the prompt texts, which are part of the product.

**Contributions come in under the same terms.** Every commit is signed off under the [Developer Certificate of Origin](https://developercertificate.org/), and with the sign-off its author licenses the commit under AGPL-3.0-or-later with the app-store permission ([CONTRIBUTING.md](../../CONTRIBUTING.md#sign-off)). There is no contributor agreement. CI refuses a pull request with a commit its author did not sign off. A contribution made with an AI tool follows the same rules, and the person who submits it signs off.

**The permission is not new legal text.** Its wording is taken from wger Flutter, an app under AGPL-3.0-or-later that ships through the App Store, with only the program's name changed. The file names the source.

**A distribution carries its notices.** A release archive carries `LICENSE`, `LICENSE-APP-STORE` and `THIRD_PARTY_NOTICES`, the license of everything in it that J3 Bots did not write, made from what its bundles hold ([decision 0015](0015-a-release-is-a-self-contained-archive.md)). Any other build that is given to people, such as a desktop or mobile package, carries the same before it is published.

## Why

**The AGPL, not the GPL.** J3 Bots is a server people reach over a network, and its purpose is to be the self-hosted alternative to a hosted product. Under the plain GPL, someone could run a modified J3 Bots as a hosted service without publishing their changes. The AGPL closes that gap: anyone who lets users interact with a modified version over a network must offer those users its source.

**An app-store permission.** App store terms put restrictions on the people who install an app, and the AGPL forbids adding restrictions on its recipients (section 10). A copyright holder may distribute their own work on any terms, but a work with many authors can be published in a store only if every author allows it. A permission every contributor grants settles that once, for every store and every future contributor, instead of asking each author before a release.

**A sign-off, not a contributor agreement.** A sign-off is a line in each commit, which CI can check and which leaves nothing to administer. Each contributor keeps their copyright and grants exactly what everyone else gets, so no one, the owner included, can take the project under other terms. Section 7 lets anyone who passes on a copy remove the app-store permission from it; a contribution licensed without it could not go into a store build, which is why the permission is part of the terms every contribution comes in under.

T3 Code, which J3 Bots runs but does not include or modify, is MIT licensed. Running it, and reusing parts of its source with attribution, is compatible with the AGPL.

## Consequences

- Companies that avoid AGPL software will not adopt or contribute to J3 Bots. Accepted.
- Every first-party source file carries an SPDX identifier, and the lint step checks it.
- The desktop packages the release workflow builds carry no third-party notices yet. No release has published them, and none may until they do.
- A third-party dependency whose license does not allow app-store distribution cannot go into a store build, whatever J3 Bots' own permission says.
- Commits made before the sign-off rule carry no sign-off. CI checks only the commits a pull request adds.
- The project must not use T3 Code's or any other product's name or marks as its own. The names J3 Bots uses are listed in [Concepts: Names](../product/concepts.md#names).

## Rejected

**A contributor license agreement** that assigns or licenses rights to the owner. It would let the owner relicense the project, which nobody needs, and it is a document every contributor has to sign and someone has to keep.

**No outside contributions.** It keeps the rights simple and the project closed to the help it is published to invite.
