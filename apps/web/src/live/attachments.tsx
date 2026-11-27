// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import { documentKind } from "@j3-bots/client-runtime/documents";
import { showsImage } from "@j3-bots/client-runtime/presentation";
import { type Attachment, INLINE_IMAGE_MEDIA_TYPES, type WorkImageId } from "@j3-bots/contracts";
import { type ReactNode, useState } from "react";
import { useI18n } from "../app/context";
import { AttachmentImagesProvider, type ImageSource } from "../components/attachmentImages";
import { DocumentsProvider } from "../components/documents/documents";
import { DocumentViewer } from "../components/documents/DocumentViewer";
import { ImageViewer } from "../components/ImageViewer";
import { deliverFile, reserveWindow } from "./openFile";

/** The files and images of a conversation, as the page opens them. */
export interface Attachments {
  /**
   * Opens a file: an image or a document shows over the page; any other
   * opens in its own window, or is saved.
   */
  readonly open: (attachment: Attachment) => void;
  /** Shows large an image a step of a bot's work looked at. */
  readonly openWorkImage: (id: WorkImageId) => void;
  /** Puts away the image or document that shows over the page, if one does. */
  readonly close: () => void;
  /**
   * Draws `children` with the images and documents of their files within
   * reach, and the image or document the operator opened over them.
   */
  readonly host: (children: ReactNode) => ReactNode;
}

/** Opens a conversation's files and images with `j3`, saying through `say` when one cannot be. */
export function useAttachments(j3: J3Client, say: (text: string) => void): Attachments {
  const { t, locale } = useI18n();
  // The image or document that shows over everything, opened from a conversation.
  const [viewing, setViewing] = useState<ImageSource | null>(null);
  const [reading, setReading] = useState<Attachment | null>(null);
  /** Shows `attachment` in `reserved`, or saves it, once downloaded; or says why it cannot. */
  const deliver = (attachment: Attachment, reserved: Window | null) =>
    void j3.download(attachment).then((result) => {
      if (result._tag === "done") {
        deliverFile(attachment, result.value.bytes, reserved);
        return;
      }
      reserved?.close();
      say(
        result.reason === "not-found"
          ? t("file.gone", { name: attachment.name })
          : result.reason === "too-large"
            ? t("file.tooLarge", { name: attachment.name })
            : t("file.unreachable", { name: attachment.name }),
      );
    });
  // Only the image types a page draws without running anything get here: a
  // file's by `showsImage`, and one a bot looked at as the server sends only those.
  const imageOf = (source: ImageSource) =>
    (source._tag === "file" ? j3.download(source.attachment) : j3.workImage(source.id)).then(
      (result) => {
        if (result._tag !== "done") return null;
        const type = source._tag === "file" ? source.attachment.mediaType : result.value.mediaType;
        return INLINE_IMAGE_MEDIA_TYPES.includes(type)
          ? new Blob([result.value.bytes], { type })
          : null;
      },
    );
  // A document's bytes, which the page reads itself (components/documents).
  const documentOf = (attachment: Attachment) =>
    j3.download(attachment).then((result) => (result._tag === "done" ? result.value.bytes : null));
  return {
    open: (attachment) => {
      if (showsImage(attachment)) setViewing({ _tag: "file", attachment });
      else if (documentKind(attachment) !== null) setReading(attachment);
      else deliver(attachment, reserveWindow(attachment));
    },
    openWorkImage: (id) => setViewing({ _tag: "work", id }),
    close: () => {
      setViewing(null);
      setReading(null);
    },
    host: (children) => (
      <AttachmentImagesProvider fetch={imageOf}>
        <DocumentsProvider fetch={documentOf} locale={locale}>
          {children}
          <ImageViewer
            image={viewing}
            onClose={() => setViewing(null)}
            onSave={(attachment) => deliver(attachment, null)}
          />
          <DocumentViewer
            attachment={reading}
            onClose={() => setReading(null)}
            onSave={(attachment) => deliver(attachment, null)}
          />
        </DocumentsProvider>
      </AttachmentImagesProvider>
    ),
  };
}
