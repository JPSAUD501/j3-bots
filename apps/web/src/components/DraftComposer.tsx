// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Addressing } from "@j3-bots/client-runtime";
import { targetKey } from "@j3-bots/client-runtime";
import type { BotId, EntryTarget, SuggestedReply } from "@j3-bots/contracts";
import type { RefObject } from "react";
import type { ShellData, ShellIntents } from "../shell/data";
import { Composer, type MentionChoices } from "./Composer";
import type { PromptMenu } from "./PromptPicker";

interface DraftComposerProps {
  /** The conversation or room the draft is written to. */
  readonly target: EntryTarget;
  /** Who the message goes to: a bot's or a room's name. */
  readonly recipient: string;
  readonly data: Pick<
    ShellData,
    "draft" | "offer" | "draftsLoading" | "draftsFailed" | "draftNotSaved" | "connectors"
  >;
  readonly intents: Pick<
    ShellIntents,
    | "setDraftText"
    | "attachFiles"
    | "detachFile"
    | "unquoteInDraft"
    | "openAttachment"
    | "sendDraft"
    | "retryDrafts"
    | "restoreDraft"
    | "dismissDraftOffer"
    | "connectorPrompts"
    | "renderPrompt"
    | "dictation"
  >;
  /** Whom the message is for as the draft stands (`addressingOf`). */
  readonly addressing?: Addressing | undefined;
  /** What `@` offers (`mentionChoicesOf`); nothing when left out. */
  readonly mentionable?: MentionChoices | undefined;
  /** In a bot's conversation, the reply the AI guesses comes next, while it is on offer. */
  readonly suggestion?: SuggestedReply | null;
  readonly inputRef?: RefObject<HTMLDivElement | null>;
}

/**
 * The composer on the draft of one conversation or room: what the operator
 * wrote there and has not sent, kept on the device, the same wherever that
 * conversation shows. In a bot's conversation, `/` offers its connectors'
 * prompts, each by its connector's name.
 */
export function DraftComposer({
  target,
  recipient,
  data,
  intents,
  addressing,
  mentionable,
  suggestion = null,
  inputRef,
}: DraftComposerProps) {
  const draft = data.draft(target);
  const offer = data.offer(target);
  const promptMenu = (botId: BotId): PromptMenu => ({
    load: () =>
      intents.connectorPrompts(botId).then(
        (prompts) =>
          prompts?.flatMap((prompt) => {
            const connector = data.connectors?.find((one) => one.id === prompt.connectorId);
            return connector === undefined ? [] : [{ ...prompt, connector: connector.name }];
          }) ?? null,
      ),
    render: (prompt, given) => intents.renderPrompt(botId, prompt, given),
  });
  return (
    <Composer
      draftKey={targetKey(target)}
      recipient={recipient}
      value={draft.text}
      mentions={draft.mentions}
      onValueChange={(value, picked, order) => intents.setDraftText(target, value, picked, order)}
      files={draft.files}
      quotes={draft.quotes}
      onUnquote={(index) => intents.unquoteInDraft(target, index)}
      sending={draft.sending}
      loading={data.draftsLoading}
      {...(data.draftsFailed ? { unread: { onRetry: intents.retryDrafts } } : {})}
      notSaved={data.draftNotSaved(target)}
      onAttachFiles={(files, at) => intents.attachFiles(target, files, at)}
      onDetachFile={(fileKey) => intents.detachFile(target, fileKey)}
      onOpenFile={intents.openAttachment}
      onSend={() => intents.sendDraft(target, addressing)}
      dictation={intents.dictation}
      {...(offer === null
        ? {}
        : {
            replaced: {
              revision: offer,
              onRestore: () => intents.restoreDraft(target),
              onDismiss: () => intents.dismissDraftOffer(target),
            },
          })}
      {...(inputRef === undefined ? {} : { inputRef })}
      {...(mentionable === undefined ? {} : { mentionable })}
      {...(target._tag === "conversation" ? { prompts: promptMenu(target.botId), suggestion } : {})}
    />
  );
}
