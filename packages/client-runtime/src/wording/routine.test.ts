// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotId,
  type RoutineRun,
  RoutineRunId,
  type RoutineRunStep,
  type RoutineStep,
  type RoutineTrigger,
} from "@j3-bots/contracts";
import { describe, expect, it } from "vite-plus/test";
import { at, context, plain } from "../../test/fixtures.ts";
import { miniRail, trackStations, trackStatus } from "../presentation/routineTrack.ts";
import { endReason, foldLine, routineSentence, sentenceText } from "./routine.ts";

const maya = BotId.make("maya");
const ana = BotId.make("ana");
const bruno = BotId.make("bruno");
const names = { maya: "Maya", ana: "Ana", bruno: "Bruno" };
const en = context("2026-11-23T12:00:00Z", "en", names);
const pt = context("2026-11-23T12:00:00Z", "pt-BR", names);

const monday: RoutineTrigger = {
  _tag: "schedule",
  cron: "0 9 * * 1",
  timeZone: "America/Sao_Paulo",
};

const bot = (botId: BotId, action: string): RoutineStep => ({
  _tag: "bot",
  botId,
  action,
  instruction: `${action}, as asked.`,
});

const steps: ReadonlyArray<RoutineStep> = [
  bot(maya, "gathers last week's emails"),
  { _tag: "condition", check: "there's something new" },
  bot(ana, "drafts the replies"),
  { _tag: "yes", onlyIf: null, waitHours: 24 },
  bot(bruno, "sends them"),
];

/** A run of `steps` whose steps stand as `states` say. */
const runOf = (
  status: RoutineRun["status"],
  states: ReadonlyArray<Pick<RoutineRunStep, "state"> & Partial<RoutineRunStep>>,
): RoutineRun => ({
  id: RoutineRunId.make("run"),
  startedAt: at("2026-11-23T12:00:00Z"),
  finishedAt: status === "running" ? null : at("2026-11-23T12:06:00Z"),
  status,
  attempts: 1,
  delivered: [],
  note: null,
  steps: states.map((step, index) => ({
    step: steps[index] ?? bot(maya, "does something"),
    result: null,
    startedAt: null,
    finishedAt: null,
    ...step,
  })),
});

describe("routineSentence", () => {
  it("reads the routine back from its steps, setting the bots and the operator apart", () => {
    const runs = routineSentence(monday, steps, en);
    expect(plain(sentenceText(runs))).toBe(
      "Every Monday at 9:00 AM, Maya gathers last week's emails, Ana drafts the replies, and Bruno sends them once you say yes. It goes on only if there's something new.",
    );
    expect(runs.filter((run) => run.tone !== "plain")).toEqual([
      { text: "Maya", tone: "bot" },
      { text: "Ana", tone: "bot" },
      { text: "Bruno", tone: "bot" },
      { text: "you", tone: "you" },
    ]);
  });

  it("says when the yes is asked only if something holds, in the operator's language", () => {
    const asked: ReadonlyArray<RoutineStep> = [
      bot(maya, "reúne os e-mails"),
      { _tag: "yes", onlyIf: "algo precisar de resposta", waitHours: 24 },
      bot(ana, "envia as respostas"),
    ];
    expect(sentenceText(routineSentence({ _tag: "webhook" }, asked, pt))).toBe(
      "Quando o webhook dela é chamado, Maya reúne os e-mails e Ana envia as respostas, depois que você disser sim se algo precisar de resposta.",
    );
  });
});

describe("a run as the card tells it", () => {
  it("folds a run that ran to its end into how long it took", () => {
    const run = runOf(
      "delivered",
      steps.map(() => ({ state: "done" as const })),
    );
    expect(trackStatus(run)).toBe("done");
    expect(foldLine("Monday emails", run, trackStations(steps, run), en)).toBe(
      "Monday emails, done in 6m",
    );
  });

  it("ends quietly at a condition that did not hold, skipping what came after", () => {
    const run = runOf("silent", [
      { state: "done", result: "Nothing new" },
      { state: "stopped", result: "Nothing new" },
      { state: "skipped" },
      { state: "skipped" },
      { state: "skipped" },
    ]);
    const stations = trackStations(steps, run);
    expect(trackStatus(run)).toBe("stopped-quietly");
    expect(endReason(stations, en)).toBe("Nothing new");
    expect(foldLine("Monday emails", run, stations, en)).toBe(
      "Monday emails, stopped quietly: Nothing new",
    );
    expect(miniRail(run)).toEqual([
      { _tag: "bot", index: 0, botId: maya, mark: "done" },
      { _tag: "condition", index: 1, stopped: true },
      { _tag: "bot", index: 2, botId: ana, mark: "open" },
      { _tag: "you", index: 3, mark: "open" },
      { _tag: "bot", index: 4, botId: bruno, mark: "open" },
    ]);
  });

  it("needs the operator at a failed step, but not at one they stopped", () => {
    const failed = (failure: "unreported" | "stopped") =>
      runOf("failed", [
        { state: "done", result: "14 new emails" },
        { state: "passed", result: "14 new emails" },
        { state: "failed", failure },
        { state: "skipped" },
        { state: "skipped" },
      ]);
    expect(trackStatus(failed("unreported"))).toBe("needs-you");
    expect(trackStatus(failed("stopped"))).toBe("stopped");
    expect(endReason(trackStations(steps, failed("stopped")), en)).toBe("you stopped the run");
  });

  it("waits for the operator while a yes is open", () => {
    const run = runOf("running", [
      { state: "done" },
      { state: "passed" },
      { state: "done" },
      { state: "waiting" },
      { state: "todo" },
    ]);
    expect(trackStatus(run)).toBe("waiting");
  });
});
