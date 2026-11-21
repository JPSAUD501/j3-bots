// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { MAX_ATTACHMENT_SIZE } from "@j3-bots/contracts";
import { ServerOrigin } from "@j3-bots/desktop-bridge";
import { isUploadUrl, mayUpload } from "./uploadTarget.ts";

const server = ServerOrigin.make("http://192.0.2.10:3737");

describe("an upload's destination", () => {
  it("is only the attachments route of the server the app keeps", () => {
    for (const url of [
      "http://192.0.2.10:3737/attachments",
      "http://192.0.2.10:3737/attachments?name=notes.txt",
      "http://192.0.2.10:3737/attachments?name=notes.txt#part",
    ]) {
      assert.isTrue(isUploadUrl(url, server), url);
    }
    for (const url of [
      "https://192.0.2.10:3737/attachments",
      "http://192.0.2.10:3738/attachments",
      "http://192.0.2.11:3737/attachments",
      "http://192.0.2.10:3737/attachments/",
      "http://192.0.2.10:3737/attachments/x",
      "http://192.0.2.10:3737/api/attachments",
      "http://192.0.2.10:3737/x/../attachments/../devices",
      "http://user@192.0.2.10:3737/attachments",
      "http://user:secret@192.0.2.10:3737/attachments",
      "/attachments",
      "not a url",
    ]) {
      assert.isFalse(isUploadUrl(url, server), url);
    }
    assert.isFalse(isUploadUrl("http://192.0.2.10:3737/attachments", null));
  });

  it("takes no file larger than the server accepts", () => {
    const start = (size: number) => ({
      request: { url: "http://192.0.2.10:3737/attachments?name=a.bin", headers: {} },
      size,
    });
    assert.isTrue(mayUpload(start(MAX_ATTACHMENT_SIZE), server));
    assert.isFalse(mayUpload(start(MAX_ATTACHMENT_SIZE + 1), server));
  });
});
