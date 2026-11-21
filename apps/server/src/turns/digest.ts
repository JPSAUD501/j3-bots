// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entry } from "@j3-bots/contracts";
import type { DigestMessage } from "@j3-bots/prompts";

/**
 * How much of the conversation a digest holds: the messages, the characters
 * in all, and the characters of any one message. Provisional, until real
 * conversations tune them (`docs/open-questions.md`, 6).
 */
const DIGEST_MESSAGES = 60;
const DIGEST_CHARACTERS = 6_000;
const MESSAGE_CHARACTERS = 1_000;

const shortened = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/** What a digest says, and whether older entries could still add to it. */
export interface Digest {
  readonly messages: ReadonlyArray<DigestMessage>;
  /** It holds as many messages or characters as a digest takes. */
  readonly full: boolean;
}

/**
 * What a bot's new main session is told of its conversation
 * (`docs/architecture/server.md`, Rotation): the latest messages that reached
 * the bot or came from it, oldest first, each with its author and the names
 * of the files it carried, newest kept when they do not all fit. Each is its
 * own message, so the envelope gives each its own block and no text can pass
 * for another author's. A message still on its way, or that never arrived, is
 * left out: the bot was never told it, and one on its way reaches it in its
 * own envelope. The limits count those messages, never the other entries
 * between them. `entries` are the conversation's latest, oldest first.
 */
export const conversationDigest = (entries: ReadonlyArray<Entry>): Digest => {
  const messages: Array<DigestMessage> = [];
  let length = 0;
  let full = false;
  for (const entry of entries.toReversed()) {
    if (entry._tag !== "message" || entry.delivery._tag !== "delivered") continue;
    if (entry.author._tag === "system") continue;
    const message: DigestMessage = {
      from: entry.author._tag === "operator" ? "user" : "you",
      text: shortened(entry.text, MESSAGE_CHARACTERS),
      files: entry.attachments.map((file) => file.name),
    };
    const size = message.text.length + message.files.reduce((sum, name) => sum + name.length, 0);
    if (length + size > DIGEST_CHARACTERS) {
      full = true;
      break;
    }
    messages.push(message);
    length += size;
    if (messages.length === DIGEST_MESSAGES) {
      full = true;
      break;
    }
  }
  return { messages: messages.toReversed(), full };
};
