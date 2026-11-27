// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileDetail } from "@j3-bots/client-runtime/wording";
import type { Attachment } from "@j3-bots/contracts";
import { ExternalLink, FileWarning, X } from "lucide-react-native";
import { type ReactElement, useState } from "react";
import { FlatList, Image, PixelRatio, Pressable, StatusBar, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import {
  type DocumentState,
  factsOfState,
  type PageSize,
  pdfIsCut,
  useDocument,
  usePdfPage,
} from "../platform/documents.ts";
import { Text } from "../text.tsx";
import { useColor } from "../theme.ts";
import { Button } from "../ui.tsx";
import { DocumentContentView } from "./DocumentContent.tsx";

const hidden = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

/**
 * A document over everything, read in the app: a PDF's pages, a Word or
 * Markdown document as its text, a spreadsheet or CSV file as its cells, a
 * presentation as its slides. Its bar is the image viewer's: Close, its name
 * and what it is, and a button that opens it in another app.
 */
export function DocumentViewer({
  attachment,
  onClose,
  onOpenElsewhere,
}: {
  readonly attachment: Attachment;
  readonly onClose: () => void;
  readonly onOpenElsewhere: (attachment: Attachment) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const insets = useSafeAreaInsets();
  const state = useDocument(attachment, true) ?? { _tag: "loading" };
  const ink = useColor("accent-viewer-foreground");
  const ripple = { color: useColor("accent-viewer-pressed"), borderless: true, radius: 24 };
  const { name } = attachment;
  return (
    <View className="flex-1 bg-viewer">
      <StatusBar barStyle="light-content" />
      <View
        style={{ paddingTop: insets.top }}
        className="z-10 flex-row items-center gap-1 bg-viewer-bar px-2 pb-1"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("document.close")}
          onPress={onClose}
          android_ripple={ripple}
          className="size-12 items-center justify-center rounded-full"
        >
          <X size={22} color={ink} {...hidden} />
        </Pressable>
        <View className="min-w-0 flex-1">
          <Text numberOfLines={1} className="text-base font-medium text-viewer-foreground">
            {name}
          </Text>
          <Text numberOfLines={1} className="text-xs text-viewer-muted-foreground">
            {fileDetail(attachment, i18n, factsOfState(state))}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("document.openAction")}
          onPress={() => onOpenElsewhere(attachment)}
          android_ripple={ripple}
          className="size-12 items-center justify-center rounded-full"
        >
          <ExternalLink size={20} color={ink} {...hidden} />
        </Pressable>
      </View>
      <View className="flex-1">
        <Body
          state={state}
          attachment={attachment}
          onOpenElsewhere={() => onOpenElsewhere(attachment)}
        />
      </View>
      <View style={{ height: insets.bottom }} />
    </View>
  );
}

function Body({
  state,
  attachment,
  onOpenElsewhere,
}: {
  readonly state: DocumentState;
  readonly attachment: Attachment;
  readonly onOpenElsewhere: () => void;
}) {
  const { t } = useI18n();
  switch (state._tag) {
    case "loading":
      return <Status>{t("file.opening")}</Status>;
    case "unreachable":
      return <Status>{t("file.unreachable", { name: attachment.name })}</Status>;
    case "tooBig":
    case "unreadable":
      return (
        <NotShown
          text={t(state._tag === "tooBig" ? "document.tooBig" : "document.unreadable")}
          onOpenElsewhere={onOpenElsewhere}
        />
      );
    case "pdf":
      return (
        <PdfPages uri={state.uri} pages={state.pages} header={pdfIsCut(state) ? <Cut /> : null} />
      );
    case "content": {
      const { content } = state;
      const cut =
        content.cut || (content._tag === "sheets" && content.sheets.some((sheet) => sheet.cut));
      return <DocumentContentView content={content} header={cut ? <Cut /> : null} />;
    }
  }
}

function Status({ children }: { readonly children: string }) {
  return (
    <View className="flex-1 items-center justify-center px-6">
      <Text
        accessibilityLiveRegion="polite"
        className="text-center text-sm text-viewer-muted-foreground"
      >
        {children}
      </Text>
    </View>
  );
}

/** The line above a document that shows only its beginning. */
function Cut() {
  const { t } = useI18n();
  return (
    <Text className="bg-viewer px-4 py-2 text-center text-xs text-viewer-muted-foreground">
      {t("document.cut")} {t("document.elsewhere.open")}
    </Text>
  );
}

/** Why a document does not show here, and the way to see it elsewhere: another app. */
function NotShown({
  text,
  onOpenElsewhere,
}: {
  readonly text: string;
  readonly onOpenElsewhere: () => void;
}) {
  const { t } = useI18n();
  return (
    <View className="flex-1 items-center justify-center px-6">
      <View
        accessibilityLiveRegion="polite"
        className="w-full max-w-sm items-center gap-3 rounded-lg bg-background p-6"
      >
        <Icon icon={FileWarning} size={24} color="accent-muted-foreground" />
        <Text className="text-center text-sm text-foreground">{text}</Text>
        <Text className="text-center text-sm text-muted-foreground">
          {t("document.elsewhere.open")}
        </Text>
        <Button variant="primary" label={t("document.openAction")} onPress={onOpenElsewhere} />
      </View>
    </View>
  );
}

// The widest a page is drawn, in pixels, and the step its width is rounded up
// to, so a page drawn once serves the next time at about the same width.
const MOST_PIXELS = 2400;
const PIXEL_STEP = 256;

/** How many pixels wide to draw a page shown `width` px wide. */
const pixelsFor = (width: number) =>
  Math.min(
    MOST_PIXELS,
    Math.ceil(PixelRatio.getPixelSizeForLayoutSize(width) / PIXEL_STEP) * PIXEL_STEP,
  );

/**
 * A PDF's pages, one under the other, as wide as the screen. A page is drawn
 * as it comes near the screen, by Android's renderer, and let go of as the
 * list leaves it behind.
 */
function PdfPages({
  uri,
  pages,
  header,
}: {
  readonly uri: string;
  readonly pages: ReadonlyArray<PageSize>;
  readonly header: ReactElement | null;
}) {
  const [width, setWidth] = useState(0);
  // Its gutter on each side, in px.
  const gutter = 8;
  const pageWidth = Math.max(0, width - gutter * 2);
  return (
    <FlatList
      data={pages}
      keyExtractor={(_, index) => String(index)}
      onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))}
      renderItem={({ item, index }) =>
        pageWidth > 0 ? <PdfPage uri={uri} index={index} size={item} width={pageWidth} /> : null
      }
      ListHeaderComponent={header ?? undefined}
      initialNumToRender={2}
      windowSize={5}
      contentContainerStyle={{ padding: gutter, gap: gutter }}
      className="flex-1"
    />
  );
}

function PdfPage({
  uri,
  index,
  size,
  width,
}: {
  readonly uri: string;
  readonly index: number;
  readonly size: PageSize;
  readonly width: number;
}) {
  const { t } = useI18n();
  const drawing = usePdfPage(uri, index, pixelsFor(width), true);
  // As the renderer draws it: no taller than four times its width.
  const height = Math.round(width * Math.min(size.height / Math.max(size.width, 1), 4));
  return (
    <View style={{ width, height }} className="overflow-hidden rounded-sm bg-white">
      {drawing._tag === "drawn" && (
        <Image
          source={{ uri: drawing.uri }}
          accessibilityLabel={t("document.page", { number: String(index + 1) })}
          style={{ width, height }}
        />
      )}
    </View>
  );
}
