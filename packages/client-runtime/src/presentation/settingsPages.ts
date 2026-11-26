// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus } from "@j3-bots/contracts";
import { providerGate } from "./engine.ts";

/**
 * A page of Settings. Each setting is on the one page an operator would look
 * for it on:
 * - `you`: what bots call the operator, and their time zone;
 * - `notifications`: whether J3 Bots notifies, this device's permission, and
 *   how much a notification says;
 * - `appearance`: this device's theme and language;
 * - `providers`: the engine, each provider, its version and its sign-in;
 * - `usage`: each provider's limits, and the bots that used its turns;
 * - `connectors`: the services bots can use;
 * - `secrets`: the logins and keys bots use, and the bots' browser's sign-ins;
 * - `devices`: this device (signing it out, the desktop app's shortcut) and
 *   every paired one, with pairing another;
 * - `where`: where the bots live and moving them, in the desktop app and on
 *   a phone;
 * - `updates`: the versions the server and the app run, and their updates.
 */
export type SettingsPage =
  | "you"
  | "notifications"
  | "appearance"
  | "providers"
  | "usage"
  | "connectors"
  | "secrets"
  | "devices"
  | "where"
  | "updates";

/**
 * Settings' pages in the order they are listed, in groups set apart by space:
 * the operator's own, then what the bots run on and use, then this setup. A
 * client leaves out a page it has nothing for, as a browser does `where`.
 */
export const settingsGroups: ReadonlyArray<ReadonlyArray<SettingsPage>> = [
  ["you", "notifications", "appearance"],
  ["providers", "usage", "connectors", "secrets"],
  ["devices", "where", "updates"],
];

/**
 * Whether the providers page waits on the operator: the engine cannot run, or
 * it runs and no provider can run a bot. An engine on its way up, and a
 * provider still being checked, wait on nothing the operator can do; nor does
 * one provider left out while another runs the bots.
 */
export const providersNeedYou = (engine: EngineStatus | null): boolean => {
  if (engine === null) return false;
  switch (engine.state._tag) {
    case "starting":
      return false;
    case "unavailable":
    case "incompatible":
      return true;
    case "ready": {
      const gate = providerGate(engine)._tag;
      return gate === "connect" || gate === "unavailable";
    }
  }
};
