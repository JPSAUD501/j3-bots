// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  MAX_CONNECTOR_APP_BYTES,
  MAX_CONNECTOR_APP_DOMAINS,
  MCP_APP_MIME_TYPE,
} from "@j3-bots/contracts";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { appDocumentOf } from "./app.ts";

const URI = "ui://stock/table";
const HTML = "<p>In stock</p>";

const read = (content: Schema.JsonObject): Schema.Json => ({
  contents: [{ uri: URI, mimeType: MCP_APP_MIME_TYPE, ...content }],
});

const document = (answer: Schema.Json | null) => {
  const outcome = appDocumentOf(answer, URI);
  return Result.isSuccess(outcome) ? outcome.success : outcome.failure;
};

describe("appDocumentOf", () => {
  it("reads the document as text or base64, with no network allowed when none is declared", () => {
    const empty = { connectDomains: [], resourceDomains: [], baseUriDomains: [] };
    expect(document(read({ text: HTML }))).toEqual({ html: HTML, csp: empty });
    expect(document(read({ blob: Buffer.from(HTML).toString("base64") }))).toEqual({
      html: HTML,
      csp: empty,
    });
  });

  it("takes only the content at the tool's address, of the extension's type", () => {
    expect(
      document({ contents: [{ uri: "ui://other", mimeType: MCP_APP_MIME_TYPE, text: HTML }] }),
    ).toBe("not-an-app");
    expect(document(read({ mimeType: "text/html", text: HTML }))).toBe("not-an-app");
    expect(document(read({ blob: Buffer.from([0xff, 0xfe]).toString("base64") }))).toBe(
      "not-an-app",
    );
    expect(document(read({ text: "   " }))).toBe("not-an-app");
  });

  it("refuses a document larger than an app may be, or one its server answered too large to read", () => {
    expect(document(read({ text: "a".repeat(MAX_CONNECTOR_APP_BYTES + 1) }))).toBe("too-large");
    expect(document(null)).toBe("too-large");
  });

  it("refuses a document that embeds another, which the guard could not watch", () => {
    expect(document(read({ text: '<iframe src="https://example.com"></iframe>' }))).toBe(
      "embeds-a-document",
    );
  });

  it("allows of the declared origins only https and wss hosts, never frames or local addresses", () => {
    const declared = document(
      read({
        text: HTML,
        _meta: {
          ui: {
            csp: {
              connectDomains: [
                "https://api.example.com/",
                "WSS://Live.Example.com",
                "http://api.example.com",
                "https://127.0.0.1",
                "https://localhost",
                "https://example.com/path",
                "'self'",
                "*",
                42,
              ],
              resourceDomains: ["https://*.cdn.example.net"],
              frameDomains: ["https://embed.example.com"],
              baseUriDomains: [],
            },
          },
        },
      }),
    );
    expect(declared).toEqual({
      html: HTML,
      csp: {
        connectDomains: ["https://api.example.com", "wss://live.example.com"],
        resourceDomains: ["https://*.cdn.example.net"],
        baseUriDomains: [],
      },
    });
  });

  it("allows at most a policy's share of origins in each list", () => {
    const many = Array.from(
      { length: MAX_CONNECTOR_APP_DOMAINS + 5 },
      (_, n) => `https://h${n}.example.com`,
    );
    const declared = document(
      read({ text: HTML, _meta: { ui: { csp: { connectDomains: many } } } }),
    );
    expect(typeof declared === "object" && declared.csp.connectDomains.length).toBe(
      MAX_CONNECTOR_APP_DOMAINS,
    );
  });
});
