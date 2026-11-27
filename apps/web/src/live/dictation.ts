// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VoiceClient } from "@j3-bots/client-runtime";
import { dictationPath } from "@j3-bots/client-runtime/presentation";
import type { VoiceSettings } from "@j3-bots/contracts";
import type { DictationSource, OpenMicrophone } from "../components/Dictation";
import { useLoadedHandle } from "../lib/useLoadedHandle";

/**
 * Dictation for this page's composers, or undefined where there is none: a
 * server whose settings carry no `voice` is older than dictation through it,
 * and a browser or the desktop app has no recognizer of its own. The server's
 * status is followed only from a server that has it, to say why it cannot
 * dictate now.
 */
export function useDictationSource({
  voice,
  settings,
  microphone,
  app,
}: {
  readonly voice: Pick<VoiceClient, "openStatus" | "dictate">;
  /** The server's dictation settings; null while they load, and from an older server. */
  readonly settings: VoiceSettings | null;
  readonly microphone: OpenMicrophone;
  readonly app: DictationSource["app"];
}): DictationSource | undefined {
  const status = useLoadedHandle(settings === null ? null : voice.openStatus);
  if (settings === null) return undefined;
  const reach = dictationPath({
    place: settings.place,
    device: "none",
    status,
    secureContext: window.isSecureContext,
  });
  return reach._tag === "server" || reach._tag === "blocked"
    ? { reach, dictate: voice.dictate, microphone, app }
    : undefined;
}
