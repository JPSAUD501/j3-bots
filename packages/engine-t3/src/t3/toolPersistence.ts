// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

// Whether a live dynamic tool runs on purpose, which decides whether the
// engine's stop counts it as pending (`Translate.ts`, `isPersistentTool`). The
// stream drops the mark from an input above 16 KiB, so the adapter reads such
// an input again: first the item alone, which the engine cuts at 256 KiB, and
// only when the cut hides the mark, the session's transcript, which carries it
// whole.

/**
 * What the input of a dynamic tool the stream summarized says of its
 * persistence. `undecidable`: no read the engine offers returns enough of it,
 * because its transcript is past the export limit. Such a tool counts as not
 * pending: the engine's own stop still interrupts it unless it is persistent,
 * so the cost is a Stop that may settle a moment before a transient tool
 * ends, never a Stop that waits for good on a persistent one.
 */
export type ToolPersistence = "persistent" | "transient" | "undecidable";

/** The engine's test of a dynamic tool's input (**Read**, `isPersistentDynamicToolInput`). */
export const hasPersistentFlag = (input: unknown) =>
  Predicate.hasProperty(input, "persistent") && input.persistent === true;

/**
 * What `getTurnItem` ends a dynamic tool input with when it cut it short.
 * **Read** at `db51b67`, `WireProjection.ts`: it cuts a string input, or any
 * other input's JSON text, at 256 KiB (`MAX_ON_DEMAND_BYTES`, L30-31;
 * `boundDynamicValue`, L212-224; `projectTurnItemForDetail`, L255-266).
 */
const TRUNCATION_MARKER = "\n… output truncated for transport";

const decodeKey = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

const isSpace = (char: string | undefined) =>
  char === " " || char === "\t" || char === "\n" || char === "\r";

/** Where the JSON string opening at `start` ends, past its closing quote; none when the text ends first. */
const stringEnd = (text: string, start: number): Option.Option<number> => {
  for (let at = start + 1; at < text.length; at++) {
    if (text[at] === "\\") at++;
    else if (text[at] === '"') return Option.some(at + 1);
  }
  return Option.none();
};

/** Where the JSON value starting at `start` ends; none when the text ends first. */
const valueEnd = (text: string, start: number): Option.Option<number> => {
  const first = text[start];
  if (first === '"') return stringEnd(text, start);
  if (first === "{" || first === "[") {
    let depth = 0;
    for (let at = start; at < text.length; at++) {
      const char = text[at];
      if (char === '"') {
        const end = stringEnd(text, at);
        if (Option.isNone(end)) return end;
        at = end.value - 1;
      } else if (char === "{" || char === "[") {
        depth++;
      } else if (char === "}" || char === "]") {
        depth--;
        if (depth === 0) return Option.some(at + 1);
      }
    }
    return Option.none();
  }
  // A number or a literal ends at the next delimiter, which a cut may have taken.
  for (let at = start; at < text.length; at++) {
    const char = text[at];
    if (char === "," || char === "}" || char === "]" || isSpace(char)) return Option.some(at);
  }
  return Option.none();
};

/**
 * Whether the JSON object whose text `text` begins with marks itself
 * persistent, read from its top-level members up to where the text ends: a
 * member `persistent` read whole tells, `true` or anything else; none when
 * the text ends before such a member, or inside it.
 */
const persistentInPrefix = (text: string): Option.Option<boolean> => {
  let at = 0;
  const skipSpace = () => {
    while (isSpace(text[at])) at++;
  };
  skipSpace();
  if (text[at] !== "{") return Option.none();
  at++;
  while (true) {
    skipSpace();
    if (text[at] === "}") return Option.some(false);
    if (text[at] !== '"') return Option.none();
    const keyEnd = stringEnd(text, at);
    if (Option.isNone(keyEnd)) return Option.none();
    const key = decodeKey(text.slice(at, keyEnd.value));
    at = keyEnd.value;
    skipSpace();
    if (text[at] !== ":") return Option.none();
    at++;
    skipSpace();
    if (at >= text.length) return Option.none();
    if (Option.contains(key, "persistent")) {
      // Only the literal `true` marks it, and a cut can leave part of one.
      if (text[at] !== "t") return Option.some(false);
      return text.length - at >= 4 ? Option.some(text.startsWith("true", at)) : Option.none();
    }
    const end = valueEnd(text, at);
    if (Option.isNone(end)) return Option.none();
    at = end.value;
    skipSpace();
    if (text[at] === ",") at++;
    else return text[at] === "}" ? Option.some(false) : Option.none();
  }
};

/**
 * The persistence the input `getTurnItem` returned shows, or none when the
 * engine's cut hides it. A cut text that does not open with `{` was no object,
 * so it carried no mark. One that does carried the object's members in the
 * order they were written, so a `persistent` member before the cut tells; a
 * string input that itself opens with an object's text reads the same.
 */
export const persistenceInItem = (input: unknown): Option.Option<ToolPersistence> => {
  if (typeof input === "string" && input.endsWith(TRUNCATION_MARKER)) {
    const text = input.slice(0, -TRUNCATION_MARKER.length);
    if (!text.startsWith("{")) return Option.some("transient");
    return Option.map(persistentInPrefix(text), (persistent) =>
      persistent ? "persistent" : "transient",
    );
  }
  return Option.some(hasPersistentFlag(input) ? "persistent" : "transient");
};

/** What the session's transcript holds of a tool's input. */
export type WholeInput =
  | { readonly _tag: "found"; readonly input: unknown }
  /** The transcript is past its export limit, or does not list the tool. */
  | { readonly _tag: "unavailable" };

/**
 * A tool's persistence, from the item read alone when its cut shows it, and
 * from the session's transcript otherwise. A failed read fails: nothing is
 * known, and the tool is read again later.
 */
export const resolvePersistence = <EI, RI, EW, RW>(reads: {
  readonly item: Effect.Effect<unknown, EI, RI>;
  readonly whole: Effect.Effect<WholeInput, EW, RW>;
}): Effect.Effect<ToolPersistence, EI | EW, RI | RW> =>
  Effect.flatMap(reads.item, (input) =>
    Option.match(persistenceInItem(input), {
      onSome: Effect.succeed,
      onNone: () =>
        Effect.map(reads.whole, (whole): ToolPersistence => {
          if (whole._tag === "unavailable") return "undecidable";
          return hasPersistentFlag(whole.input) ? "persistent" : "transient";
        }),
    }),
  );
