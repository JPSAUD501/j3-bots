// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SuggestedReply } from "@j3-bots/contracts";
import { FILE_MARK } from "../files/placed.ts";
import type { ConversationItem } from "../stores/Conversations.ts";

/**
 * The reply the composer offers in a bot's conversation, or null. The server
 * offers it while the message it follows is the newest one there
 * (`docs/architecture/clients.md`, Suggested replies); the conversation this
 * client shows may already be ahead of the bot's state, with a message the
 * operator just sent or one that just arrived, and then nothing is offered.
 * The finished work fold of the turn that answered can sit after its message
 * and is passed over; the fold of a turn still running is something newer. A guess holding the mark that places a draft's file is never
 * offered: taken into the draft, it would stand for a file that is not there.
 */
export function offeredReply(
  suggestion: SuggestedReply | null,
  items: ReadonlyArray<ConversationItem>,
): SuggestedReply | null {
  if (suggestion === null || suggestion.text.includes(FILE_MARK)) return null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) continue;
    if (item._tag === "work-fold" && item.status._tag === "finished") continue;
    return item._tag !== "outgoing" && item.id === suggestion.after ? suggestion : null;
  }
  return null;
}
