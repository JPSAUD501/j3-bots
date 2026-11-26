// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileIcon, type FileIcon, showsImage } from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import { fileDetail } from "@j3-bots/client-runtime/wording";
import type { Attachment } from "@j3-bots/contracts";
import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileText,
  type LucideIcon,
} from "lucide-react-native";
import { use } from "react";
import { Image, Pressable, View } from "react-native";
import { Text } from "../text.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { useImageFile } from "../platform/images.ts";
import { useColor } from "../theme.ts";
import { useFileOpener } from "./FileOpener.tsx";
import { inlineChip } from "./inlineChip.ts";
import { EntryWidths } from "./widths.ts";

const kindIcons = {
  image: FileImage,
  text: FileText,
  archive: FileArchive,
  code: FileCode,
  other: File,
} as const satisfies Record<FileIcon, LucideIcon>;

/**
 * A file in the conversation: its image or its kind, its name and size.
 * Pressing it opens it (`FileOpener`); while its bytes come, it says it is
 * opening and takes no second press.
 */
export function FileCard({ attachment }: { readonly attachment: Attachment }) {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const opener = useFileOpener();
  const widths = use(EntryWidths);
  const image = useImageFile(client, attachment);
  const opening = opener.opening(attachment);
  const { name } = attachment;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("file.open", { name })}
      accessibilityHint={fileDetail(attachment, i18n)}
      accessibilityState={{ busy: opening }}
      onPress={opening ? undefined : () => opener.open(attachment)}
      style={{ width: Math.min(256, widths.bubble) }}
      className="flex-row items-center gap-3 rounded-md border border-border bg-surface px-3 py-2"
    >
      {image._tag === "shown" ? (
        <Image source={{ uri: image.uri }} className="size-10 rounded-md bg-muted" />
      ) : (
        <View className="size-10 items-center justify-center rounded-md bg-muted">
          <FileKindIcon mediaType={attachment.mediaType} />
        </View>
      )}
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-sm font-medium text-foreground">
          {name}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {opening ? t("file.opening") : fileDetail(attachment, i18n)}
        </Text>
      </View>
    </Pressable>
  );
}

/** The icon of a file's kind. */
function FileKindIcon({
  mediaType,
  size = 16,
  color = "accent-muted-foreground",
}: {
  readonly mediaType: string;
  readonly size?: number;
  readonly color?: string;
}) {
  return <Icon icon={kindIcons[fileIcon(mediaType)]} size={size} color={color} />;
}

/**
 * A file where it stands in a message's text: its image or its kind, and its
 * name, on a quiet tint of the bubble's text color (`color`). Pressing it opens it.
 */
export function InlineFile({
  attachment,
  color,
}: {
  readonly attachment: Attachment;
  /** The bubble's text color, as a theme `accent-` class. */
  readonly color: string;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const opener = useFileOpener();
  const image = useImageFile(client, attachment);
  const ink = useColor(color);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("file.open", { name: attachment.name })}
      onPress={() => opener.open(attachment)}
      style={inlineChip}
      className="mx-0.5 max-w-56 flex-row items-center gap-1 overflow-hidden rounded-md ps-0.5 pe-1.5"
    >
      <View
        style={{ backgroundColor: ink, opacity: 0.14 }}
        className="absolute inset-0 rounded-md"
      />
      {image._tag === "shown" ? (
        <Image source={{ uri: image.uri }} className="size-5 rounded-sm" />
      ) : (
        <View className="size-5 items-center justify-center">
          <FileKindIcon mediaType={attachment.mediaType} color={color} />
        </View>
      )}
      <Text numberOfLines={1} style={{ color: ink }} className="shrink text-sm font-medium">
        {attachment.name}
      </Text>
    </Pressable>
  );
}

/**
 * A file a message carries: an image as a photo, large enough to see what it
 * is, in a frame of fixed size, so the conversation never moves as it
 * arrives; pressing it shows it whole. Any other file, and an image that
 * cannot be had, as its card.
 */
export function MessageFile({ attachment }: { readonly attachment: Attachment }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const opener = useFileOpener();
  const widths = use(EntryWidths);
  const image = useImageFile(client, attachment);
  if (!showsImage(attachment) || image._tag === "failed") {
    return <FileCard attachment={attachment} />;
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("file.open", { name: attachment.name })}
      onPress={() => opener.open(attachment)}
      style={{ width: Math.min(240, widths.bubble), height: 176 }}
      className="overflow-hidden rounded-md border border-border bg-muted"
    >
      {image._tag === "shown" && (
        <Image source={{ uri: image.uri }} resizeMode="cover" style={{ flex: 1 }} />
      )}
    </Pressable>
  );
}
