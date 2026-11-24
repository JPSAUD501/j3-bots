// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * J3 Bots' own glyphs for connectors, by name: simple line drawings of what a
 * service does (an envelope, a folder, a board), never a vendor's logo. A
 * connector names one (`ConnectorGlyph` in the contracts); a name a client
 * does not have, as from a newer server, is drawn as the connector's first
 * letter.
 *
 * Each is SVG path data in a 24-unit box, drawn as a line and never filled:
 * `fill="none"`, `stroke="currentColor"`, a stroke 2 units wide, with round
 * caps and joins. That is the grid and the weight of the interface's other
 * icons, so a glyph sits beside them in either theme.
 */
export const CONNECTOR_GLYPHS = {
  notebook: ["M6 3h12v18H6z", "M9.5 3v18", "M13 8h2.5", "M13 12h2.5"],
  "check-circle": ["M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0", "M8 12.5l2.5 2.5l5.5-6"],
  board: ["M3.5 4h4.5v16H3.5z", "M9.75 4h4.5v10h-4.5z", "M16 4h4.5v6H16z"],
  branch: [
    "M4 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
    "M16 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
    "M6 4v12",
    "M18 8v1c0 3.5-3 5.5-12 6.5",
  ],
  upload: ["M12 16V5", "M7 10l5-5l5 5", "M5 19h14"],
  database: [
    "M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3s-3.1 3-7 3s-7-1.3-7-3",
    "M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6",
    "M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3",
  ],
  vector: ["M5 16.5C9 9 15 15 19 7.5", "M2.5 16.5h5v5h-5z", "M16.5 2.5h5v5h-5z"],
  card: ["M3 6h18v12H3z", "M3 10h18", "M7 15h3"],
  envelope: ["M3 6h18v12H3z", "M3 7l9 6l9-6"],
  calendar: ["M4 5h16v15H4z", "M4 10h16", "M8 3v4", "M16 3v4"],
  folder: ["M3 6h6l2 2h10v11H3z"],
  document: ["M6 3h8l4 4v14H6z", "M14 3v4h4", "M9 12h6", "M9 16h6"],
  grid: ["M4 4h16v16H4z", "M4 10h16", "M4 15h16", "M10 4v16"],
  presentation: ["M3 4h18v12H3z", "M12 16v4", "M8 20h8"],
  bubble: ["M4 5h16v11H9l-5 4z"],
  person: ["M8 8a4 4 0 1 0 8 0a4 4 0 1 0-8 0", "M4 21c0-4 3.6-6 8-6s8 2 8 6"],
  bubbles: ["M3 4h11v8H7l-4 3z", "M17 9h4v11l-4-3h-7v-2"],
} as const satisfies Record<string, ReadonlyArray<string>>;

export type ConnectorGlyphName = keyof typeof CONNECTOR_GLYPHS;

export const isConnectorGlyphName = (name: string): name is ConnectorGlyphName =>
  Object.hasOwn(CONNECTOR_GLYPHS, name);
