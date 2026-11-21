// SPDX-License-Identifier: AGPL-3.0-or-later
import { net } from "electron";
import * as Result from "effect/Result";
import { BODY_LIMIT, bodyCollector, responseOf } from "./answer.ts";

/**
 * `fetch` over Electron's network stack, the one the page uses (the system's
 * proxy and certificates), for the server check: requests without a body, and
 * answers whose body matters only with a 200, up to `BODY_LIMIT`. Unlike
 * `net.fetch`, which rejects when asked not to follow a redirect,
 * `redirect: "manual"` answers the redirect itself, with its status. The
 * promise settles once, from every path, and nothing throws inside a `net`
 * event handler.
 */
export const electronFetch: typeof globalThis.fetch = (input, init) =>
  new Promise((resolve, reject) => {
    if (init?.body !== undefined && init.body !== null) {
      return reject(new TypeError("electronFetch sends no request body"));
    }
    const signal = init?.signal ?? null;
    if (signal?.aborted === true) return reject(signal.reason);
    const mode = init?.redirect ?? "follow";
    const request = net.request({
      url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      method: init?.method ?? "GET",
      redirect: mode,
      credentials: "omit",
    });
    let settled = false;
    const onAbort = () => fail(signal?.reason);
    /** Settles with `outcome` and lets go of the request and the signal, unless already settled. */
    const settle = (outcome: Result.Result<Response, unknown>) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      request.abort();
      Result.match(outcome, { onSuccess: resolve, onFailure: reject });
    };
    const fail = (cause: unknown) => settle(Result.fail(cause));
    try {
      new Headers(init?.headers).forEach((value, name) => request.setHeader(name, value));
    } catch (cause) {
      return fail(cause);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    request.on("redirect", (status) => {
      if (mode === "manual") settle(responseOf(status, null));
    });
    request.on("response", (response) => {
      // Only a 200's body is read; any other answer is its status alone.
      if (response.statusCode !== 200) return settle(responseOf(response.statusCode, null));
      const body = bodyCollector(BODY_LIMIT);
      response.on("data", (chunk) => {
        if (!body.add(chunk)) fail(new RangeError("The answer's body is too large."));
      });
      response.on("aborted", () => fail(new Error("The answer was cut short.")));
      response.on("error", fail);
      response.on("end", () => settle(responseOf(200, body.bytes())));
    });
    request.on("error", fail);
    request.end();
  });
