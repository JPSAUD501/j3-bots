// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  ConnectRequest,
  ConnectResult,
  DesktopState,
  HostedBridge,
  OpenRequest,
  UploadBody,
} from "./index.ts";

const decodes = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
) => Exit.isSuccess(Schema.decodeUnknownExit(schema)(input));

describe("the desktop bridge", () => {
  it("keeps only a bare http: or https: origin as the server", () => {
    for (const server of [
      "http://192.0.2.10:3737",
      "https://j3.example.test",
      "http://[::1]:3737",
    ]) {
      assert.isTrue(decodes(DesktopState, { server }), server);
    }
    for (const server of [
      "http://192.0.2.10:3737/",
      "http://192.0.2.10:3737/api",
      "https://user:secret@j3.example.test",
      "https://j3.example.test?x=1",
      "ws://192.0.2.10:3737",
      "file:///etc/passwd",
      "j3bots://app",
      "192.0.2.10:3737",
      "",
    ]) {
      assert.isFalse(decodes(DesktopState, { server }), server);
    }
    assert.isTrue(decodes(DesktopState, { server: null }));
    assert.isFalse(decodes(DesktopState, {}));
  });

  it("refuses an answer from the main process that is not one it gives", () => {
    assert.isTrue(decodes(ConnectResult, { _tag: "connected", server: "http://192.0.2.10:3737" }));
    assert.isTrue(decodes(ConnectResult, { _tag: "refused", reason: "needs-https" }));
    assert.isFalse(decodes(ConnectResult, { _tag: "connected", server: "http://192.0.2.10/x" }));
    assert.isFalse(decodes(ConnectResult, { _tag: "refused", reason: "because" }));
    assert.isFalse(decodes(ConnectResult, { _tag: "paired" }));
    assert.isFalse(decodes(ConnectResult, "connected"));
  });

  it("refuses a request from a page that is not one it may make", () => {
    assert.isTrue(decodes(ConnectRequest, { address: "192.0.2.10:3737" }));
    assert.isFalse(decodes(ConnectRequest, { address: "x".repeat(2049) }));
    assert.isFalse(decodes(ConnectRequest, { address: 3737 }));
    assert.isFalse(decodes(ConnectRequest, null));
    assert.isTrue(decodes(OpenRequest, { sealed: "djEwAAAA" }));
    assert.isFalse(decodes(OpenRequest, { sealed: "not base64!" }));
    assert.isFalse(decodes(OpenRequest, { sealed: "" }));
    assert.isTrue(decodes(UploadBody, { _tag: "chunk", bytes: new Uint8Array(4) }));
    assert.isFalse(decodes(UploadBody, { _tag: "chunk", bytes: [1, 2, 3] }));
    assert.isFalse(decodes(UploadBody, { _tag: "chunk", bytes: "AAAA" }));
  });

  it("finds the bridge only where the preload script put a whole one", () => {
    const call = () => Promise.resolve(null);
    const calls = {
      connect: call,
      forgetServer: call,
      sealToken: call,
      openToken: call,
      networkStatus: call,
      onResumed: call,
      upload: call,
    };
    const state = { server: null };
    assert.isTrue(decodes(HostedBridge, { state, ...calls }));
    assert.isFalse(decodes(HostedBridge, undefined));
    assert.isFalse(decodes(HostedBridge, { state: { ...state, server: "nowhere" }, ...calls }));
    assert.isFalse(decodes(HostedBridge, { state, ...calls, connect: "yes" }));
  });
});
