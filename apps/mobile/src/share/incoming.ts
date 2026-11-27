// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Shared } from "@j3-bots/client-runtime/presentation";
import type { Incoming } from "./native.ts";

/** A text that is nothing but one web address. */
const LINK = /^https?:\/\/\S+$/iu;

const filled = (value: string | null): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/**
 * What another app shared, from what the share sheet's module read. A text
 * that is a web address alone is a link, named by the title the sending app
 * gave it; any other text is taken as it is, links in it included. Null when
 * nothing in the share can go in a message.
 */
export const sharedOf = (incoming: Incoming): Shared | null => {
  const text = filled(incoming.text);
  const link = text !== null && LINK.test(text) ? text : null;
  const files = incoming.files.map(({ uri, name, mediaType, size }) => ({
    uri,
    name,
    mediaType,
    size,
  }));
  if (text === null && files.length === 0) return null;
  return {
    text: link === null ? text : null,
    url: link,
    title: link === null ? null : filled(incoming.title),
    files,
  };
};
