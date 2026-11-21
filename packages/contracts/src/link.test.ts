// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { PairingCode } from "./device.ts";
import { PairingLink, pairingOrigins, ServerOrigin } from "./link.ts";
import { PairingStarted } from "./rpc.ts";

const origin = Schema.decodeSync(ServerOrigin);
const encode = Schema.encodeSync(PairingLink);
const decode = Schema.decodeUnknownExit(PairingLink);
const code = PairingCode.make("7KQ2M9XH4D");

const refused = (link: string) => Exit.isFailure(decode(link));

describe("a pairing link", () => {
  it("is the server's own address with the code in the fragment, there and back", () => {
    for (const server of [
      "http://192.0.2.10:3737",
      "https://j3.example.test",
      "http://[fd00::10]:3737",
    ]) {
      const link = encode({ server: origin(server), code });
      assert.strictEqual(link, `${server}/#pair=${code}`);
      assert.deepStrictEqual(Schema.decodeSync(PairingLink)(link), { server, code });
    }
  });

  it("refuses a base that is not a bare http or https origin at /", () => {
    for (const link of [
      `ftp://192.0.2.10/#pair=${code}`,
      `j3bots://app/#pair=${code}`,
      `http://192.0.2.10:3737/api#pair=${code}`,
      `http://192.0.2.10:3737/?x=1#pair=${code}`,
      `http://192.0.2.10:3737#pair=${code}`,
      `https://operator:secret@j3.example.test/#pair=${code}`,
      `https://operator@j3.example.test/#pair=${code}`,
      `HTTP://J3.EXAMPLE.TEST/#pair=${code}`,
      `https://j3.example.test:443/#pair=${code}`,
      `192.0.2.10:3737/#pair=${code}`,
      `/#pair=${code}`,
      `j3bots://pair?server=http%3A%2F%2F192.0.2.10%3A3737&code=${code}`,
    ]) {
      assert.isTrue(refused(link), link);
    }
  });

  it("refuses a fragment other than one pair code", () => {
    const base = "http://192.0.2.10:3737/";
    assert.isFalse(refused(`${base}#pair=${code}`));
    for (const fragment of [
      "",
      "#",
      "#pair=",
      `#code=${code}`,
      `#pair=${code}&pair=${code}`,
      `#pair=${code}&extra=1`,
      `#pair=${code}#more`,
      "#pair=7KQ2M9XH4",
      "#pair=7kq2m9xh4d",
      "#pair=7KQ2M-9XH4D",
      "#pair=7KQ2M9XH4I",
    ]) {
      assert.isTrue(refused(`${base}${fragment}`), fragment);
    }
    assert.isTrue(refused(`http://192.0.2.10:3737/?pair=${code}`));
  });
});

describe("without URL.parse, as in Safari 17", () => {
  const parse = Object.getOwnPropertyDescriptor(URL, "parse");
  beforeEach(() => {
    Reflect.deleteProperty(URL, "parse");
  });
  afterEach(() => {
    if (parse !== undefined) Object.defineProperty(URL, "parse", parse);
  });

  it("decodes an origin and a pairing link", () => {
    assert.isFalse("parse" in URL);
    const server = "http://192.0.2.10:3737";
    assert.deepStrictEqual(Schema.decodeOption(ServerOrigin)(server), Option.some(origin(server)));
    assert.isTrue(Option.isNone(Schema.decodeOption(ServerOrigin)("not an origin")));
    assert.deepStrictEqual(Schema.decodeSync(PairingLink)(`${server}/#pair=${code}`), {
      server,
      code,
    });
  });
});

describe("the origins a pairing link can carry", () => {
  const lan = origin("http://192.0.2.10:3737");
  const tailnet = origin("http://100.64.0.7:3737");

  it("puts the one this client uses first when the server offers it or it is https", () => {
    assert.deepStrictEqual(pairingOrigins([lan, tailnet], tailnet), [tailnet, lan]);
    assert.deepStrictEqual(pairingOrigins([lan, tailnet]), [lan, tailnet]);
    const proxied = origin("https://j3.example.test");
    assert.deepStrictEqual(pairingOrigins([lan], proxied), [proxied, lan]);
  });

  it("leaves out a plain-HTTP origin the server does not offer", () => {
    const forwarded = origin("http://192.0.2.99:8080");
    assert.deepStrictEqual(pairingOrigins([lan, tailnet], forwarded), [lan, tailnet]);
  });

  // IPv4-mapped addresses as a browser writes them: ::ffff:127.0.0.1 and ::ffff:0.0.0.0.
  it("never carries an origin that names the reading device itself", () => {
    for (const self of [
      "http://127.0.0.1:3737",
      "http://localhost:3737",
      "http://[::1]:3737",
      "http://[::ffff:7f00:1]:3737",
      "http://0.0.0.0:3737",
      "http://[::]:3737",
      "https://localhost",
      "https://127.0.0.1",
      "https://[::ffff:7f00:1]",
      "https://[::ffff:0:0]",
      "https://j3.localhost",
    ]) {
      const loopback = origin(self);
      assert.deepStrictEqual(pairingOrigins([lan], loopback), [lan], self);
      assert.deepStrictEqual(pairingOrigins([loopback, lan], loopback), [lan], self);
    }
  });
});

describe("the answer to pairing.start across server versions", () => {
  const expiresAt = DateTime.makeUnsafe("2026-11-20T12:05:00Z");
  /** What a server and a client from before `origins` read and write. */
  const Before = Schema.Struct({ code: PairingCode, expiresAt: Schema.DateTimeUtc });

  it("reads an older server's answer as offering no origins", () => {
    const older = Schema.encodeSync(Before)({ code, expiresAt });
    assert.deepStrictEqual(Schema.decodeSync(PairingStarted)(older), {
      code,
      expiresAt,
      origins: [],
    });
  });

  it("is read by an older client, which ignores the origins", () => {
    const newer = Schema.encodeSync(PairingStarted)({
      code,
      expiresAt,
      origins: [origin("http://192.0.2.10:3737")],
    });
    assert.deepStrictEqual(Schema.decodeSync(Before)(newer), { code, expiresAt });
  });
});
