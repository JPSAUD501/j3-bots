// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext } from "react";

/**
 * The widest a bubble and a card grow in the conversation's
 * column, and the column's own width, in px.
 */
export const EntryWidths = createContext({ bubble: 0, card: 0, column: 0 });
