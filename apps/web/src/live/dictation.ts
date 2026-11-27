// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VoiceClient } from "@j3-bots/client-runtime";
import { dictationPath } from "@j3-bots/client-runtime/presentation";
import type { VoiceSettings } from "@j3-bots/contracts";
import type { DictationSource, OpenMicrophone } from "../components/Dictation";
import { useLoadedHandle } from "../lib/useLoadedHandle";

/**
 * Dictation for this page's composers, or undefined where there is none: a
 * browser or the desktop app has no recognizer of its own, so it dictates
 * only through a server that sends the recording to a dictation service
 * (its settings carry `voice.provider`). Which services have a key saved is
 * followed only from such a server, so the microphone knows when set-up is
 * missing.
 */
export function useDictationSource({
  voice,
  settings,
  microphone,
  app,
  setUp,
}: {
  readonly voice: Pick<VoiceClient, "openCloudKeys" | "dictate">;
  /** The server's dictation settings; null while they load, and from an older server. */
  readonly settings: VoiceSettings | null;
  readonly microphone: OpenMicrophone;
  readonly app: DictationSource["app"];
  readonly setUp?: (() => void) | undefined;
}): DictationSource | undefined {
  const keys = useLoadedHandle(settings?.provider === undefined ? null : voice.openCloudKeys);
  const reach = dictationPath({
    voice: settings,
    device: "none",
    keys,
    secureContext: window.isSecureContext,
  });
  return reach._tag === "server" || reach._tag === "blocked"
    ? { reach, dictate: voice.dictate, microphone, app, setUp }
    : undefined;
}
