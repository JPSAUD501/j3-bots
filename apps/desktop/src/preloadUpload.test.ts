// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { UPLOAD_TAGS } from "@j3-bots/desktop-bridge/channels";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { makeUpload } from "./preloadUpload.ts";

/** The main process's end of each upload, as `ipcRenderer.postMessage` hands it over. */
const mainProcess = () => {
  const ports: Array<MessagePort> = [];
  const upload = makeUpload((_start, port) => {
    ports.push(port);
  });
  const port = () => {
    const [first] = ports;
    if (first === undefined) throw new Error("No upload reached the main process.");
    return first;
  };
  return { upload, port };
};

/** What `done` settles with, if it settles soon. */
const settled = (done: Promise<unknown>) =>
  Effect.promise(() => done).pipe(Effect.timeoutOption("200 millis"));

const body = () => new Blob(["0123456789"]);
const failed = Option.some({ _tag: UPLOAD_TAGS.failed });

describe("the preload script's upload", () => {
  it.effect("settles as failed when the page aborts it", () =>
    Effect.gen(function* () {
      const { upload } = mainProcess();
      const handle = upload({ url: "x", headers: {} }, body(), () => undefined);
      handle.abort();
      assert.deepStrictEqual(yield* settled(handle.done), failed);
    }),
  );

  it.effect("settles as failed when the main process closes the port with no outcome", () =>
    Effect.gen(function* () {
      const { upload, port } = mainProcess();
      const handle = upload({ url: "x", headers: {} }, body(), () => undefined);
      port().close();
      assert.deepStrictEqual(yield* settled(handle.done), failed);
    }),
  );
});
