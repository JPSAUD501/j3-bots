// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Track's words (decision 0080): the sentence that reads a routine back,
 * each station's lines, the card's tag, and the line a finished run folds
 * into. Built from the routine's structured steps and the run's states; a
 * step's action, a result and a question are the bots' own words, in the
 * operator's language, shown as content.
 */
import type { BotId, RoutineRun, RoutineStep } from "@j3-bots/contracts";
import type { KeyWith } from "@j3-bots/i18n";
import {
  keptResults,
  type Station,
  type StationOf,
  type TrackStatus,
  type TrackTrigger,
} from "../presentation/routineTrack.ts";
import { clockTime, millisBetween, shortDuration } from "../presentation/time.ts";
import { triggerInWords } from "./schedule.ts";
import type { PresentationContext } from "./status.ts";
import { timeInSentence } from "./time.ts";

/** One run of the sentence: plain words, a bot's name, or "you". */
export interface SentenceRun {
  readonly text: string;
  readonly tone: "plain" | "bot" | "you";
}

type Clause = ReadonlyArray<SentenceRun>;

const nameOf = (botId: BotId, ctx: PresentationContext) =>
  ctx.botName(botId) ?? ctx.i18n.t("bot.unknown");

/** A sentence `i18n.parts` split, its placeholders filled with runs, as runs. */
const flat = (parts: ReadonlyArray<string | Clause>): Clause =>
  parts.flatMap((part): Clause =>
    typeof part === "string" ? [{ text: part, tone: "plain" }] : part,
  );

const plain = (text: string): Clause => [{ text, tone: "plain" }];

/**
 * The routine in one sentence, from its steps: "Every Monday at 9:00, Maya
 * gathers last week's emails, Ana drafts the replies, and Bruno sends them
 * once you say yes. It goes on only if there's something new." Bot names and
 * "you" are runs of their own, which the card sets apart.
 */
export function routineSentence(
  trigger: TrackTrigger,
  steps: ReadonlyArray<RoutineStep>,
  ctx: PresentationContext,
): ReadonlyArray<SentenceRun> {
  const { i18n } = ctx;
  const you: Clause = [{ text: i18n.t("routine.sentence.you"), tone: "you" }];
  const clauses: Array<Clause> = [];
  const conditions: Array<string> = [];
  let yes: Extract<RoutineStep, { _tag: "yes" }> | null = null;
  for (const step of steps) {
    switch (step._tag) {
      case "condition":
        conditions.push(step.check);
        break;
      case "yes":
        yes = step;
        break;
      case "bot": {
        const bot: Clause = [{ text: nameOf(step.botId, ctx), tone: "bot" }];
        const action = plain(step.action);
        clauses.push(
          flat(
            yes === null
              ? i18n.parts("routine.sentence.step", { bot, action })
              : yes.onlyIf === null
                ? i18n.parts("routine.sentence.afterYes", { bot, action, you })
                : i18n.parts("routine.sentence.afterYesIf", {
                    bot,
                    action,
                    you,
                    onlyIf: plain(yes.onlyIf),
                  }),
          ),
        );
        yes = null;
        break;
      }
    }
  }
  // The clauses joined as the language lists things: "a, b, and c".
  const marks = clauses.map((_, at) => `\u0000${at}`);
  const joined = new Intl.ListFormat(i18n.locale, { type: "conjunction" })
    .formatToParts(marks)
    .flatMap((part): Clause => {
      if (part.type === "literal") return plain(part.value);
      return clauses[Number(part.value.slice(1))] ?? [];
    });
  const opening = triggerInWords(trigger, ctx);
  const sentence =
    opening === null
      ? [...joined, ...plain(".")]
      : flat(i18n.parts("routine.sentence.whole", { trigger: plain(opening), steps: joined }));
  const after = conditions.flatMap((check) => [
    ...plain(" "),
    ...plain(i18n.t("routine.sentence.goesOnIf", { check })),
  ]);
  return merge([...sentence, ...after]);
}

