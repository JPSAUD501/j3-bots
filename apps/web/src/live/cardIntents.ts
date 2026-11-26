// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ActionState,
  cardAction,
  type J3Client,
  refusedWith,
  retryAction,
} from "@j3-bots/client-runtime";
import { ownAppSetup } from "@j3-bots/client-runtime/presentation";
import { useActions } from "@j3-bots/client-runtime/react";
import type { EntryId } from "@j3-bots/contracts";
import { useMemo } from "react";
import { useI18n } from "../app/context";
import type { ConnectorAppAccess } from "../components/ConnectorAppCard";
import type { TimelineIntents } from "../components/Timeline";

/**
 * What a timeline's cards and messages ask of the server, the same wherever
 * the conversation shows: an answer to a question or an approval, a secret,
 * a message sent again or taken out, a connector's request. What opens
 * another screen is left to whoever shows the timeline.
 */
export type CardIntents = Pick<
  TimelineIntents,
  | "connectorApp"
  | "answerQuestion"
  | "dismissQuestion"
  | "decideApproval"
  | "provideSecret"
  | "declineSecret"
  | "answerBrowserHelp"
  | "declineSecretAsk"
  | "retryNotice"
  | "retryMessage"
  | "resendMessage"
  | "discardMessage"
  | "answerConnectorInput"
  | "openConnectorPage"
  | "connectorAskSetup"
  | "allowConnectorAsk"
  | "declineConnectorAsk"
>;

const submitting = (state: ActionState | undefined) => state?._tag === "submitting";

/** Whether the operator's answer to a card, or their retry of an entry, is still on its way to the server. */
export function useCardSubmitting(): (entryId: EntryId) => boolean {
  const actions = useActions();
  return (entryId) =>
    submitting(actions.get(cardAction(entryId))) || submitting(actions.get(retryAction(entryId)));
}

/**
 * The cards' intents on `j3`, which talks to the server at `origin`; `say`
 * tells the operator what the server refused. `serverSignIn`: a connector's
 * sign-in comes back to the server itself, which an own app's setup then names.
 */
export function useCardIntents(
  j3: J3Client,
  say: (text: string) => void,
  origin: URL,
  serverSignIn: boolean,
): CardIntents {
  const { t, locale } = useI18n();
  // One for as long as the client is: an app's frame is drawn again only when its view changes.
  const connectorApp = useMemo<ConnectorAppAccess>(() => {
    const value = <A>(
      result: { readonly _tag: "done"; readonly value: A } | { readonly _tag: "failed" },
    ) => (result._tag === "done" ? result.value : null);
    return {
      server: origin,
      open: (viewId) => j3.connectors.app.open(viewId).then(value),
      callTool: (viewId, name, args, allowed) =>
        j3.connectors.app.callTool(viewId, name, args, allowed).then(value),
      readResource: (viewId, uri) => j3.connectors.app.readResource(viewId, uri).then(value),
      sendMessage: (botId, text) =>
        j3
          .send({ target: { _tag: "conversation", botId }, text })
          .then((result) => result._tag === "done"),
      openLink: (url) => {
        window.open(url.href, "_blank", "noopener,noreferrer");
      },
    };
  }, [j3, origin]);
  return {
    connectorApp,
    // An answer too long to reach the bot leaves the card open, with what was typed, to shorten.
    answerQuestion: (entryId, answers) =>
      void j3.answerCard(entryId, { _tag: "question", answers }).then((result) => {
        if (refusedWith(result, "answer-length")) say(t("question.tooLong"));
      }),
    dismissQuestion: (entryId) => void j3.answerCard(entryId, { _tag: "dismiss" }),
    decideApproval: (entryId, decision) =>
      void j3.answerCard(entryId, { _tag: "approval", decision }),
    provideSecret: (entryId, value) => void j3.provideSecret(entryId, { _tag: "provide", value }),
    declineSecret: (entryId) => void j3.provideSecret(entryId, { _tag: "decline" }),
    answerBrowserHelp: (entryId, outcome) =>
      void j3.answerCard(entryId, { _tag: "browser-help", outcome }),
    declineSecretAsk: (entryId) => void j3.answerCard(entryId, { _tag: "dismiss" }),
    retryNotice: (entryId) => void j3.retryNotice(entryId),
    retryMessage: (entryId) => void j3.retryMessage(entryId),
    resendMessage: (commandId, mentions) =>
      void j3.resend(commandId, mentions).then((result) => {
        if (result._tag === "not-kept") say(t("message.changeNotKept"));
      }),
    discardMessage: (commandId) =>
      void j3.discard(commandId).then((discarded) => {
        if (!discarded) say(t("message.changeNotKept"));
      }),
    answerConnectorInput: (entryId, answer) =>
      void j3.answerCard(entryId, { _tag: "connector-input", answer }).then((result) => {
        if (refusedWith(result, "connector-input")) say(t("connectorInput.refused"));
      }),
    openConnectorPage: (url) => {
      window.open(url, "_blank", "noopener");
    },
    connectorAskSetup: (listing) =>
      j3.connectors
        .listing(listing, locale)
        .then((result) =>
          result._tag === "done"
            ? { _tag: "done", value: ownAppSetup(result.value, serverSignIn) }
            : result,
        ),
    allowConnectorAsk: (entryId, client) =>
      void j3.answerCard(entryId, { _tag: "connector-ask", client }).then((result) => {
        if (refusedWith(result, "answer")) say(t("connectorAsk.refused"));
      }),
    declineConnectorAsk: (entryId) => void j3.answerCard(entryId, { _tag: "dismiss" }),
  };
}
