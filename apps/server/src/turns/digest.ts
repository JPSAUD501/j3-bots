// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Entry } from "@j3-bots/contracts";

/**
 * How much of the conversation a digest covers: the entries it looks at, the
 * characters it holds in all, and the characters of any one message.
 * Provisional, until real conversations tune them (`docs/open-questions.md`, 8).
 */
export const DIGEST_ENTRIES = 60;
const DIGEST_CHARACTERS = 6_000;
const MESSAGE_CHARACTERS = 1_000;

const shortened = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/**
 * What a bot's new main session is told of its conversation
 * (`docs/architecture/server.md`, Rotation): the latest messages that reached
 * the bot or came from it, oldest first, each as `<speaker>: <text>` with the
 * names of the files it carried, newest kept when they do not all fit. A
 * message still on its way, or that never arrived, is left out: the bot was
 * never told it, and one on its way reaches it in its own envelope. `entries`
 * are the conversation's latest, oldest first.
 */
export const conversationDigest = (entries: ReadonlyArray<Entry>, operatorName: string): string => {
  const lines: Array<string> = [];
  let length = 0;
  for (const entry of entries.toReversed()) {
    if (entry._tag !== "message" || entry.delivery._tag !== "delivered") continue;
    if (entry.author._tag === "system") continue;
    const speaker = entry.author._tag === "operator" ? operatorName : "You";
    const files =
      entry.attachments.length === 0
        ? ""
        : ` [files: ${entry.attachments.map((file) => file.name).join(", ")}]`;
    const line = `${speaker}: ${shortened(entry.text, MESSAGE_CHARACTERS)}${files}`;
    if (length + line.length > DIGEST_CHARACTERS) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.length === 0
    ? "Nothing has been said in the conversation yet."
    : lines.toReversed().join("\n");
};