/** Neighbouring plain runs as one. */
function merge(runs: ReadonlyArray<SentenceRun>): ReadonlyArray<SentenceRun> {
  const merged: Array<SentenceRun> = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last?.tone === "plain" && run.tone === "plain") {
      merged[merged.length - 1] = { text: last.text + run.text, tone: "plain" };
    } else if (run.text !== "") merged.push(run);
  }
  return merged;
}

/**
 * Each run with where it starts in the sentence, as its key: it stays while
 * the sentence does.
 */
export function keyedRuns(
  runs: ReadonlyArray<SentenceRun>,
): ReadonlyArray<SentenceRun & { readonly key: number }> {
  let start = 0;
  return runs.map((run) => {
    const key = start;
    start += run.text.length;
    return { ...run, key };
  });
}

/** The sentence as plain text: the card's description, for whoever cannot see it. */
export const sentenceText = (runs: ReadonlyArray<SentenceRun>): string =>
  runs.map((run) => run.text).join("");

const statusWords: Record<TrackStatus, KeyWith<never>> = {
  new: "routine.track.new",
  running: "routine.track.running",
  waiting: "card.waiting",
  "needs-you": "routine.track.needsYou",
  stopped: "routine.track.stopped",
  done: "routine.track.done",
  "stopped-quietly": "routine.track.stoppedQuietly",
};

/** The card's tag: where the run stands, in a word or two. */
export const trackTag = (status: TrackStatus, ctx: PresentationContext): string =>
  ctx.i18n.t(statusWords[status]);

/**
 * Where a station stands, in words, read first for whoever cannot see its
 * mark; null for the trigger and for a routine at rest, which stand nowhere.
 */
export function stationStateText(station: Station, ctx: PresentationContext): string | null {
  const { t } = ctx.i18n;
  if (station._tag === "trigger") return null;
  switch (station.state) {
    case "rest":
      return null;
    case "todo":
      return t("routine.step.state.todo");
    case "doing":
      return t("routine.step.state.doing");
    case "waiting":
      return t("routine.step.state.waiting");
    case "failed":
      return t("routine.step.state.failed");
    case "skipped":
    case "not-needed":
      return t("routine.step.state.skipped");
    default:
      return t("routine.step.state.done");
  }
}

/**
 * Why the steps after where a run ended were skipped, as the clause of
 * "Skipped: {reason}"; null while nothing ended it.
 */
export function endReason(
  stations: ReadonlyArray<Station>,
  ctx: PresentationContext,
): string | null {
  const { t } = ctx.i18n;
  for (const station of stations) {
    switch (station._tag) {
      case "condition":
        if (station.state === "stopped") return station.result ?? station.check;
        break;
      case "you":
        if (station.state === "no") {
          return t("routine.skip.no", { choice: station.ask?.no ?? t("routine.sentence.you") });
        }
        if (station.state === "timed-out") return t("routine.skip.timedOut");
        if (station.state === "failed") return t("routine.skip.stopped");
        break;
      case "bot":
        if (station.state === "failed") {
          return t(station.failure === "stopped" ? "routine.skip.stopped" : "routine.skip.failed");
        }
        break;
      case "trigger":
        break;
    }
  }
  return null;
}

/** A bot step's title: "Maya gathers last week's emails". */
export const botStationTitle = (station: StationOf<"bot">, ctx: PresentationContext): string =>
  `${nameOf(station.botId, ctx)} ${station.action}`;

/** The line under a bot step's title, or null. */
export function botStationSub(
  station: StationOf<"bot">,
  reason: string | null,
  ctx: PresentationContext,
): string | null {
  const { t } = ctx.i18n;
  switch (station.state) {
    case "done":
      return station.result;
    case "skipped":
      return reason === null ? null : t("routine.step.skipped", { reason });
    case "doing":
      return station.retryAt === null
        ? null
        : t("routine.step.retryAt", { time: clockTime(station.retryAt, ctx) });
    case "failed":
      return failureHappened(station, ctx);
    default:
      return null;
  }
}

