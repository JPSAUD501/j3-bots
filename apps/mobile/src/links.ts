// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, RoutineId } from "@j3-bots/contracts";
import Constants from "expo-constants";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * What a link into the app opens: a bot's conversation, or a routine's runs.
 * A Direct Share shortcut and a widget open the app through one (Android
 * hands it to the app as the link it was opened with).
 */
export type AppLink =
  | { readonly _tag: "bot"; readonly botId: BotId }
  | { readonly _tag: "routine"; readonly botId: BotId; readonly routineId: RoutineId };

const PATH = "open";

/** The link that opens `target`, under the app's link scheme. */
export const appLink = (scheme: string, target: AppLink): string => {
  const parts =
    target._tag === "bot" ? ["bot", target.botId] : ["routine", target.botId, target.routineId];
  return `${scheme}://${PATH}/${parts.map(encodeURIComponent).join("/")}`;
};

const decodeBotId = Schema.decodeUnknownOption(BotId);
const decodeRoutineId = Schema.decodeUnknownOption(RoutineId);

const segment = (part: string): string | null => {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
};

/** What `url` opens, when it is one of the app's own links under `scheme`; null for any other. */
export const appLinkOf = (scheme: string, url: string): AppLink | null => {
  const prefix = `${scheme}://${PATH}/`;
  if (!url.startsWith(prefix)) return null;
  const parts = url.slice(prefix.length).split("/").map(segment);
  const [kind, bot, routine, ...more] = parts;
  if (more.length > 0) return null;
  const botId = Option.getOrNull(decodeBotId(bot));
  if (botId === null) return null;
  if (kind === "bot" && routine === undefined) return { _tag: "bot", botId };
  const routineId = Option.getOrNull(decodeRoutineId(routine));
  if (kind === "routine" && routineId !== null) return { _tag: "routine", botId, routineId };
  return null;
};

const Scheme = Schema.String.check(Schema.isMinLength(1));

/** The app's link scheme, which each variant has its own of (app.config.ts). */
export const appScheme = (): string | null =>
  Option.getOrNull(Schema.decodeUnknownOption(Scheme)(Constants.expoConfig?.scheme));
