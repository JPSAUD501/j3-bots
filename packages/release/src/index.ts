// SPDX-License-Identifier: AGPL-3.0-or-later
// What every side that installs a J3 Bots release checks first, in code that
// runs anywhere a client does: the order of versions and the channels they
// are on, the release key, the signed `SHA256SUMS`, and which release a
// channel offers. Node's signature check and file hash are in
// `@j3-bots/release/node`; another platform passes its own.
export * from "./github.ts";
export * from "./keys.ts";
export * from "./verify.ts";
export * from "./version.ts";
