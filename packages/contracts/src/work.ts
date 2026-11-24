// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OpenLiterals } from "./base.ts";

/**
 * A tool J3 Bots names in its own words, wherever the operator meets it: a
 * work step, the roster, the line under a bot's name. The engine adapter maps
 * the names the engine and the harnesses give their tools onto these, so no
 * client ever shows one of those names. A tool it cannot name has none
 * (`null`), and its step's label carries the tool's own name, made readable.
 *
 * - `background-task`, `task-status`, `task-stop`: starts work that goes on
 *   after the turn, looks in on it, stops it.
 * - `secret`: asks the operator for a credential.
 * - `login`: fills a saved login into the bot's browser tab; the step's
 *   `fill` says how it went.
 * - `browser`: drives a web page in a browser.
 * - `pull-request`, `issue`: works on a code host's pull request or issue.
 * - `schedule`: the engine's own scheduled tasks.
 * - `device`: a phone or tablet simulator.
 * - `web-page`: reads a web page.
 * - `plan`: keeps the harness's list of what is left to do.
 * - `image`: looks at an image.
 * - `built-in`: any other tool the engine itself offers.
 */
export const WorkTool = Schema.Literals([
  "background-task",
  "task-status",
  "task-stop",
  "secret",
  "login",
  "browser",
  "pull-request",
  "issue",
  "schedule",
  "device",
  "web-page",
  "plan",
  "image",
  "built-in",
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
