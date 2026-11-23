// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { OpenLiterals } from "./base.ts";

// How the operator sets up the providers bots think with from a client: a
// harness's own sign-in, run by the server for J3 Bots' home for it, and a
// connection to an endpoint that serves their models. The same operations as
// `j3-bots provider login` and `j3-bots provider connect`.

/** A harness that signs in with its maker's account: each has a home of its own on the server. */
export const SignInHarness = Schema.Literals(["claude-code", "codex"]);
export type SignInHarness = typeof SignInHarness.Type;

/** Each harness's name, and where its maker says how to install it. */
export const signInHarnesses: Readonly<
  Record<SignInHarness, { readonly name: string; readonly installPage: string }>
> = {
  "claude-code": { name: "Claude Code", installPage: "https://code.claude.com/docs/en/setup" },
  codex: { name: "Codex", installPage: "https://developers.openai.com/codex/cli" },
};

/** Where the server finds a harness, on the `PATH` it runs harnesses with; null when it is not there. */
export const HarnessLocation = Schema.Struct({
  harness: SignInHarness,
  path: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
});
export type HarnessLocation = typeof HarnessLocation.Type;

/** A page a sign-in waits on: `https:` only, so a client opens nothing else. */
export const SignInPage = Schema.String.check(
  Schema.isMaxLength(8192),
  Schema.makeFilter(
    (text: string) => (URL.canParse(text) && new URL(text).protocol === "https:") || "an https URL",
  ),
);

/**
 * Why a sign-in ended without signing the harness in:
 * - `not-installed`: the harness is not on the server's `PATH`;
 * - `needs-terminal`: it ended, or gave no page to sign in on within half a
 *   minute, without a terminal to ask on: its sign-in needs one here;
 * - `ended`: it ended without signing in, as when the page was refused;
 * - `no-credential`: it said it signed in, but left no credential file in
 *   J3 Bots' home for it, as a Codex set to keep its sign-in in the system's
 *   keyring does;
 * - `linked-home`: J3 Bots' home for it is a symbolic link, which could make
 *   the sign-in act on what it points to, such as the operator's own;
 * - `home-refused`: the server's data directory is not private or not
 *   writable, so nothing is signed in there;
 * - `timed-out`: nobody finished signing in on the page within ten minutes;
 * - `unexpected`: the server could not run it, as when the harness would not
 *   start; its log says why;
 * - `unknown`, as a client reads it: a reason a newer server gives.
 */
export const signInFailures = [
  "not-installed",
  "needs-terminal",
  "ended",
  "no-credential",
  "linked-home",
  "home-refused",
  "timed-out",
  "unexpected",
] as const;
export const SignInFailure = Schema.Literals(signInFailures);
export type SignInFailure = typeof SignInFailure.Type;

/**
 * Where a sign-in stands. It never carries what the harness receives: no
 * token, no code, nothing it printed but the page.
 * - `starting`: the harness is starting;
 * - `waiting-for-browser`: it waits for the operator to sign in on `url`, in
 *   a browser on the server's machine, where the page returns to the
 *   harness. `opened` when the harness opened the browser itself, so a
 *   client offers the page instead of opening it again;
 * - `succeeded`: signed in, in J3 Bots' home. `endpoint` is the base URL of a
 *   provider connection stored on the server, which J3 Bots sets the harness
 *   up to use instead, so a bot may not use this sign-in while it stays;
 * - `failed`: ended without signing in, and why;
 * - `cancelled`: a client cancelled it.
 */
export const ProviderSignInStatus = Schema.Union([
  Schema.TaggedStruct("starting", {}),
  Schema.TaggedStruct("waiting-for-browser", { url: SignInPage, opened: Schema.Boolean }),
  Schema.TaggedStruct("succeeded", { endpoint: Schema.NullOr(Schema.String) }),
  Schema.TaggedStruct("failed", { reason: OpenLiterals(signInFailures) }),
  Schema.TaggedStruct("cancelled", {}),
]);
export type ProviderSignInStatus = typeof ProviderSignInStatus.Type;

/** Hosts that never leave the machine: plain HTTP to them sends the key nowhere. */
const isLoopback = (hostname: string) =>
  hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);

/**
 * A URL's base form: its origin and its path, as the URL parser writes them
 * (lower-case host, no default port, dot segments resolved, tabs and line
 * breaks dropped), with no `/` for an empty path.
 */
