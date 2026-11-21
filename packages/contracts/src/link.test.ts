// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { PairingCode } from "./device.ts";
import { PairingLink, pairingOrigins, ServerOrigin } from "./link.ts";

const origin = Schema.decodeSync(ServerOrigin);
const encode = Schema.encodeSync(PairingLink);
const decode = Schema.decodeUnknownExit(PairingLink);
const code = PairingCode.make("7KQ2M9XH4D");

const refused = (link: string) => Exit.isFailure(decode(link));

describe("a pairing link", () => {
  it("carries the server and the code there and back", () => {
    for (const server of [
      "http://192.0.2.10:3737",
      "https://j3.example.test",
      "http://[fd00::10]:3737",
    ]) {
      const link = encode({ server: origin(server), code });
      assert.isTrue(link.startsWith("j3bots://pair?"), link);
      assert.deepStrictEqual(Schema.decodeSync(PairingLink)(link), { server, code });
    }
  });

  it("refuses a server that is not a bare http or https origin", () => {
    for (const server of [
      "ftp://192.0.2.10",
      "javascript:alert(1)",
      "j3bots://app",
      "http://192.0.2.10:3737/",
      "http://192.0.2.10:3737/api",
      "http://192.0.2.10:3737?x=1",
      "http://192.0.2.10:3737#x",
      "https://operator:secret@j3.example.test",
      "https://operator@j3.example.test",
      "HTTP://J3.EXAMPLE.TEST",
      "https://j3.example.test:443",
      "192.0.2.10:3737",
      "",
    ]) {
      const link = `j3bots://pair?${new URLSearchParams({ server, code })}`;
      assert.isTrue(refused(link), server);
    }
  });

  it("refuses a malformed code", () => {
    for (const malformed of [
      "7KQ2M9XH4",
      "7KQ2M9XH4DX",
      "7kq2m9xh4d",
      "7KQ2M-9XH4D",
      "7KQ2M9XH4I",
    ]) {
      const link = `j3bots://pair?${new URLSearchParams({ server: "http://192.0.2.10:3737", code: malformed })}`;
      assert.isTrue(refused(link), malformed);
    }
  });

  it("refuses anything but j3bots://pair with server and code once each", () => {
    const query = new URLSearchParams({ server: "http://192.0.2.10:3737", code });
    assert.isFalse(refused(`j3bots://pair?${query}`));
    for (const link of [
      `j3bots-other://pair?${query}`,
      `https://pair?${query}`,
      `j3bots://bot?${query}`,
      `j3bots://pair/x?${query}`,
      `j3bots://pair:1?${query}`,
      `j3bots://someone@pair?${query}`,
      `j3bots://pair?${query}#more`,
      `j3bots://pair?${query}&extra=1`,
      `j3bots://pair?${query}&code=${code}`,
      `j3bots://pair?code=${code}`,
      "j3bots://pair",
      "not a link",
    ]) {
      assert.isTrue(refused(link), link);
    }
  });
});

describe("the origins a pairing link can carry", () => {
  const lan = origin("http://192.0.2.10:3737");
  const tailnet = origin("http://100.64.0.7:3737");

  it("puts the one this client uses first, each once", () => {
    assert.deepStrictEqual(pairingOrigins([lan, tailnet], tailnet), [tailnet, lan]);
    assert.deepStrictEqual(pairingOrigins([lan, tailnet]), [lan, tailnet]);
    const proxied = origin("https://j3.example.test");
    assert.deepStrictEqual(pairingOrigins([lan], proxied), [proxied, lan]);
  });

  it("leaves out loopback, which names the device that reads it", () => {
    for (const loopback of [
      "http://127.0.0.1:3737",
      "http://localhost:3737",
      "http://[::1]:3737",
    ]) {
      assert.deepStrictEqual(pairingOrigins([lan], origin(loopback)), [lan], loopback);
    }
    assert.deepStrictEqual(pairingOrigins([origin("http://127.0.0.1:3737")]), []);
  });
});
