// SPDX-License-Identifier: AGPL-3.0-or-later
import { Cell } from "@j3-bots/client-runtime";
import { openTemplateFile, type TemplateRead } from "@j3-bots/client-runtime/presentation";
import { useReadable } from "@j3-bots/client-runtime/react";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { useMemo } from "react";
import { Linking, Platform } from "react-native";

const UNREADABLE: TemplateRead = { _tag: "unreadable" };

/**
 * The template file the operator opened and has not yet created a bot from
 * or let go. Only the latest waits: opening another replaces it. It is kept
 * in memory and never sent: nothing is created until the operator presses
 * Create on its preview.
 */
const opened = new Cell<TemplateRead | null>(null);

/**
 * Reads the file at `uri` as a template and makes it the one waiting. `size`
 * is the system's, when it gave one; a file over the limit is never read.
 */
export const openTemplateAt = async (uri: string, size?: number | null): Promise<void> => {
  const read = await (async () => {
    try {
      const file = new File(uri);
      return await openTemplateFile(size ?? file.size, () => file.text());
    } catch {
      return UNREADABLE;
    }
  })();
  opened.set(read);
};

/**
 * The system's document picker, for one file to open as a template. Any type
 * is offered: Android knows no media type for `.j3bot`, so a template the
 * operator saved reads as any other file. Nothing waits when they pick none.
 */
export async function pickTemplate(): Promise<void> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    multiple: false,
    copyToCacheDirectory: true,
  });
  const asset = result.canceled ? undefined : result.assets[0];
  if (asset !== undefined) await openTemplateAt(asset.uri, asset.size);
}

/** A file the system asks the app to view: a `content:` or `file:` link, never one of the app's own. */
const isFileLink = (url: string) => url.startsWith("content://") || url.startsWith("file://");

/**
 * Opens as a template each file the system asks the app to view, as a
 * template file tapped in a mail or a chat, which reaches the app by its
 * media type (`app.config.ts`): the one that started it, then each one after.
 * Android only, as receiving shares is.
 */
export const receiveViewedTemplates = (): void => {
  if (Platform.OS !== "android") return;
  void Linking.getInitialURL().then((url) => {
    if (typeof url === "string" && isFileLink(url)) void openTemplateAt(url);
  });
  Linking.addEventListener("url", ({ url }) => {
    if (isFileLink(url)) void openTemplateAt(url);
  });
};

/** The template file waiting for the operator, with a way to let it go, or null. */
export interface OpenedTemplate {
  readonly read: TemplateRead;
  /** Lets this file go, unless another was opened since. */
  readonly dismiss: () => void;
}

export function useOpenedTemplate(): OpenedTemplate | null {
  const read = useReadable(opened);
  return useMemo(
    () =>
      read === null
        ? null
        : {
            read,
            dismiss: () => {
              if (opened.get() === read) opened.set(null);
            },
          },
    [read],
  );
}
