// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EngineStatus } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import { hasDefaultModel, providerGate } from "../presentation/engine.ts";
import { providerLoginGuide } from "../presentation/onboarding.ts";
import { engineDownload, engineProblem } from "./engine.ts";

/**
 * The first run's connect step, in words, for the bot named `name`:
 * - `title` and `body` say what is missing and what to do;
 * - `command`, when one command fixes it, to run on the server;
 * - `status`, live: what the server is doing about it now;
 * - `login`, beside the command: where the install guide says how to sign a
 *   harness in with the operator's own account instead;
 * - `later`, while the bot can be created anyway and speak once a provider
 *   can run it, says so; null while the server has no model to give it
 *   (`hasDefaultModel`), which would refuse it;
 * - `createWaits`, while the engine is ready and the server has no model to
 *   give the bot, so creating it would only be refused: why the step's
 *   Create waits. Null while Create can be pressed.
 */
export interface ConnectStepText {
  readonly title: string;
  readonly body: string;
  readonly command: string | null;
  readonly login: {
    readonly text: string;
    readonly link: string;
    readonly url: string;
  } | null;
  readonly status: { readonly text: string; readonly tone: "waiting" | "ready" | "muted" };
  readonly later: string | null;
  readonly createWaits: string | null;
}

export function connectStepText(
  engine: EngineStatus | null,
  name: string,
  i18n: I18n,
): ConnectStepText {
  const waits = engine !== null && engine.state._tag === "ready" && !hasDefaultModel(engine);
  return {
    ...stepText(engine, name, i18n),
    createWaits: waits ? i18n.t("onboarding.connect.createWaits", { name }) : null,
  };
}

function stepText(
  engine: EngineStatus | null,
  name: string,
  i18n: I18n,
): Omit<ConnectStepText, "createWaits"> {
  const { t } = i18n;
  const later = hasDefaultModel(engine) ? t("onboarding.connect.later", { name }) : null;
  if (engine === null) {
    return {
      title: t("firstRun.connecting.title"),
      body: t("firstRun.connecting.body"),
      command: null,
      login: null,
      status: { text: t("onboarding.connect.status.connecting"), tone: "waiting" },
      later,
    };
  }
  if (engine.state._tag === "starting") {
    // While it downloads, the live line says how far, under the same title.
    const download = engineDownload(engine, i18n);
    return {
      title: t("engine.starting.title"),
      body: download === null ? t("engine.starting.body") : t("engine.downloading.body"),
      command: null,
      login: null,
      status: { text: download ?? t("onboarding.connect.status.starting"), tone: "waiting" },
      later,
    };
  }
  const problem = engineProblem(engine, i18n);
  if (problem !== null) {
    return {
      ...problem,
      command: null,
      login: null,
      status: { text: t("onboarding.connect.status.engineOut"), tone: "muted" },
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
        login: null,
        status: { text: t("onboarding.connect.status.ready"), tone: "ready" },
        later: null,
      };
    case "checking":
      return {
        title: t("onboarding.connect.checking.title", { name }),
        body: t("onboarding.connect.checking.body"),
        command: null,
        login: null,
        status: { text: t("onboarding.connect.status.checking"), tone: "waiting" },
        later,
      };
    case "connect":
      return {
        title: t("onboarding.connect.title", { name }),
        body: t("onboarding.connect.body"),
        command: gate.command,
        login: {
          text: t("onboarding.connect.login"),
          link: t("onboarding.connect.loginLink"),
          url: providerLoginGuide,
        },
        status: { text: t("onboarding.connect.status.waiting"), tone: "waiting" },
        later,
      };
    case "unavailable":
      return {
        title: t("onboarding.connect.unavailable.title", { name }),
        body: t("onboarding.connect.unavailable.body"),
        command: null,
        login: null,
        status: { text: t("onboarding.connect.status.unavailable"), tone: "muted" },
        later,
      };
  }
}
