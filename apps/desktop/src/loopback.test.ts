// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { arrival, landingPage, signInCatch } from "./loopback.ts";

const PORT = 51734;
const host = `127.0.0.1:${PORT}`;
const get = (url: string, over: { method?: string; host?: string } = {}) =>
  arrival({ method: over.method ?? "GET", url, host: over.host ?? host }, PORT);

describe("catching the browser's return from a sign-in", () => {
  it("takes the return to its own address, with the state the sign-in put in it", () => {
    assert.deepStrictEqual(get("/oauth/callback?code=abc&state=s1"), {
      _tag: "returned",
      url: "http://127.0.0.1:51734/oauth/callback?code=abc&state=s1",
      state: "s1",
    });
    // The provider's refusal comes back the same way, for the server to read.
    assert.deepStrictEqual(get("/oauth/callback?error=access_denied&state=s1"), {
      _tag: "returned",
      url: "http://127.0.0.1:51734/oauth/callback?error=access_denied&state=s1",
      state: "s1",
    });
  });

  it("turns away anything else that reaches the port, and waits on", () => {
    assert.deepStrictEqual(get("/favicon.ico"), { _tag: "refused", status: 404 });
    assert.deepStrictEqual(get("/oauth/callback?code=abc"), { _tag: "refused", status: 400 });
    assert.deepStrictEqual(get("/oauth/callback?code=abc&state="), {
      _tag: "refused",
      status: 400,
    });
    assert.deepStrictEqual(get("/oauth/callback?state=s1", { method: "POST" }), {
      _tag: "refused",
      status: 405,
    });
    // A page that reached the port under another name, by DNS rebinding, or on another port.
    for (const other of [`attacker.example:${PORT}`, `localhost:${PORT}`, "127.0.0.1:1"]) {
      assert.deepStrictEqual(get("/oauth/callback?state=s1", { host: other }), {
        _tag: "refused",
        status: 400,
      });
    }
    // A target that is not a path cannot name another host.
    assert.deepStrictEqual(get("//attacker.example/oauth/callback?state=s1"), {
      _tag: "refused",
      status: 404,
    });
    assert.deepStrictEqual(get(`/oauth/callback?state=s1&pad=${"x".repeat(9000)}`), {
      _tag: "refused",
      status: 400,
    });
  });

  it("takes only the return with this sign-in's state, once, and is not spent by another", () => {
    const relayed: Array<string> = [];
    let focused = 0;
    const caught = signInCatch(PORT, {
      relay: (url) => relayed.push(url),
      focus: () => {
        focused += 1;
      },
    });
    const callback = (state: string) => ({
      method: "GET",
      url: `/oauth/callback?code=c&state=${state}`,
      host,
    });
    // Before the server's state is known, nothing is taken.
    assert.deepStrictEqual(caught.answer(callback("right-state")), {
      _tag: "refused",
      status: 400,
    });
    caught.expect("right-state");
    // A forged return, with another state or one of the same length, leaves the sign-in waiting.
    for (const forged of ["wrong", "wrong-state", "right-stat"]) {
      assert.deepStrictEqual(caught.answer(callback(forged)), { _tag: "refused", status: 400 });
    }
    assert.deepStrictEqual(relayed, []);
    assert.strictEqual(focused, 0);
    assert.deepStrictEqual(caught.answer(callback("right-state")), { _tag: "returned" });
    // A reload of the page it landed on relays nothing more.
    assert.deepStrictEqual(caught.answer(callback("right-state")), {
      _tag: "refused",
      status: 404,
    });
    assert.deepStrictEqual(relayed, [`http://${host}/oauth/callback?code=c&state=right-state`]);
    assert.strictEqual(focused, 1);
  });

  it("shows a page that runs nothing and says nothing it was not given", () => {
    const page = landingPage({ language: "en", title: "Back <b>", body: "Close & go" });
    assert.include(page, "<title>Back &#60;b&#62;</title>");
    assert.include(page, "Close &#38; go");
    assert.notInclude(page, "<script");
  });
});
