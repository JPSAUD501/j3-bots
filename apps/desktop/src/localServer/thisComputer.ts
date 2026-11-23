// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- The computer's name and the operator's login shell, which only Node's os module reads.
import * as NodeOS from "node:os";

/** What the server on this computer is named after, and the shell whose PATH it gets. */
export interface ThisComputer {
  readonly hostname: string;
  /** The operator's login shell, as the system's user database names it, if it does. */
  readonly loginShell: string | null;
}

export const thisComputer = (): ThisComputer => {
  let loginShell: string | null = null;
  try {
    loginShell = NodeOS.userInfo().shell;
  } catch {
    // A user the system's database does not list (some containers).
  }
  return { hostname: NodeOS.hostname(), loginShell };
};
