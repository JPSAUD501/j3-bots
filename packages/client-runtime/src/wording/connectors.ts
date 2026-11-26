// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Bot,
  Connector,
  ConnectorGrant,
  ConnectorPublisher,
  ConnectorStatus,
  PinRefusal,
} from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import { type IntentFailure, refusedWith } from "../intents/Actions.ts";
import type { EnvProblem } from "../presentation/connectorForm.ts";
import type { SignInProblem } from "../presentation/connectors.ts";
import { type TimeContext, timeInSentence } from "./time.ts";

/** Who offers a connector, as its page says under its name. */
export function publisherText(publisher: ConnectorPublisher, { t }: I18n): string {
  switch (publisher._tag) {
    case "domain":
      return t("connector.from", { domain: publisher.domain });
    case "community":
      return t("connector.community", { namespace: publisher.namespace });
    case "operator":
      return t("connector.addedByYou");
  }
}

/** Which bots may use a connector, in a few words: "All bots", "Scout", "3 bots". */
export function grantText(grant: ConnectorGrant, bots: ReadonlyArray<Bot>, i18n: I18n): string {
  if (grant._tag === "all-bots") return i18n.t("connectors.bots.all");
  const named = bots.filter((bot) => grant.ids.includes(bot.id));
  const [only] = named;
  if (only === undefined) return i18n.t("connectors.bots.none");
  if (named.length === 1) return only.profile.name;
  return i18n.plural("connectors.bots.count", named.length);
}

/** What a connector's status says, each part a sentence or none. */
export interface ConnectorStatusText {
  /** A word or two for its light. */
  readonly label: string;
  /** Why bots cannot use it, for any state but `connected`. */
  readonly detail: string | null;
  /** What the operator can do about it, where the detail does not say. */
  readonly next: string | null;
  /** When that started. */
  readonly since: string | null;
}

/**
 * What a connector's status says: a word for its light, and a sentence on why
 * bots cannot use it, with what to do about it and when that started, for
 * any state but `connected`.
 */
export function connectorStatusText(
  status: ConnectorStatus,
  ctx: TimeContext,
): ConnectorStatusText {
  const { t } = ctx.i18n;
  switch (status._tag) {
    case "connected":
      return { label: t("connector.status.connected"), detail: null, next: null, since: null };
    case "secrets-unavailable":
      return {
        label: t("connector.status.secretsUnavailable"),
        detail: t("connector.status.secretsUnavailableDetail"),
        next: null,
        since: null,
      };
    case "needs-sign-in":
      return {
        label: t("connector.status.needsSignIn"),
        detail: t(
          status.reason === "not-signed-in"
            ? "connector.status.notSignedIn"
            : status.reason === "expired"
              ? "connector.status.expired"
              : status.reason === "rejected"
                ? "connector.status.rejected"
                : "connector.status.signInOther",
        ),
        next: null,
        since: null,
      };
    case "failing": {
      const failing = {
        unreachable: { detail: "connector.status.unreachable", next: null },
        "timed-out": { detail: "connector.status.timedOut", next: null },
        "server-error": { detail: "connector.status.serverError", next: null },
        "not-mcp": { detail: "connector.status.notMcp", next: null },
        "refused-address": { detail: "connector.status.refusedAddress", next: null },
        "command-not-found": {
          detail: "connector.status.commandNotFound",
          next: "connector.status.commandNotFound.next",
        },
        "command-exited": {
          detail: "connector.status.commandExited",
          next: "connector.status.commandExited.next",
        },
        unknown: { detail: "connector.status.failingOther", next: null },
      } as const;
      const { detail, next } = failing[status.reason];
      const command = status.reason === "command-not-found" || status.reason === "command-exited";
      return {
        label: t(command ? "connector.status.notRunning" : "connector.status.failing"),
        detail: t(detail),
        next: next === null ? null : t(next),
        since: t("connector.status.since", { when: timeInSentence(status.since, ctx) }),
      };
    }
  }
}

/** When the operator last signed the connector in, or gave its key: "Signed in yesterday at 4:12 PM". */
export function signedInText(connector: Connector, ctx: TimeContext): string | null {
  return connector.signedInAt === null
    ? null
    : ctx.i18n.t("connector.signedInOn", { when: timeInSentence(connector.signedInAt, ctx) });
}

/** Why adding a connector did not work, in words. */
export function connectFailureText(failure: IntentFailure, { t }: I18n): string {
  if (refusedWith(failure, "connector-fields")) return t("connect.failed.fields");
  if (refusedWith(failure, "command-unpinned")) return t("connect.failed.unpinned");
  if (refusedWith(failure, "connector-unsupported")) return t("connector.unsupported");
  if (refusedWith(failure, "secrets-unavailable")) return t("connect.failed.secretsUnavailable");
  return t("connect.failed");
}

/** Why a sign-in did not finish, in words. */
export function signInProblemText(problem: SignInProblem, { t }: I18n): string {
  switch (problem) {
    case "start-failed":
      return t("signIn.failed.start");
    case "no-relay":
      return t("signIn.failed.noRelay");
    case "unsupported":
      return t("signIn.failed.unsupported");
    case "registration-refused":
      return t("signIn.failed.registration");
    case "unreachable":
      return t("signIn.failed.unreachable");
    case "refused":
      return t("signIn.failed.refused");
    case "expired":
      return t("signIn.failed.expired");
    case "secrets-unavailable":
      return t("signIn.failed.secretsUnavailable");
    case "not-paired":
      return t("signIn.failed.notPaired");
  }
}

/** What the connector's page says once it is added: who can use it from their next turn. */
export function connectedText(grant: ConnectorGrant, bots: ReadonlyArray<Bot>, i18n: I18n): string {
  if (grant._tag === "all-bots") return i18n.t("connect.done.all");
  const named = bots.filter((bot) => grant.ids.includes(bot.id));
  const [only] = named;
  if (only === undefined) return i18n.t("connect.done.none");
  return named.length === 1
    ? i18n.t("connect.done.one", { name: only.profile.name })
    : i18n.t("connect.done.many");
}

/** Why a command's package would be refused, as its form says before it is sent. */
export function pinRefusalText(refusal: PinRefusal, { t }: I18n): string {
  switch (refusal) {
    case "floating":
      return t("addOwn.pin.floating");
    case "unclear":
      return t("addOwn.pin.unclear");
    case "shell":
      return t("addOwn.pin.shell");
  }
}

/** Why one of a command's variables would be refused, under its row. */
export function envProblemText(problem: EnvProblem, { t }: I18n): string {
  switch (problem.reason) {
    case "invalid":
      return t("addOwn.env.invalid");
    case "reserved":
      return t("addOwn.env.reserved");
    case "twice":
      return t("addOwn.env.twice");
    case "value-again":
      return t("addOwn.env.valueAgain");
  }
}
