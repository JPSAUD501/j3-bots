// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_FAILURE_DETAILS } from "@j3-bots/contracts";
import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";

const REDACTED = "[redacted]";

/**
 * Shapes of a credential in an error's text, each with what stays of it: an
 * authorization header's scheme, a field's name, a URL's scheme and host.
 * The engine's contract has the provider redact credentials before it records
 * a failure (**Read** at `bc0f04d`, `orchestrationV2.ts`,
 * `OrchestrationV2ProviderFailure`); this is the second guard, for a provider
 * that did not.
 */
const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  // `Authorization: Bearer …`, `Basic …`.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // A JSON Web Token.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, REDACTED],
  // An API key in a provider's own shape: `sk-…`, `sk-ant-…`, `sess-…`.
  [/\b(?:sk|sess|rk|pk)-[A-Za-z0-9_-]{12,}/g, REDACTED],
  // `api_key=…`, `"token": "…"`, `password: …`.
  [
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|authorization|cookie|session[_-]?id)["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic|Token)\s+)?)[^\s"',;&}]+/gi,
    `$1${REDACTED}`,
  ],
  // A URL's user and password.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // A long run of letters and digits mixed, as a key or a token is.
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{48,}\b/g, REDACTED],
];

/** `text` with anything shaped like a credential replaced by `[redacted]`. */
export const scrubSecrets = (text: string): string =>
  SECRETS.reduce(
    (scrubbed, [pattern, replacement]) => scrubbed.replace(pattern, replacement),
    text,
  );

/**
 * The engine's own words, for "Details" and the server's log: with every
 * secret J3 Bots gave taken out (`redact`), scrubbed, and cut to
 * `MAX_FAILURE_DETAILS`.
 */
export const detailsOf = (text: string, redact: (text: string) => string): string => {
  const details = scrubSecrets(redact(text));
  return details.length > MAX_FAILURE_DETAILS
    ? `${details.slice(0, MAX_FAILURE_DETAILS - 1)}…`
    : details;
};

/**
 * A provider failure in the engine's words (`detailsOf`): its class, its code
 * when it has one, and its message.
 */
export const failureDetailsOf = (
  failure: OrchestrationV2ProviderFailure,
  redact: (text: string) => string,
): string => {
  const code = failure.code === null ? "" : ` (${failure.code})`;
  return detailsOf(`${failure.class}${code}: ${failure.message}`, redact);
};
