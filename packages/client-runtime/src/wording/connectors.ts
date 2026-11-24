// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Bot,
  Connector,
  ConnectorGrant,
  ConnectorPublisher,
  ConnectorStatus,
} from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import { type IntentFailure, refusedWith } from "../intents/Actions.ts";
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

/**
 * What a connector's status says: a word for its light, and a sentence on why
 * bots cannot use it, with when that started, for any state but `connected`.
 */
export function connectorStatusText(
  status: ConnectorStatus,
  ctx: TimeContext,
): { readonly label: string; readonly detail: string | null; readonly since: string | null } {
  const { t } = ctx.i18n;
  switch (status._tag) {
    case "connected":
      return { label: t("connector.status.connected"), detail: null, since: null };
    case "vault-locked":
      return {
        label: t("connector.status.vaultLocked"),
        detail: t("connector.status.vaultLockedDetail"),
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
        since: null,
      };
    case "failing": {
      const detail = {
        unreachable: "connector.status.unreachable",
        "timed-out": "connector.status.timedOut",
        "server-error": "connector.status.serverError",
        "not-mcp": "connector.status.notMcp",
        "refused-address": "connector.status.refusedAddress",
        unknown: "connector.status.failingOther",
      } as const;
      return {
        label: t("connector.status.failing"),
        detail: t(detail[status.reason]),
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
  if (refusedWith(failure, "connector-unsupported")) return t("connector.unsupported");
  if (refusedWith(failure, "vault-locked")) return t("connect.failed.vaultLocked");
  if (refusedWith(failure, "vault-not-set-up")) return t("connect.failed.vaultNotSetUp");
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
    case "vault-locked":
      return t("signIn.failed.vaultLocked");
    case "vault-not-set-up":
      return t("signIn.failed.vaultNotSetUp");
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
