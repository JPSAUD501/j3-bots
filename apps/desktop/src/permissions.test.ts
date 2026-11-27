// SPDX-License-Identifier: AGPL-3.0-or-later
import { assert, describe, it } from "@effect/vitest";
import { grants, holds } from "./permissions.ts";

describe("what the page may ask of the system", () => {
  it("grants the microphone alone, for dictation", () => {
    assert.isTrue(grants("media", ["audio"]));
    assert.isTrue(holds("media", "audio"));
  });

  it("never grants a camera, nor audio together with video", () => {
    assert.isFalse(grants("media", ["video"]));
    assert.isFalse(grants("media", ["audio", "video"]));
    assert.isFalse(grants("media", []));
    assert.isFalse(grants("media", undefined));
    assert.isFalse(holds("media", "video"));
    assert.isFalse(holds("media", "unknown"));
    assert.isFalse(holds("media", undefined));
  });

  it("grants notifications and clipboard writes, and nothing else", () => {
    assert.isTrue(grants("notifications", undefined));
    assert.isTrue(holds("clipboard-sanitized-write", undefined));
    assert.isFalse(grants("display-capture", undefined));
    assert.isFalse(grants("geolocation", undefined));
    assert.isFalse(holds("clipboard-read", undefined));
  });
});
