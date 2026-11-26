// SPDX-License-Identifier: AGPL-3.0-or-later
import { FirstRunProgress } from "@j3-bots/client-runtime/presentation";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Where this browser left the first run: the step, the name typed and the look
 * picked, so a reload or a closed tab picks it up there. It is this browser's
 * alone, and goes once the bot exists.
 */
const KEY = "j3:first-run";

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(FirstRunProgress));
const encode = Schema.encodeSync(Schema.fromJsonString(FirstRunProgress));

export function readProgress(): FirstRunProgress | null {
  try {
    return Option.getOrNull(decode(localStorage.getItem(KEY)));
  } catch {
    // Storage can be unavailable (private windows, blocked site data): the first run starts over.
    return null;
  }
}

export function writeProgress(progress: FirstRunProgress): void {
  try {
    localStorage.setItem(KEY, encode(progress));
  } catch {
    // The first run goes on; it is just not remembered.
  }
}

export function clearProgress(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing was kept.
  }
}
