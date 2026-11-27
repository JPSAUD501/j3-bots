// SPDX-License-Identifier: AGPL-3.0-or-later

const LOOPBACK = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;

/**
 * The address a tab opens for what a bot or a person typed: an absolute
 * `http:` or `https:` address as it is, and a bare host with `https:`, or
 * `http:` for a loopback host. Undefined for any other scheme, or for text
 * that is no address.
 */
export const addressOf = (input: string): string | undefined => {
  const text = input.trim();
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(text);
  const candidate = absolute
    ? text
    : `${LOOPBACK.test(text.split(/[/?#]/, 1)[0] ?? "") ? "http" : "https"}://${text}`;
  if (!URL.canParse(candidate)) return undefined;
  const url = new URL(candidate);
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
};
