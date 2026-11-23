// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Schema from "effect/Schema";
import { SectionId } from "./base.ts";

/** The longest name a section takes. */
export const SECTION_NAME_LENGTH = 40;

export const SectionName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(SECTION_NAME_LENGTH),
);

/**
 * A named group of bots in the roster. The roster sends
 * the sections in the operator's order; a bot names the one it is in with
 * `sectionId`. A section holds bots only, each in at most one, and deleting
 * it leaves its bots in the roster, in no section.
 */
export const Section = Schema.Struct({
  id: SectionId,
  name: SectionName,
});
export type Section = typeof Section.Type;
