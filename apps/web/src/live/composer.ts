// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Addressing,
  type Draft,
  type DraftSendResult,
  type J3Client,
  targetKey,
  type WindowContext,
} from "@j3-bots/client-runtime";
import type { EntryTarget } from "@j3-bots/contracts";
import { useReadable } from "@j3-bots/client-runtime/react";
import { useI18n } from "../app/context";
import type { ShellData, ShellIntents } from "../shell/data";

const blankDraft: Draft = { text: "", mentions: [], files: [], sending: false };

/** What a conversation's composer shows and asks for, the same wherever the conversation shows. */
export interface ComposerSource {
  readonly data: Pick<
    ShellData,
    "draft" | "offer" | "draftsLoading" | "draftsFailed" | "draftNotSaved"
  >;
  readonly intents: Pick<
    ShellIntents,
    | "setDraftText"
    | "attachFiles"
    | "detachFile"
    | "sendDraft"
    | "retryDrafts"
    | "restoreDraft"
    | "dismissDraftOffer"
    | "connectorPrompts"
    | "renderPrompt"
  >;
  /**
   * Sends the draft of `target`, with `context` when the window the
   * operator was looking at goes with it; telling the operator when it
   * could not go.
   */
  readonly send: (
    target: EntryTarget,
    addressing: Addressing | undefined,
    context?: WindowContext,
  ) => Promise<DraftSendResult>;
}

/**
 * The drafts `j3` keeps on this device, and what the composer does with
 * them; `say` tells the operator when a message could not be kept.
 */
export function useComposerSource(j3: J3Client, say: (text: string) => void): ComposerSource {
  const { t } = useI18n();
  const drafts = useReadable(j3.drafts);
  const offers = useReadable(j3.draftOffers);
  const draftsLoading = useReadable(j3.draftsSwitching);
  const draftsFailed = useReadable(j3.draftsReadFailed);
  const notSaved = useReadable(j3.draftsNotSaved);
  const send: ComposerSource["send"] = (target, addressing, context) =>
    j3.sendDraft(target, addressing, context).then((result) => {
      if (result === "not-kept") say(t("composer.notKept"));
      if (result === "picture-failed") say(t("quickAccess.picture.notSent"));
      return result;
    });
  return {
    data: {
      draft: (asked) => drafts.get(targetKey(asked)) ?? blankDraft,
      offer: (asked) => offers.get(targetKey(asked)) ?? null,
      draftsLoading,
      draftsFailed,
      draftNotSaved: (asked) => notSaved.has(targetKey(asked)),
    },
    intents: {
      setDraftText: j3.setDraftText,
      attachFiles: (asked, picked, at) =>
        j3.attachFiles(
          asked,
          picked.map((file) => ({ name: file.name, body: file })),
          at,
        ),
      detachFile: j3.detachFile,
      restoreDraft: j3.restoreDraft,
      retryDrafts: j3.retryDrafts,
      dismissDraftOffer: j3.dismissDraftOffer,
      sendDraft: (asked, addressing) => void send(asked, addressing),
      connectorPrompts: (botId) =>
        j3.connectors
          .prompts(botId)
          .then((result) => (result._tag === "done" ? result.value : null)),
      renderPrompt: (botId, prompt, given) =>
        j3.connectors
          .renderPrompt({
            botId,
            connectorId: prompt.connectorId,
            name: prompt.name,
            arguments: given,
          })
          .then((result) => (result._tag === "done" ? result.value : null)),
    },
    send,
  };
}
