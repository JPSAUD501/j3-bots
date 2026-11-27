// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import { makeScrubber } from "./scrub.ts";

// Every value here is made up for the test.
const SECRET = "correct-horse-battery";
const QUOTED_SECRET = 'pa"ss\\word';
const CONNECTOR_TOKEN = "conn-token-value-1234";
const HOME = "/home/ana.silva";
const WINDOWS_HOME = "C:\\Users\\ana.silva";

const scrub = makeScrubber({
  secrets: [SECRET, QUOTED_SECRET, CONNECTOR_TOKEN, "abc"].map((value) => Redacted.make(value)),
  home: HOME,
  user: "ana.silva",
  host: "studio-desk",
});

const FIXTURE = [
  `{"message":"Connector answered","cause":"token ${CONNECTOR_TOKEN} refused","password":"${SECRET}"}`,
  `{"message":"Saved","value":${JSON.stringify(QUOTED_SECRET)}}`,
  `GET https://ana:hunter2@mail.example.org/inbox failed`,
  `Authorization: Bearer abcdefghijKLMNOP0123456789`,
  `jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk`,
  `keys sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv phc_ZyXwVuTsRqPoNmLkJiHgFeDc ghp_0123456789abcdefABCDEFGHIJ`,
  `digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08`,
  `session 8Fq2LmZ0pX7rT4vB9nW1cY6kJ3hD5sGq end`,
  `mail from ana.silva+bots@example.com and ops@studio.example.net`,
  `workspace ${HOME}/.j3-bots/bots/bot_0123456789abcdefghjk/memory`,
  `user ana.silva on studio-desk.local (STUDIO-DESK)`,
  `listening on 192.168.10.24:3737 and 127.0.0.1:3739 and 0.0.0.0, peer 100.64.1.2`,
  `ipv6 fe80::1c2b:3aff:fe4d:5e6f and 2001:db8::8a2e:370:7334 and loopback ::1`,
  `at 14:05:33 version 0.14.0 room room_0123456789abcdefghjk took 12:30`,
  `short abc stays`,
].join("\n");

describe("makeScrubber", () => {
  it("leaves nothing of the person and keeps what follows a flow", () => {
    const out = scrub(FIXTURE);
    for (const gone of [
      SECRET,
      CONNECTOR_TOKEN,
      "pa\\\"ss",
      "hunter2",
      "abcdefghijKLMNOP0123456789",
      "eyJhbGciOiJIUzI1NiJ9",
      "sk-ant",
      "phc_Zy",
      "ghp_01",
      "9f86d081884c7d659a2feaa0c55ad015",
      "8Fq2LmZ0pX7rT4vB9nW1cY6kJ3hD5sGq",
      "example.com",
      "studio.example.net",
      "/home/",
      "ana.silva",
      "studio-desk",
      "STUDIO-DESK",
      "192.168.10.24",
      "100.64.1.2",
      "fe80::",
      "2001:db8",
    ]) {
      assert.notInclude(out, gone);
    }
    assert.strictEqual(
      out,
      [
        `{"message":"Connector answered","cause":"token [secret] refused","password":"[secret]"}`,
        `{"message":"Saved","value":"[secret]"}`,
        `GET https://[credentials]@mail.example.org/inbox failed`,
        `Authorization: Bearer [token]`,
        `jwt [token]`,
        `keys [token] [token] [token]`,
        `digest [token]`,
        `session [token] end`,
        `mail from [email] and [email]`,
        `workspace ~/.j3-bots/bots/bot_0123456789abcdefghjk/memory`,
        `user [user] on [host].local ([host])`,
        `listening on [ipv4]:3737 and 127.0.0.1:3739 and 0.0.0.0, peer [ipv4]`,
        `ipv6 [ipv6] and [ipv6] and loopback ::1`,
        `at 14:05:33 version 0.14.0 room room_0123456789abcdefghjk took 12:30`,
        `short abc stays`,
      ].join("\n"),
    );
  });

  it("takes a Windows home in each form a log writes it", () => {
    const onWindows = makeScrubber({ secrets: [], home: WINDOWS_HOME, user: "ana", host: "pc" });
    const line = `${JSON.stringify(`${WINDOWS_HOME}\\AppData\\j3`)} and ${WINDOWS_HOME}\\x and c:/users/ana.silva/AppData`;
    assert.strictEqual(onWindows(line), '"~\\\\AppData\\\\j3" and ~\\x and ~/AppData');
  });
});