export const baseUrlForm = (url: URL) => `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;

/**
 * Why `text` is not an endpoint's base URL as the engine is given it, or
 * undefined when it is one: `https`, or `http` to a loopback host only, since
 * the key travels with every request in clear otherwise; no credentials,
 * query or fragment, not even an empty `?` or `#`, which the parser drops but
 * a harness would append its path after, since the base URL is kept in plain
 * text and the key travels on its own; no trailing `/` or `/v1`, which each
 * harness adds itself; and written in its base form (`baseUrlForm`), so the
 * text the engine is given is the URL that was checked. A problem never
 * repeats the text, which may hold a credential.
 */
export const providerBaseUrlProblem = (text: string): string | undefined => {
  if (!URL.canParse(text) || text.length > 1000) return "it is not a URL";
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "it is not an http or https URL";
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    return "plain http would send the key in clear to another machine; use https, or http only to this machine (localhost, 127.0.0.1 or [::1])";
  }
  if (url.username !== "" || url.password !== "") return "it carries a user name or password";
  if (text.includes("?") || text.includes("#")) return "it has a query or fragment";
  if (text.endsWith("/") || url.pathname.endsWith("/v1")) return "it ends in / or /v1";
  if (baseUrlForm(url) !== text) {
    return "it is not written as scheme://host[:port][/path], in lower case, without a default port or . and .. segments";
  }
  return undefined;
};

/**
 * The base URL as the engine is given it, from what the operator typed: the
 * endpoint's root, without a trailing `/` or `/v1`, which each harness adds
 * itself. Otherwise why it cannot be one (`providerBaseUrlProblem`).
 */
export const normalizeBaseUrl = (
  text: string,
):
  | { readonly _tag: "url"; readonly url: string }
  | { readonly _tag: "problem"; readonly problem: string } => {
  const trimmed = text.trim();
  // Written in its base form, unless that would drop a part the check refuses.
  const url = URL.canParse(trimmed) ? new URL(trimmed) : null;
  const plain =
    url !== null && url.username === "" && url.password === "" && !/[?#]/.test(trimmed)
      ? baseUrlForm(url)
      : trimmed;
  const bare = plain.replace(/\/+$/, "");
  const root = bare.endsWith("/v1") ? bare.slice(0, -"/v1".length) : bare;
  const problem = providerBaseUrlProblem(root);
  return problem === undefined ? { _tag: "url", url: root } : { _tag: "problem", problem };
};

/** An endpoint's base URL as the engine is given it (`providerBaseUrlProblem`). */
export const ProviderBaseUrl = Schema.String.check(
  Schema.makeFilter((text: string) => providerBaseUrlProblem(text) === undefined, {
    expected: "an https base URL, or an http one to this machine",
  }),
);

/** The longest key an endpoint is given. */
export const MAX_PROVIDER_KEY_LENGTH = 4096;

export const ProviderConnectionRequest = Schema.Struct({
  baseUrl: ProviderBaseUrl,
  /**
   * Kept only in the engine's secret store, and never logged, stored
   * elsewhere or sent back. Redacted as soon as it is decoded, and checked
   * only then, so neither a refused key nor a log of the request prints it.
   */
  key: Schema.Redacted(Schema.String).check(
    Schema.makeFilter(
      (key: Redacted.Redacted<string>) => {
        const length = Redacted.value(key).length;
        return length >= 1 && length <= MAX_PROVIDER_KEY_LENGTH;
      },
      { expected: `a key of 1 to ${MAX_PROVIDER_KEY_LENGTH} characters` },
    ),
  ),
  /**
   * Whether the operator agreed that the engine's restart stops the work
   * bots have running. Without it, the server stores nothing while any runs.
   */
  stopWork: Schema.Boolean,
});
export type ProviderConnectionRequest = typeof ProviderConnectionRequest.Type;

/** What became of a provider connection. */
export const ProviderConnectionOutcome = Schema.Union([
  /** Stored, and the engine restarted with it. */
  Schema.TaggedStruct("applied", { baseUrl: Schema.String }),
  /** Stored, and the engine is not back yet: it starts with it. */
  Schema.TaggedStruct("stored", { baseUrl: Schema.String }),
  /**
   * Nothing stored: `bots` bots have work running, which the restart would
   * stop, and the request did not agree to that.
   */
  Schema.TaggedStruct("work-running", { bots: Schema.Int.check(Schema.isGreaterThan(0)) }),
  /** Not stored: the one before it, if any, stays in force. */
  Schema.TaggedStruct("refused", { active: Schema.NullOr(Schema.String) }),
]);
export type ProviderConnectionOutcome = typeof ProviderConnectionOutcome.Type;
