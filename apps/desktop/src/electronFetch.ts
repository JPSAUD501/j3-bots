// SPDX-License-Identifier: AGPL-3.0-or-later
import { net } from "electron";

/**
 * `fetch` over Electron's network stack, the one the page uses (the system's
 * proxy and certificates), for requests without a body. Unlike `net.fetch`,
 * which rejects when asked not to follow a redirect, `redirect: "manual"`
 * answers the redirect itself, with its status and no body.
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
    new Headers(init?.headers).forEach((value, name) => request.setHeader(name, value));
    signal?.addEventListener(
      "abort",
      () => {
        request.abort();
        reject(signal.reason);
      },
      { once: true },
    );
    request.on("redirect", (status) => {
      if (mode !== "manual") return;
      resolve(new Response(null, { status }));
      request.abort();
    });
    request.on("response", (response) => {
      const chunks: Array<Uint8Array> = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, values] of Object.entries(response.headers)) {
          for (const value of typeof values === "string" ? [values] : values) {
            headers.append(name, value);
          }
        }
        const body = new Uint8Array(Buffer.concat(chunks));
        resolve(
          new Response(body.length === 0 ? null : body, { status: response.statusCode, headers }),
        );
      });
    });
    request.on("error", reject);
    request.end();
  });
