// SPDX-License-Identifier: AGPL-3.0-or-later
import { FirstRunProgress } from "@j3-bots/client-runtime/presentation";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Storage } from "expo-sqlite/kv-store";

/**
 * Where this phone left the first run: the step, the name typed and the look
 * picked, so an app put away mid-way picks it up there. It is this phone's
 * alone, kept beside its appearance and language, and goes once the bot exists.
 */
const KEY = "j3:first-run";

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(FirstRunProgress));
const encode = Schema.encodeSync(Schema.fromJsonString(FirstRunProgress));

export function readProgress(): FirstRunProgress | null {
  try {
    return Option.getOrNull(decode(Storage.getItemSync(KEY)));
  } catch {
    // A store that cannot be read starts the first run over.
    return null;
  }
}

export function writeProgress(progress: FirstRunProgress): void {
  try {
    Storage.setItemSync(KEY, encode(progress));
  } catch {
    // The first run goes on; it is just not remembered.
  }
}

export function clearProgress(): void {
  try {
    Storage.removeItemSync(KEY);
  } catch {
    // Nothing was kept.
  }
}
