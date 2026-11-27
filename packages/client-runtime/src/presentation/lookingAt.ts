// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LookingAt } from "@j3-bots/contracts";

/**
 * The window the operator was looking at as they wrote, on one line, as
 * every client names it: its app, then its title when there is one.
 */
export const lookingAtLine = (lookingAt: LookingAt): string =>
  lookingAt.title === undefined ? lookingAt.app : `${lookingAt.app} · ${lookingAt.title}`;
