// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_FAILURE_DETAILS } from "@j3-bots/contracts";
import { assert, describe, it } from "@effect/vitest";
import { failureDetailsOf, scrubSecrets } from "./failureDetails.ts";

describe("scrubSecrets", () => {
  it("hides what is shaped like a credential and keeps the words around it", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["401: Authorization: Bearer abcdefghijklmnop1234", "401: Authorization: Bearer [redacted]"],
      ["invalid x-api-key sk-ant-api03-AbCdEfGhIjKlMnOp", "invalid x-api-key [redacted]"],
      ['{"api_key": "abc123secret", "model": "x"}', '{"api_key": "[redacted]", "model": "x"}'],
      ["password=hunter22&user=me", "password=[redacted]&user=me"],
      [
        "fetch https://me:pa55word@proxy.example/v1 failed",
        "fetch https://[redacted]@proxy.example/v1 failed",
      ],
      [
        "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl expired",
        "token [redacted] expired",
      ],
    ];
    for (const [text, scrubbed] of cases) assert.strictEqual(scrubSecrets(text), scrubbed);
  });

  it("leaves an error with nothing secret in it as it was", () => {
    const text = "overloaded_error: Overloaded (request req_011CUabc). Try again in 30s.";
    assert.strictEqual(scrubSecrets(text), text);
  });
});

const asGiven = (text: string) => text;

describe("failureDetailsOf", () => {
  it("says the class, the code when there is one, and the message, cut to the limit", () => {
    assert.strictEqual(
      failureDetailsOf(
        {
          class: "provider_error",
          message: "Overloaded",
          code: "overloaded_error",
          retryable: true,
        },
        asGiven,
      ),
      "provider_error (overloaded_error): Overloaded",
    );
    const long = failureDetailsOf(
      {
        class: "unknown",
        message: "x ".repeat(MAX_FAILURE_DETAILS),
        code: null,
        retryable: null,
      },
      asGiven,
    );
    assert.strictEqual(long.length, MAX_FAILURE_DETAILS);
    assert.isTrue(long.startsWith("unknown: x x"));
  });

  it("takes out a secret J3 Bots gave, whatever its shape, also where the limit cuts it", () => {
    // A gateway's key with no shape the scrubber knows, repeated by its error.
    const key = "gw_live_7Qm2ZxPa9LrT4kVb8NcY1sWd3Hj";
    const redactKey = (text: string) => text.split(key).join("[redacted]");
    const lead = "provider_error (api_error_401): ";
    const fill = "x".repeat(MAX_FAILURE_DETAILS - lead.length - 20);
    const details = failureDetailsOf(
      {
        class: "provider_error",
        message: `${fill} ${key} ${fill} Incorrect API key provided: ${key}.`,
        code: "api_error_401",
        retryable: null,
      },
      redactKey,
    );
    assert.isFalse(details.includes(key.slice(0, 6)));
    assert.isTrue(details.includes(" [redacted] x"));
  });
});
