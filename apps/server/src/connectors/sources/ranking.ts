// SPDX-License-Identifier: AGPL-3.0-or-later

// How registry results are ordered. The registry verifies, when an entry is
// published, that the publisher controls its namespace: a domain for
// `com.example/…`, a GitHub account for `io.github.user/…`. It reviews
// nothing else, so mass publishers and wrappers of other companies' services
// fill most searches. The one signal J3 Bots can compute is whether the
// namespace's domain also owns the host the remote answers on: `com.notion/mcp`
// at `mcp.notion.com`. That entry was published by whoever runs the service.

/** A DNS label as a namespace writes it. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The domain a registry name's namespace stands for: `com.notion/mcp` is
 * `notion.com`. `null` for a name with no namespace, or one that is not a
 * domain of at least two labels.
 */
const namespaceDomain = (name: string): string | null => {
  const slash = name.indexOf("/");
  if (slash <= 0) return null;
  const labels = name.slice(0, slash).toLowerCase().split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  return labels.toReversed().join(".");
};

/**
 * The domain that published `name` and owns `url`'s host, or `null` when it
 * does not: the host is the namespace's domain or a subdomain of it. Shown as
 * "from notion.com", never as "verified": the registry does not review what
 * the server does.
 */
export const owningDomain = (name: string, url: string): string | null => {
  const domain = namespaceDomain(name);
  if (domain === null || !URL.canParse(url)) return null;
  const host = new URL(url).hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`) ? domain : null;
};

/** What ranking reads of one result. */
interface Rankable {
  readonly name: string;
  readonly title: string;
  readonly owner: string | null;
}

/**
 * How closely `name` matches the query, lower first:
 * 0. the query is a whole label of the namespace (`figma` in `com.figma.mcp`);
 * 1. the query is in the namespace;
 * 2. anywhere else (the registry matched it, so it is in the name).
 */
const closeness = (name: string, query: string) => {
  const namespace = name.split("/")[0]?.toLowerCase() ?? "";
  if (namespace.split(".").includes(query)) return 0;
  if (namespace.includes(query)) return 1;
  return 2;
};

/**
 * Results in the order the operator sees them: entries whose domain owns
 * their host first, then by how closely the name matches `query`, then by
 * title. The registry's own order is by name only.
 */
export const rank = <A extends Rankable>(results: ReadonlyArray<A>, query: string): Array<A> => {
  const words = query.toLowerCase().trim();
  return results.toSorted(
    (a, b) =>
      Number(a.owner === null) - Number(b.owner === null) ||
      closeness(a.name, words) - closeness(b.name, words) ||
      a.title.localeCompare(b.title, "en") ||
      a.name.localeCompare(b.name, "en"),
  );
};
