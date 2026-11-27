// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Label, OpenLiterals, SkillName } from "./base.ts";

/**
 * A tool J3 Bots names in its own words, wherever the operator meets it: a
 * work step, the roster, the line under a bot's name. The engine adapter maps
 * the names the engine and the harnesses give their tools onto these, so no
 * client ever shows one of those names. A tool it cannot name has none
 * (`null`), and its step's label carries the tool's own name, made readable.
 *
 * - `task-status`, `task-stop`: looks in on work that goes on after the
 *   turn, stops it. `background-task`, the start of such work, is no longer
 *   written: a task the engine delegates is a little one of the turn
 *   (`TurnWork`, decision 0070). Steps stored before keep it.
 * - `secret`: asks the operator for a credential.
 * - `login`: fills a saved login into the bot's browser tab; the step's
 *   `fill` says how it went.
 * - `connector`: a tool of a service the operator connected (decision 0027);
 *   the step's label names the connector and its tool.
 * - `connector-skill`: loads a skill a connector serves (decision 0089); the
 *   step's `skill` names the skill and the connector.
 * - `browser`: drives a web page in a browser.
 * - `pull-request`, `issue`: works on a code host's pull request or issue.
 * - `schedule`: the engine's own scheduled tasks.
 * - `device`: a phone or tablet simulator.
 * - `web-page`: reads a web page.
 * - `plan`: kept the harness's list of what is left to do. No longer
 *   written: the list is the turn's plan (`TurnWork`). Steps stored before
 *   keep it.
 * - `image`: looks at an image.
 * - `built-in`: any other tool the engine itself offers.
 * - `mcp-server-added`, `mcp-server-changed`, `mcp-server-removed`: the bot
 *   added an MCP server, changed one (its values, command or bots) or removed
 *   one (decision 0049); `mcp-servers-read`: it searched for servers or
 *   listed its own.
 * - `skill-saved`, `skill-removed`: the bot saved or installed a skill, or
 *   removed one; `skills-read`: it listed its skills.
 */
export const WorkTool = Schema.Literals([
  "background-task",
  "task-status",
  "task-stop",
  "secret",
  "login",
  "connector",
  "connector-skill",
  "browser",
  "pull-request",
  "issue",
  "schedule",
  "device",
  "web-page",
  "plan",
  "image",
  "built-in",
  "mcp-server-added",
  "mcp-server-changed",
  "mcp-server-removed",
  "mcp-servers-read",
  "skill-saved",
  "skill-removed",
  "skills-read",
]);
export type WorkTool = typeof WorkTool.Type;

/**
 * A step's tool as a client receives it: one added after this build decodes
 * as `unknown`, which a client words as a tool it cannot name. Absent from a
 * server, or a stored step, that predates it.
 */
export const StepTool = Schema.NullOr(OpenLiterals(WorkTool.literals)).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
);
export type StepTool = typeof StepTool.Type;

/**
 * The skill a `connector-skill` step loads: its name, and the connector that
 * serves it, as the operator knows it.
 */
export const StepSkill = Schema.Struct({ name: SkillName, connector: Label });
export type StepSkill = typeof StepSkill.Type;

/** The most steps a plan carries: a longer one keeps its first steps (decision 0070). */
export const MAX_PLAN_STEPS = 100;

/** The longest a plan step's text is: a longer one is cut, with an ellipsis. */
export const MAX_PLAN_STEP_LENGTH = 300;

/**
 * Where a step of a plan stands: still to do, being done now, or done. A
 * status added after this build decodes as `unknown`, which a client shows
 * as a step still to do.
 */
export const PlanStepStatus = Schema.Literals(["pending", "running", "done"]);
export type PlanStepStatus = typeof PlanStepStatus.Type;

/** One line of a plan, in the bot's own words. */
export const PlanStep = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PLAN_STEP_LENGTH)),
  status: OpenLiterals(PlanStepStatus.literals),
});
export type PlanStep = typeof PlanStep.Type;

/**
 * A turn's plan as it stands: the checklist the bot keeps of what it is
 * doing, from its harness's list of what is left to do. A newer plan of the
 * same turn replaces it whole; a turn that ended keeps the last one. Steps
 * are in the bot's order, and carry no id: a plan is told whole each time.
 */
export const Plan = Schema.Struct({
  steps: Schema.NonEmptyArray(PlanStep).check(Schema.isMaxLength(MAX_PLAN_STEPS)),
});
export type Plan = typeof Plan.Type;

/** The most little ones a turn's work lists by name; `LittleOnes` counts the rest. */
export const MAX_LITTLE_ONES = 16;

/** The longest a little one's label is: a few words, never its instructions. */
export const MAX_LITTLE_ONE_LABEL_LENGTH = 80;

/** A little one, stable for its turn. */
export const LittleOneId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).pipe(
  Schema.brand("LittleOneId"),
);
export type LittleOneId = typeof LittleOneId.Type;

/**
 * How a little one's work stands. `failed` covers work that was stopped, as
 * well as work that went wrong: the bot tells which in its message. A status
 * added after this build decodes as `unknown`, which a client shows as
 * ended.
 */
export const LittleOneStatus = Schema.Literals(["working", "done", "failed"]);
export type LittleOneStatus = typeof LittleOneStatus.Type;

/**
 * Part of a turn's work the bot handed to a copy of itself that works beside
 * it at the same time (a subagent of its harness, or a task the engine
 * delegated): what clients draw as one of the bot's little ones. It has no
 * name and no conversation of its own, and never carries what it found: the
 * bot tells the result.
 */
export const LittleOne = Schema.Struct({
  id: LittleOneId,
  /**
   * What it does, in a few words: the short description the harness gave
   * the subagent, or a short label made from the start of its instructions,
   * never the instructions themselves. Null when the engine gave neither,
   * which a client words in the operator's language.
   */
  label: Schema.NullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_LITTLE_ONE_LABEL_LENGTH)),
  ),
  status: OpenLiterals(LittleOneStatus.literals),
  startedAt: Schema.DateTimeUtc,
  /** Null while it works. */
  finishedAt: Schema.NullOr(Schema.DateTimeUtc),
  /**
   * While it works, the last thing it said of how far it got, when the
   * engine reports that: one line, cleaned.
   */
  progress: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type LittleOne = typeof LittleOne.Type;

/**
 * Every little one of a turn, nested ones flattened into the turn's, in the
 * order they started. A turn with more than `MAX_LITTLE_ONES` keeps in `ones`
 * every one still working, then those that ended last. `working` and `total`
 * count all of them, those left out of `ones` too, so a client that shows a
 * few says how many more there are.
 */
export const LittleOnes = Schema.Struct({
  ones: Schema.Array(LittleOne).check(Schema.isMaxLength(MAX_LITTLE_ONES)),
  working: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type LittleOnes = typeof LittleOnes.Type;

/**
 * A turn's plan and its little ones, shown only to the turn's audience: in
 * the bot's conversation on the turn's work fold (`WorkFoldEntry.work`), in
 * a room by the member whose turn it is (`Room.memberWork`). Null `plan` and
 * no little ones are never sent: a turn with neither has no `TurnWork`.
 */
export const TurnWork = Schema.Struct({
  plan: Schema.NullOr(Plan),
  littleOnes: LittleOnes,
});
export type TurnWork = typeof TurnWork.Type;
