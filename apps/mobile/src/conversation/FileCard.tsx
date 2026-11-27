// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Block, CARD_PREVIEW_MAX_SIZE, documentKind } from "@j3-bots/client-runtime/documents";
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
import { use, useState } from "react";
import { Image, PixelRatio, Pressable, View } from "react-native";
import { Text } from "../text.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import {
  type DocumentState,
  drawsPdfs,
  factsOfState,
  useDocument,
  usePdfPage,
} from "../platform/documents.ts";
import { useImageFile } from "../platform/images.ts";
import { useColor } from "../theme.ts";
import { Picture, SheetGrid } from "./DocumentContent.tsx";
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
 * arrives; pressing it shows it whole. A document the app reads, small
 * enough to read for its card, as its first page or rows (`DocumentCard`).
 * Any other file, and an image that cannot be had, as its card.
 */
export function MessageFile({ attachment }: { readonly attachment: Attachment }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const opener = useFileOpener();
  const widths = use(EntryWidths);
  const image = useImageFile(client, attachment);
  // Bytes named as an image that do not decode as one show as the file they are.
  const [undrawable, setUndrawable] = useState(false);
  if (!showsImage(attachment) || image._tag === "failed" || undrawable) {
    const kind = documentKind(attachment);
    return kind !== null &&
      (kind !== "pdf" || drawsPdfs) &&
      attachment.size <= CARD_PREVIEW_MAX_SIZE ? (
      <DocumentCard attachment={attachment} />
    ) : (
      <FileCard attachment={attachment} />
    );
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
        <Image
          source={{ uri: image.uri }}
          resizeMode="cover"
          onError={() => setUndrawable(true)}
          style={{ flex: 1 }}
        />
      )}
    </Pressable>
  );
}

// A document card's width and its preview's height, in px.
const CARD_WIDTH = 240;
const PREVIEW_HEIGHT = 112;

/**
 * A document a message carries: the top of its first page, or its first
 * rows, above its name and what it is ("PDF, 12 pages"). It is fetched and
 * read as it comes into the conversation's list, in a frame of fixed size,
 * so the conversation never moves as it arrives. Pressing it shows it whole.
 */
function DocumentCard({ attachment }: { readonly attachment: Attachment }) {
  const i18n = useI18n();
  const { t } = i18n;
  const opener = useFileOpener();
  const widths = use(EntryWidths);
  const document = useDocument(attachment, true);
  const { name } = attachment;
  const width = Math.min(CARD_WIDTH, widths.bubble);
  const detail = fileDetail(
    attachment,
    i18n,
    document === null ? undefined : factsOfState(document),
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("file.open", { name })}
      accessibilityHint={detail}
      onPress={() => opener.open(attachment)}
      style={{ width }}
      className="overflow-hidden rounded-md border border-border bg-surface"
    >
      <View
        {...hidden}
        style={{ height: PREVIEW_HEIGHT }}
        className="overflow-hidden border-b border-border bg-muted"
      >
        <DocumentPreview state={document} mediaType={attachment.mediaType} width={width} />
      </View>
      <View className="px-3 py-2">
        <Text numberOfLines={1} className="text-sm font-medium text-foreground">
          {name}
        </Text>
        <Text numberOfLines={1} className="text-xs text-muted-foreground">
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

const hidden = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

/** The words of a document's first blocks, for its card. */
const firstWords = (blocks: ReadonlyArray<Block>): string =>
  blocks
    .slice(0, 8)
    .map((block) => {
      switch (block._tag) {
        case "heading":
        case "paragraph":
        case "item":
        case "quote":
          return block.runs.map((run) => run.text).join("");
        case "code":
          return block.text;
        case "table":
          return block.rows
            .slice(0, 3)
            .map((row) => row.join("  "))
            .join("\n");
        case "image":
        case "rule":
          return "";
      }
    })
    .filter((text) => text !== "")
    .join("\n");

/** A document's first page or rows, small; its kind's icon when it cannot show them. */
function DocumentPreview({
  state,
  mediaType,
  width,
}: {
  readonly state: DocumentState | null;
  readonly mediaType: string;
  readonly width: number;
}) {
  if (state === null || state._tag === "loading") return null;
  const icon = (
    <View className="flex-1 items-center justify-center">
      <FileKindIcon mediaType={mediaType} size={20} />
    </View>
  );
  const words = (text: string, mono = false) => (
    <View className="flex-1 bg-background px-3 py-2">
      <Text
        face={mono ? "mono" : "text"}
        numberOfLines={8}
        className="text-[9px] leading-tight text-foreground"
      >
        {text}
      </Text>
    </View>
  );
  switch (state._tag) {
    case "pdf": {
      const [first] = state.pages;
      return first === undefined ? icon : <PdfTop uri={state.uri} page={first} width={width} />;
    }
    case "content": {
      const { content } = state;
      switch (content._tag) {
        case "text":
          return words(content.text.slice(0, 800), true);
        case "flow":
          return words(firstWords(content.blocks));
        case "sheets": {
          const [first] = content.sheets;
          return first === undefined ? icon : <SheetGrid sheet={first} rows={6} compact />;
        }
        case "slides": {
          const [first] = content.slides;
          if (first === undefined) return icon;
          const picture = first.blocks.find((block) => block._tag === "image");
          return (
            <View className="flex-1 gap-1 bg-background p-3">
              {first.title !== null && (
                <Text numberOfLines={2} className="text-xs font-semibold text-foreground">
                  {first.title}
                </Text>
              )}
              {picture?._tag === "image" ? (
                <Picture image={picture.image} alt="" height={56} />
              ) : (
                <Text numberOfLines={4} className="text-[9px] leading-tight text-foreground">
                  {firstWords(first.blocks)}
                </Text>
              )}
            </View>
          );
        }
      }
      return icon;
    }
    default:
      return icon;
  }
}

/** The top of a PDF's first page, as wide as the card. */
function PdfTop({
  uri,
  page,
  width,
}: {
  readonly uri: string;
  readonly page: { readonly width: number; readonly height: number };
  readonly width: number;
}) {
  const pixels = Math.min(1024, Math.ceil(PixelRatio.getPixelSizeForLayoutSize(width) / 256) * 256);
  const drawing = usePdfPage(uri, 0, pixels, true);
  const height = Math.round(width * Math.min(page.height / Math.max(page.width, 1), 4));
  return (
    <View className="flex-1 bg-white">
      {drawing._tag === "drawn" && (
        <Image source={{ uri: drawing.uri }} style={{ width, height }} />
      )}
    </View>
  );
}
