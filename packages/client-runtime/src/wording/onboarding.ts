// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import { providerGate } from "../presentation/engine.ts";
import { engineProblem } from "./engine.ts";

/**
 * The first run's connect step, in words, for the bot named `name`:
 * - `title` and `body` say what is missing and what to do;
 * - `command`, when one command fixes it, to run on the server;
 * - `status`, live: what the server is doing about it now;
 * - `later`, while the bot can be created anyway and speak once a provider
 *   can run it, says so.
 */
export interface ConnectStepText {
  readonly title: string;
  readonly body: string;
  readonly command: string | null;
  readonly status: { readonly text: string; readonly tone: "waiting" | "ready" | "muted" };
  readonly later: string | null;
}

export function connectStepText(
  engine: EngineStatus | null,
  name: string,
  i18n: I18n,
): ConnectStepText {
  const { t } = i18n;
  const later = t("onboarding.connect.later", { name });
  if (engine === null) {
    return {
      title: t("firstRun.connecting.title"),
      body: t("firstRun.connecting.body"),
      command: null,
      status: { text: t("onboarding.connect.status.connecting"), tone: "waiting" },
      later,
    };
  }
  const problem = engineProblem(engine, i18n);
  if (problem !== null) {
    return {
      ...problem,
      command: null,
      status: {
        text:
          engine.state._tag === "starting"
            ? t("onboarding.connect.status.starting")
            : t("onboarding.connect.status.engineOut"),
        tone: engine.state._tag === "starting" ? "waiting" : "muted",
      },
      later,
    };
  }
  const gate = providerGate(engine);
  switch (gate._tag) {
    case "ready":
      return {
        title: t("onboarding.connect.ready.title"),
        body: t("onboarding.connect.ready.body", { name }),
        command: null,
        status: { text: t("onboarding.connect.status.ready"), tone: "ready" },
        later: null,
      };
    case "checking":
      return {
        title: t("onboarding.connect.checking.title", { name }),
        body: t("onboarding.connect.checking.body"),
        command: null,
        status: { text: t("onboarding.connect.status.checking"), tone: "waiting" },
        later,
      };
    case "connect":
      return {
        title: t("onboarding.connect.title", { name }),
        body: t("onboarding.connect.body"),
        command: gate.command,
        status: { text: t("onboarding.connect.status.waiting"), tone: "waiting" },
        later,
      };
    case "unavailable":
      return {
        title: t("onboarding.connect.unavailable.title", { name }),
        body: t("onboarding.connect.unavailable.body"),
        command: null,
        status: { text: t("onboarding.connect.status.unavailable"), tone: "muted" },
        later,
      };
  }
}
