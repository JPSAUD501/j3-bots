// SPDX-License-Identifier: AGPL-3.0-or-later
import { HTTP_PATHS, MAX_ATTACHMENT_SIZE } from "@j3-bots/contracts";
import {
  type ServerOrigin,
  UPLOAD_TAGS,
  UploadBody,
  type UploadOutcome,
  type UploadStart,
} from "@j3-bots/desktop-bridge";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type ClientRequest, type MessagePortMain, net } from "electron";
import { BODY_LIMIT, bodyCollector } from "./answer.ts";

const decodeBody = Schema.decodeUnknownOption(UploadBody);

/** Whether `url` is the attachments route of `server`, the one place the page uploads to. */
const isUploadUrl = (url: string, server: ServerOrigin | null): boolean => {
  const parsed = URL.parse(url);
  return (
    server !== null &&
    parsed !== null &&
    parsed.origin === server &&
    parsed.pathname === HTTP_PATHS.attachments
  );
};

/** Ends an upload that cannot start. */
export const refuseUpload = (port: MessagePortMain): void => {
  port.postMessage({ _tag: UPLOAD_TAGS.failed } satisfies UploadOutcome);
  port.close();
};

/**
 * Streams the body the preload script sends on `port` to the server, over
 * Electron's network stack (the one the page uses: the system's proxy and
 * certificates), with the page's headers. Electron refuses a `Content-Length`
 * set by hand and streams only with chunked encoding, so the body goes
 * chunked. A chunk is pulled only once the one before it was handed to the
 * network, which is when its bytes count as sent. A redirect is answered as
 * it came, not followed, so the token never goes anywhere else. Settles once,
 * from every path, and the port closing aborts the request.
 */
export const runUpload = (
  start: UploadStart,
  server: ServerOrigin | null,
  port: MessagePortMain,
) => {
  const { url, headers } = start.request;
  if (!isUploadUrl(url, server) || start.size > MAX_ATTACHMENT_SIZE) return refuseUpload(port);
  let request: ClientRequest;
  try {
    request = net.request({ method: "POST", url, redirect: "manual", credentials: "omit" });
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    request.chunkedEncoding = true;
  } catch {
    return refuseUpload(port);
  }
  let settled = false;
  const settle = (outcome: UploadOutcome | null) => {
    if (settled) return;
    settled = true;
    request.abort();
    if (outcome !== null) port.postMessage(outcome);
    port.close();
  };
  const fail = () => settle({ _tag: UPLOAD_TAGS.failed });
  const pull = () => port.postMessage({ _tag: UPLOAD_TAGS.pull });
  // What was handed to the request, and what of it the network took.
  let written = 0;
  let sent = 0;

  port.on("close", () => settle(null));
  port.on("message", ({ data }) => {
    if (settled) return;
    const body = decodeBody(data);
    if (Option.isNone(body)) return fail();
    if (body.value._tag === "end") {
      if (written === start.size) request.end();
      else fail();
      return;
    }
    const { bytes } = body.value;
    written += bytes.byteLength;
    if (written > start.size) return fail();
    // The callback runs once Chromium's network layer has the chunk, up to a
    // pipe's worth ahead of the wire.
    request.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), undefined, () => {
      if (settled) return;
      sent += bytes.byteLength;
      port.postMessage({ _tag: UPLOAD_TAGS.progress, sent });
      pull();
    });
  });
  request.on("redirect", (status, _method, location) =>
    settle({ _tag: UPLOAD_TAGS.answered, url: location, status, body: "" }),
  );
  request.on("response", (response) => {
    const body = bodyCollector(BODY_LIMIT);
    response.on("data", (chunk) => {
      if (!body.add(chunk)) fail();
    });
    response.on("aborted", fail);
    response.on("error", fail);
    response.on("end", () =>
      settle({
        _tag: UPLOAD_TAGS.answered,
        url,
        status: response.statusCode,
        body: new TextDecoder().decode(body.bytes()),
      }),
    );
  });
  request.on("error", fail);
  port.start();
  pull();
};
