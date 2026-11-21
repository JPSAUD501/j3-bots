// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vite-plus/test";
import type { Desktop, UploadAnswer } from "./desktop";
import { desktopTransfer } from "./desktopTransfer";

const URL_ = "http://192.168.1.20:3737/api/attachments?name=notes.txt";
const request = (onProgress: (sent: number) => void) => ({
  url: URL_,
  headers: { authorization: "Bearer token", "content-type": "text/plain" },
  body: new Blob(["0123456789".repeat(3)]),
  onProgress,
});

/** The app's upload, answering `answer` once it has reported `steps`. */
const uploadAnswering =
  (steps: ReadonlyArray<number>, answer: UploadAnswer | null): Desktop["upload"] =>
  (_request, _body, onProgress) => ({
    done: Promise.resolve().then(() => {
      for (const sent of steps) onProgress(sent);
      return answer;
    }),
    abort: () => undefined,
  });

describe("uploading through the desktop app", () => {
  it("reports the bytes sent as they go, and answers what the server answered", async () => {
    const answer: UploadAnswer = { _tag: "answered", url: URL_, status: 200, body: "{}" };
    const seen: Array<number> = [];
    const response = await Effect.runPromise(
      desktopTransfer(uploadAnswering([10, 20, 30], answer)).upload(
        request((sent) => seen.push(sent)),
      ),
    );
    expect(seen).toEqual([10, 20, 30]);
    expect(response).toEqual({ url: URL_, status: 200, body: "{}" });
  });

  it("fails when the upload did not reach the server", async () => {
    const error = await Effect.runPromise(
      Effect.flip(desktopTransfer(uploadAnswering([10], null)).upload(request(() => undefined))),
    );
    expect(error._tag).toBe("TransferFailed");
  });

  it("aborts the upload in the app when it is interrupted", async () => {
    let aborted = false;
    const pending: Desktop["upload"] = () => ({
      done: new Promise(() => undefined),
      abort: () => {
        aborted = true;
      },
    });
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          desktopTransfer(pending).upload(request(() => undefined)),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
      }),
    );
    expect(aborted).toBe(true);
  });
});
