// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entry } from "@j3-bots/contracts";

/**
 * How much of the conversation a digest holds: the messages, the characters
 * in all, and the characters of any one message. Provisional, until real
 * conversations tune them (`docs/open-questions.md`, 8).
 */
const DIGEST_MESSAGES = 60;
const DIGEST_CHARACTERS = 6_000;
const MESSAGE_CHARACTERS = 1_000;

const shortened = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/** What a digest says, and whether older entries could still add to it. */
export interface Digest {
  readonly text: string;
  /** It holds as many messages or characters as a digest takes. */
  readonly full: boolean;
}

/**
 * What a bot's new main session is told of its conversation
 * (`docs/architecture/server.md`, Rotation): the latest messages that reached
 * the bot or came from it, oldest first, each as `<speaker>: <text>` with the
 * names of the files it carried, newest kept when they do not all fit. A
 * message still on its way, or that never arrived, is left out: the bot was
 * never told it, and one on its way reaches it in its own envelope. The limits
 * count those messages, never the other entries between them. `entries` are
 * the conversation's latest, oldest first.
 */
export const conversationDigest = (entries: ReadonlyArray<Entry>, operatorName: string): Digest => {
  const lines: Array<string> = [];
  let length = 0;
  let full = false;
  for (const entry of entries.toReversed()) {
    if (entry._tag !== "message" || entry.delivery._tag !== "delivered") continue;
    if (entry.author._tag === "system") continue;
    const speaker = entry.author._tag === "operator" ? operatorName : "You";
    const files =
      entry.attachments.length === 0
        ? ""
        : ` [files: ${entry.attachments.map((file) => file.name).join(", ")}]`;
    const line = `${speaker}: ${shortened(entry.text, MESSAGE_CHARACTERS)}${files}`;
    if (length + line.length > DIGEST_CHARACTERS) {
      full = true;
      break;
    }
    lines.push(line);
    length += line.length + 1;
    if (lines.length === DIGEST_MESSAGES) {
      full = true;
      break;
    }
  }
  return {
    text:
      lines.length === 0
        ? "Nothing has been said in the conversation yet."
        : lines.toReversed().join("\n"),
    full,
  };
};
