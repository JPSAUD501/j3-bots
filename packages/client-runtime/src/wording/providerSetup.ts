// SPDX-License-Identifier: AGPL-3.0-or-later
import { type SignInFailure, type SignInHarness, signInHarnesses } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import type { SignInView } from "../stores/ProviderSetup.ts";

/**
 * Where a harness's sign-in stands, in words, or null when there is nothing
 * to say: none ran, or it was cancelled. `tone`: `waiting` while it runs,
 * `ready` once signed in, `blocked` when it ended without.
 */
export interface SignInLine {
  readonly text: string;
  readonly tone: "waiting" | "ready" | "blocked";
}

export function signInLine(
  harness: SignInHarness,
  view: SignInView,
  i18n: I18n,
): SignInLine | null {
  const { t } = i18n;
  const name = signInHarnesses[harness].name;
  switch (view._tag) {
    case "idle":
    case "cancelled":
      return null;
    case "starting":
      return { text: t("providers.signIn.starting", { harness: name }), tone: "waiting" };
    case "waiting-for-browser":
      return { text: t("providers.signIn.waiting", { harness: name }), tone: "waiting" };
    case "succeeded":
      return view.endpoint === null
        ? { text: t("providers.signIn.succeeded", { harness: name }), tone: "ready" }
        : {
            text: t("providers.signIn.succeededEndpoint", {
              harness: name,
              endpoint: view.endpoint,
            }),
            tone: "ready",
          };
    case "unsupported":
      return { text: t("providers.signIn.unsupported"), tone: "blocked" };
    case "failed":
      return { text: signInFailureText(harness, view.reason, i18n), tone: "blocked" };
  }
}

/** Why a sign-in ended without signing in, in words; a reason this client does not know reads as a plain failure. */
function signInFailureText(
  harness: SignInHarness,
  reason: SignInFailure | "unknown",
  { t }: I18n,
): string {
  const name = signInHarnesses[harness].name;
  switch (reason) {
    case "not-installed":
      return t("providers.signIn.failed.notInstalled", { harness: name });
    case "needs-terminal":
      return t("providers.signIn.failed.needsTerminal", { harness: name });
    case "ended":
      return t("providers.signIn.failed.ended", { harness: name });
    case "no-credential":
      return t("providers.signIn.failed.noCredential", { harness: name });
    case "linked-home":
      return t("providers.signIn.failed.linkedHome", { harness: name });
    case "home-refused":
      return t("providers.signIn.failed.homeRefused", { harness: name });
    case "timed-out":
      return t("providers.signIn.failed.timedOut");
    case "unexpected":
    case "unknown":
      return t("providers.signIn.failed.other", { harness: name });
  }
}

/**
 * Whether the way forward from a sign-in that ended is an endpoint rather
 * than signing in again: the harness cannot sign in without a terminal here,
 * or keeps its sign-in where J3 Bots cannot use it.
 */
export const endpointInstead = (view: SignInView): boolean =>
  view._tag === "failed" && (view.reason === "needs-terminal" || view.reason === "no-credential");
