// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  BotId,
  BrowserHelpEntry,
  Entry,
  MessageEntry,
  NoticeEntry,
  RoutineId,
  WorkFoldEntry,
} from "@j3-bots/contracts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { BrowserHelpCard } from "./BrowserHelpCard.tsx";
import { HandoffCard } from "./HandoffCard.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { RoutineChangeCard } from "./RoutineChangeCard.tsx";
import { SecretRequestCard } from "./SecretRequestCard.tsx";

/** The entries that are cards: what the bot asks, a teammate message, a routine changed. */
export type CardEntry = Exclude<Entry, MessageEntry | NoticeEntry | WorkFoldEntry>;

/** One card of the conversation. Each answers through the runtime itself. */
export function Card({
  entry,
  onOpenBot,
  onOpenRoutine,
  onOpenBrowser,
}: {
  readonly entry: CardEntry;
  /** Opens a bot's own conversation, as a teammate message offers. */
  readonly onOpenBot: (botId: BotId) => void;
  /** Opens a routine's runs, over its bot's details. */
  readonly onOpenRoutine: (routineId: RoutineId) => void;
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
    case "handoff":
      return <HandoffCard entry={entry} onOpenBot={onOpenBot} />;
    case "routine-change":
      return <RoutineChangeCard entry={entry} onOpen={() => onOpenRoutine(entry.routineId)} />;
  }
}
