// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import {
  authorizationServerMetadataUrls,
  parseBearerChallenge,
  resourceCovers,
  resourceMetadataUrls,
} from "./protocol.ts";

const challenge = (header: string) =>
  Option.map(parseBearerChallenge(header), ({ resourceMetadata, scope, error }) => ({
    resourceMetadata: Option.getOrNull(resourceMetadata),
    scope: Option.getOrNull(scope),
    error: Option.getOrNull(error),
  }));

it("reads the Bearer challenge among others, with commas and escapes inside quotes", () => {
  assert.deepStrictEqual(
    challenge(
      'Basic realm="a, b", Bearer error="insufficient_scope", scope="files:read \\"x\\"", resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"',
    ),
    Option.some({
      resourceMetadata: "https://mcp.example.test/.well-known/oauth-protected-resource",
      scope: 'files:read "x"',
      error: "insufficient_scope",
    }),
  );
  // Another scheme's parameters are not Bearer's.
  assert.deepStrictEqual(
    challenge('Bearer realm="mcp", DPoP scope="other"'),
    Option.some({ resourceMetadata: null, scope: null, error: null }),
  );
  assert.deepStrictEqual(challenge('Basic realm="mcp"'), Option.none());
  // A value that cannot be read is left out, not guessed.
  assert.deepStrictEqual(
    challenge('bearer error=invalid_token, scope=two words, resource_metadata="unclosed'),
    Option.some({ resourceMetadata: null, scope: null, error: "invalid_token" }),
  );
});

it("looks for metadata at the specification's addresses, in its order", () => {
  assert.deepStrictEqual(resourceMetadataUrls(new URL("https://mcp.example.test/v1/mcp/")), [
    "https://mcp.example.test/.well-known/oauth-protected-resource/v1/mcp",
    "https://mcp.example.test/.well-known/oauth-protected-resource",
  ]);
  assert.deepStrictEqual(authorizationServerMetadataUrls(new URL("https://auth.example.test")), [
    "https://auth.example.test/.well-known/oauth-authorization-server",
    "https://auth.example.test/.well-known/openid-configuration",
  ]);
  assert.deepStrictEqual(
    authorizationServerMetadataUrls(new URL("https://auth.example.test/tenant/")),
    [
      "https://auth.example.test/.well-known/oauth-authorization-server/tenant",
      "https://auth.example.test/.well-known/openid-configuration/tenant",
      "https://auth.example.test/tenant/.well-known/openid-configuration",
    ],
  );
});

it("lets a resource cover its own server and those below it, segment by segment", () => {
  const server = new URL("https://mcp.example.test/v1/mcp");
  assert.isTrue(resourceCovers("https://mcp.example.test/v1/mcp/", server));
  assert.isTrue(resourceCovers("https://mcp.example.test", server));
  assert.isTrue(resourceCovers("https://mcp.example.test/v1", server));
  assert.isFalse(resourceCovers("https://mcp.example.test/v", server));
  assert.isFalse(resourceCovers("https://mcp.example.test/v1/mcp/more", server));
  assert.isFalse(resourceCovers("https://other.example.test/v1/mcp", server));
  assert.isFalse(resourceCovers("http://mcp.example.test/v1/mcp", server));
  assert.isFalse(resourceCovers("https://mcp.example.test:8443/v1/mcp", server));
  assert.isFalse(resourceCovers("https://mcp.example.test/v1/mcp?tenant=a", server));
});
