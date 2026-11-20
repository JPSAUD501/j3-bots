// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Option from "effect/Option";

// Memory as the `remember`, `forget` and `recall` tools see it: one fact per
// Markdown bullet. The pinned note holds `- fact` lines; a log file holds
// `- yyyy-mm-dd: fact` lines, dated in the operator's time zone. Anything else
// in a file (headings, prose the operator wrote) is kept as it is and is not a
// fact.

/** A fact found in a file. */
export interface Fact {
  readonly text: string;
  /** `yyyy-mm-dd`, for a log line. */
  readonly date: string | null;
}

const BULLET = /^- (?:(\d{4}-\d{2}-\d{2}): )?(.+)$/;

/** One line, with runs of whitespace made single spaces. */
export const oneLine = (fact: string): string => fact.replace(/\s+/g, " ").trim();

/** What two facts compare by: case and spacing do not make a new fact. */
const comparable = (fact: string): string => oneLine(fact).toLowerCase();

export const parseFacts = (text: string): ReadonlyArray<Fact> =>
  text.split("\n").flatMap((line) => {
    const match = BULLET.exec(line.trimEnd());
    const fact = match?.[2];
    return fact === undefined ? [] : [{ text: fact, date: match?.[1] ?? null }];
  });

/** Whether any of the texts already holds the fact. */
export const holdsFact = (texts: ReadonlyArray<string>, fact: string): boolean => {
  const wanted = comparable(fact);
  return texts.some((text) => parseFacts(text).some(({ text }) => comparable(text) === wanted));
};

/** The file's text with one more line at the end. */
export const appendLine = (text: string, line: string): string =>
  text === "" || text.endsWith("\n") ? `${text}${line}\n` : `${text}\n${line}\n`;

/** The file's text without the lines holding the fact, or `None` when none does. */
export const withoutFact = (text: string, fact: string): Option.Option<string> => {
  const wanted = comparable(fact);
  const lines = text.split("\n");
  const kept = lines.filter((line) => {
    const match = BULLET.exec(line.trimEnd());
    return match?.[2] === undefined || comparable(match[2]) !== wanted;
  });
  return kept.length === lines.length ? Option.none() : Option.some(kept.join("\n"));
};

/** A fact `recall` found, with where it came from. */
export interface Recalled extends Fact {
  readonly scope: "bot" | "shared";
}

const words = (text: string): ReadonlyArray<string> =>
  text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The facts that share words with the query, the most shared words first and,
 * among equals, the newest first. Plain word matching: a fact matches a query
 * word when one of its words starts with it, so "deploy" finds "deployment".
 */
export const search = (
  facts: ReadonlyArray<Recalled>,
  query: string,
  limit: number,
): ReadonlyArray<Recalled> => {
  const terms = [...new Set(words(query))];
  return facts
    .map((fact) => {
      const own = words(fact.text);
      const score = terms.filter((term) => own.some((word) => word.startsWith(term))).length;
      return { fact, score };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) => b.score - a.score || (b.fact.date ?? "9999").localeCompare(a.fact.date ?? "9999"),
    )
    .slice(0, limit)
    .map(({ fact }) => fact);
};

const luhn = (digits: string): boolean => {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
};

const KNOWN_TOKENS =
  /\b(?:sk-[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,})/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const LABELLED_SECRET =
  /\b(?:password|passwd|passcode|pin|secret|token|api[ _-]?key|private[ _-]?key)\s*(?:is|was|:|=)\s*\S/i;
const LONG_RUN = /[A-Za-z0-9+/=_-]{32,}/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;

/**
 * Whether the text looks like it holds a credential: a known key format, a
 * labelled password or token, a private key, a long mixed-case token, or a card
 * number. `remember` refuses such text: memory files are plain text anyone on
 * the machine can read, and credentials go through the engine's secret request.
 * It errs on the side of refusing; the bot can say the same thing without the value.
 */
export const looksLikeCredential = (text: string): boolean => {
  if (KNOWN_TOKENS.test(text) || PRIVATE_KEY.test(text) || LABELLED_SECRET.test(text)) {
    return true;
  }
  for (const run of text.match(LONG_RUN) ?? []) {
    if (/\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  return (text.match(CARD) ?? []).some((candidate) => luhn(candidate.replace(/\D/g, "")));
};
