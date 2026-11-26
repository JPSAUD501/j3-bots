// SPDX-License-Identifier: AGPL-3.0-or-later
import type { J3Client } from "@j3-bots/client-runtime";
import { showsImage } from "@j3-bots/client-runtime/presentation";
import { type Attachment, INLINE_IMAGE_MEDIA_TYPES, type WorkImageId } from "@j3-bots/contracts";
import { type ReactNode, useState } from "react";
import { useI18n } from "../app/context";
import { AttachmentImagesProvider, type ImageSource } from "../components/attachmentImages";
import { ImageViewer } from "../components/ImageViewer";
import { deliverFile, reserveWindow } from "./openFile";

/** The files and images of a conversation, as the page opens them. */
export interface Attachments {
  /** Opens a file: an image shows over the page; any other opens in its own window, or is saved. */
  readonly open: (attachment: Attachment) => void;
  /** Shows large an image a step of a bot's work looked at. */
  readonly openWorkImage: (id: WorkImageId) => void;
  /** Puts away the image that shows over the page, if one does. */
  readonly close: () => void;
  /**
   * Draws `children` with the images of their files within reach, and the
   * image the operator opened over them.
   */
  readonly host: (children: ReactNode) => ReactNode;
}

/** Opens a conversation's files and images with `j3`, saying through `say` when one cannot be. */
export function useAttachments(j3: J3Client, say: (text: string) => void): Attachments {
  const { t } = useI18n();
  // The image a file shows over everything, opened from a conversation.
  const [viewing, setViewing] = useState<ImageSource | null>(null);
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
  return {
    open: (attachment) => {
      if (showsImage(attachment)) setViewing({ _tag: "file", attachment });
      else deliver(attachment, reserveWindow(attachment));
    },
    openWorkImage: (id) => setViewing({ _tag: "work", id }),
    close: () => setViewing(null),
    host: (children) => (
      <AttachmentImagesProvider fetch={imageOf}>
        {children}
        <ImageViewer
          image={viewing}
          onClose={() => setViewing(null)}
          onSave={(attachment) => deliver(attachment, null)}
        />
      </AttachmentImagesProvider>
    ),
  };
}