/** What happened at a failed bot step, in plain words. */
function failureHappened(station: StationOf<"bot">, ctx: PresentationContext): string {
  const { t } = ctx.i18n;
  const bot = nameOf(station.botId, ctx);
  switch (station.failure) {
    case "blocked":
      return station.result ?? t("routine.failed.turnFailed", { bot });
    case "unreported":
      return t("routine.failed.unreported", { bot });
    case "bot-gone":
      return t("routine.failed.botGone");
    case "stopped":
      return t("routine.failed.stopped");
    case "turn-failed":
    case null:
      return t("routine.failed.turnFailed", { bot });
  }
}

/**
 * What the operator can do about a failed step, and what is kept, under
 * what happened: each a sentence of its own, in order.
 */
export function failureHelp(
  station: StationOf<"bot">,
  stations: ReadonlyArray<Station>,
  owner: BotId,
  ctx: PresentationContext,
): ReadonlyArray<string> {
  const { t } = ctx.i18n;
  if (station.failure === "stopped") return [];
  const lines: Array<string> = [];
  if (station.partial) lines.push(t("routine.failed.partial"));
  lines.push(
    station.failure === "bot-gone"
      ? t("routine.failed.change", { owner: nameOf(owner, ctx) })
      : t("routine.failed.fix"),
  );
  const kept = keptResults(stations);
  if (kept.length > 0) {
    lines.push(
      t("routine.failed.kept", {
        kept: new Intl.ListFormat(ctx.i18n.locale, { type: "conjunction" }).format(kept),
      }),
    );
  }
  return lines;
}

/** A condition's title: the check at rest; once judged, the result and what came of it. */
export function conditionTitle(station: StationOf<"condition">, ctx: PresentationContext): string {
  const { t } = ctx.i18n;
  const result = station.result ?? station.check;
  switch (station.state) {
    case "passed":
      return t("routine.gate.goesOn", { result });
    case "stopped":
      return t("routine.gate.stopped", { result });
    default:
      return t("routine.gate.onlyIf", { check: station.check });
  }
}

/** The operator's stop: its title, and the line under it. */
export function youStationLines(
  station: StationOf<"you">,
  reason: string | null,
  ctx: PresentationContext,
): { readonly title: string; readonly sub: string | null } {
  const { t } = ctx.i18n;
  const title = t("routine.you.title");
  switch (station.state) {
    case "rest":
    case "todo":
      return {
        title,
        sub:
          station.onlyIf === null ? null : t("routine.you.onlyIf", { condition: station.onlyIf }),
      };
    case "waiting":
      return {
        title: station.ask?.question ?? title,
        sub:
          station.ask === null
            ? null
            : t("routine.you.until", { when: timeInSentence(station.ask.deadline, ctx) }),
      };
    case "yes":
    case "no":
      return {
        title,
        sub:
          station.answer === null
            ? null
            : t("routine.you.said", {
                choice:
                  (station.answer.choice === "yes" ? station.ask?.yes : station.ask?.no) ??
                  station.answer.choice,
                time: clockTime(station.answer.at, ctx),
              }),
      };
    case "timed-out":
      return {
        title,
        sub:
          station.ask === null
            ? null
            : t("routine.you.timedOut", { when: timeInSentence(station.ask.deadline, ctx) }),
      };
    case "not-needed":
      return { title, sub: t("routine.step.notNeeded") };
    case "skipped":
      return { title, sub: reason === null ? null : t("routine.step.skipped", { reason }) };
    case "failed":
      return { title, sub: t("routine.failed.stopped") };
  }
}

/** The one line a finished run folds into: "Monday emails, done in 6 min". */
export function foldLine(
  name: string,
  run: RoutineRun,
  stations: ReadonlyArray<Station>,
  ctx: PresentationContext,
): string {
  const { t } = ctx.i18n;
  const reason = endReason(stations, ctx);
  if (reason !== null) return t("routine.fold.stopped", { name, reason });
  const duration =
    run.finishedAt === null ? 0 : Math.max(0, millisBetween(run.startedAt, run.finishedAt));
  return t("routine.fold.done", { name, duration: shortDuration(duration, ctx.i18n) });
}
