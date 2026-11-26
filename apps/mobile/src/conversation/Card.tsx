// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CardEntry as TimelineCard } from "@j3-bots/client-runtime/presentation";
import type { BrowserHelpEntry, NoticeEntry } from "@j3-bots/contracts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { BrowserHelpCard } from "./BrowserHelpCard.tsx";
import { ConnectorAuthCard, ConnectorInputCard } from "./ConnectorCards.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { SecretAskCard } from "./SecretAskCard.tsx";
import { SecretRequestCard } from "./SecretRequestCard.tsx";

/** The entries that are cards: what the bot asks of the operator. Notices have a line of their own. */
export type CardEntry = Exclude<TimelineCard, NoticeEntry>;

/** One card of the conversation. Each answers through the runtime itself. */
export function Card({
  entry,
  onOpenBrowser,
}: {
  readonly entry: CardEntry;
  /** Opens the bot's browser for a browser help card. */
  readonly onOpenBrowser: (card: BrowserHelpEntry) => void;
}) {
  switch (entry._tag) {
    case "question":
      return <QuestionCard entry={entry} />;
    case "approval":
      return <ApprovalCard entry={entry} />;
    case "secret-request":
      return <SecretRequestCard entry={entry} />;
    case "browser-help":
      return <BrowserHelpCard entry={entry} onOpen={() => onOpenBrowser(entry)} />;
    case "secret-ask":
      return <SecretAskCard entry={entry} />;
    case "connector-auth":
      return <ConnectorAuthCard entry={entry} />;
    case "connector-input":
      return <ConnectorInputCard entry={entry} />;
  }
}
