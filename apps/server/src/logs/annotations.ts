// SPDX-License-Identifier: AGPL-3.0-or-later

// Log annotations that name something of the operator's. They stay in the
// log on the operator's machine, where they help them, and a diagnostics zip
// leaves them out (docs/decisions/0100-…): a line that would name such a
// thing in its message names it in one of these instead.

/** A name a plain-HTTP request asked the server by, which it refused: one the operator's network uses. */
export const REFUSED_NAME = "refusedName";

/** The annotations a diagnostics zip leaves out of each line. */
export const PRIVATE_ANNOTATIONS: ReadonlySet<string> = new Set([REFUSED_NAME]);
