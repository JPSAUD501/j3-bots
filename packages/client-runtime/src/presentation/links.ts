// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `url` when it is an http or https address, otherwise null. Addresses a bot
 * supplies become links only through this, so a `javascript:` or `data:` URL
 * is never something the operator can click.
 */
export function webAddress(url: string | null): string | null {
  if (url === null || !URL.canParse(url)) return null;
  const { protocol } = new URL(url);
  return protocol === "https:" || protocol === "http:" ? url : null;
}
