// SPDX-License-Identifier: AGPL-3.0-or-later
import { AttachmentId, WorkImageId } from "@j3-bots/contracts";
import type { ImageSource } from "../components/attachmentImages";

/** The images the gallery's steps looked at: one that shows, one still arriving, one gone. */
export const GALLERY_WORK_IMAGES = {
  shown: WorkImageId.make("wimg_galleryshown"),
  loading: WorkImageId.make("wimg_galleryloading"),
  gone: WorkImageId.make("wimg_gallerygone"),
} as const;

/** A picture a bot sent, as an attachment of its message. */
export const GALLERY_PHOTO = AttachmentId.make("v-photo");

// A fictional screenshot: a bar chart on a light page.
const CHART = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
<rect width="320" height="200" fill="#f6f4ef"/>
<rect x="24" y="20" width="120" height="10" rx="5" fill="#c9c3b6"/>
<g fill="#5b7fd6"><rect x="40" y="110" width="36" height="66" rx="4"/><rect x="96" y="80" width="36" height="96" rx="4"/>
<rect x="152" y="58" width="36" height="118" rx="4"/><rect x="208" y="96" width="36" height="80" rx="4"/></g>
<rect x="264" y="40" width="36" height="136" rx="4" fill="#e2884c"/>
<rect x="24" y="176" width="280" height="2" fill="#c9c3b6"/></svg>`;

/** The gallery's stand-in for the server's images: its photo, and its steps'. */
export const galleryImage = (source: ImageSource): Promise<Blob | null> => {
  if (source._tag === "file") {
    return Promise.resolve(
      source.attachment.id === GALLERY_PHOTO ? new Blob([CHART], { type: "image/svg+xml" }) : null,
    );
  }
  switch (source.id) {
    case GALLERY_WORK_IMAGES.shown:
      return Promise.resolve(new Blob([CHART], { type: "image/svg+xml" }));
    case GALLERY_WORK_IMAGES.loading:
      return new Promise(() => {});
    default:
      return Promise.resolve(null);
  }
};
