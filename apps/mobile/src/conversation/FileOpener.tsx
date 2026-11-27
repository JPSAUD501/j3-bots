// SPDX-License-Identifier: AGPL-3.0-or-later
import { documentKind } from "@j3-bots/client-runtime/documents";
import { showsImage } from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { Attachment, WorkImageId } from "@j3-bots/contracts";
import { reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { Share2, X } from "lucide-react-native";
import { createContext, type ReactNode, use, useState } from "react";
import { Image, Modal, PanResponder, Pressable, StatusBar, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useI18n } from "../i18n.ts";
import { drawsPdfs } from "../platform/documents.ts";
import { type ImageSource, useImage } from "../platform/images.ts";
import { openAttachment } from "../platform/openFile.ts";
import { Text } from "../text.tsx";
import { useColor } from "../theme.ts";
import { useSay } from "../toast.tsx";
import { DocumentViewer } from "./DocumentViewer.tsx";

/** Opens a file the app shows; whether it is opening, which takes no second press. */
interface FileOpener {
  readonly open: (attachment: Attachment) => void;
  readonly opening: (attachment: Attachment) => boolean;
  /** Shows large an image a step of a bot's work looked at. */
  readonly openWorkImage: (id: WorkImageId) => void;
}

const OpenerContext = createContext<FileOpener | null>(null);

/** Whether the app's own viewer reads a file: a document of a kind it reads, on a phone that draws it. */
const readsInApp = (attachment: Attachment) => {
  const kind = documentKind(attachment);
  return kind !== null && (kind !== "pdf" || drawsPdfs);
};

/**
 * Opens the files the app shows, in a conversation or a bot's details: an
 * image shows over everything, as large as the screen allows, and pinches or
 * a double tap zoom it; a document the app reads (a PDF, text, a table, a
 * spreadsheet, a Word document or a presentation) shows over everything in
 * the document viewer; any other file opens in the system's viewer for its
 * type, or the share sheet when no app views it.
 */
export function FileOpenerProvider({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const [viewing, setViewing] = useState<ImageSource | null>(null);
  const [reading, setReading] = useState<Attachment | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const inSystem = (attachment: Attachment) => {
    const { name, id } = attachment;
    setBusy((held) => new Set(held).add(id));
    void openAttachment(client, attachment)
      .then((outcome) => {
        switch (outcome) {
          case "gone":
            return say(t("file.gone", { name }));
          case "unreachable":
            return say(t("file.unreachable", { name }));
          case "too-large":
            return say(t("file.tooLarge", { name }));
          case "failed":
            return say(t("file.cannotOpen", { name }));
          // Opened; or the pairing ended, and the pairing screen says so.
          case "opened":
          case "not-paired":
            return;
        }
      })
      .finally(() =>
        setBusy((held) => {
          const next = new Set(held);
          next.delete(id);
          return next;
        }),
      );
  };
  const opener: FileOpener = {
    open: (attachment) => {
      if (busy.has(attachment.id)) return;
      if (showsImage(attachment)) setViewing({ _tag: "file", attachment });
      else if (readsInApp(attachment)) setReading(attachment);
      else inSystem(attachment);
    },
    opening: (attachment) => busy.has(attachment.id),
    openWorkImage: (id) => setViewing({ _tag: "work", id }),
  };
  return (
    <OpenerContext value={opener}>
      {children}
      <Modal
        visible={viewing !== null}
        transparent
        statusBarTranslucent
        navigationBarTranslucent
        animationType="fade"
        onRequestClose={() => setViewing(null)}
      >
        {viewing !== null && (
          <ImageViewer
            key={viewing._tag === "file" ? viewing.attachment.id : viewing.id}
            source={viewing}
            onClose={() => setViewing(null)}
            onShare={inSystem}
          />
        )}
      </Modal>
      <Modal
        visible={reading !== null}
        transparent
        statusBarTranslucent
        navigationBarTranslucent
        animationType="fade"
        onRequestClose={() => setReading(null)}
      >
        {reading !== null && (
          <DocumentViewer
            key={reading.id}
            attachment={reading}
            onClose={() => setReading(null)}
            onOpenElsewhere={inSystem}
          />
        )}
      </Modal>
    </OpenerContext>
  );
}

/** The app's file opener. */
export function useFileOpener(): FileOpener {
  const opener = use(OpenerContext);
  if (opener === null) throw new Error("useFileOpener needs a FileOpenerProvider.");
  return opener;
}

const hidden = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

// How far an image zooms in, and how far a double tap takes it.
const MAX_ZOOM = 5;
const TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 280;

interface Touch {
  readonly pageX: number;
  readonly pageY: number;
}

const spread = (one: Touch, other: Touch) =>
  Math.hypot(one.pageX - other.pageX, one.pageY - other.pageY);

/**
 * An image over everything, on black, zoomed by pinching or a double tap and
 * moved by a drag: a file's, which can be shared, or one a bot looked at.
 */
function ImageViewer({
  source,
  onClose,
  onShare,
}: {
  readonly source: ImageSource;
  readonly onClose: () => void;
  readonly onShare: (attachment: Attachment) => void;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const insets = useSafeAreaInsets();
  const image = useImage(client, source);
  const name = source._tag === "file" ? source.attachment.name : t("work.image.title");
  const ink = useColor("accent-viewer-foreground");
  const ripple = { color: useColor("accent-viewer-pressed"), borderless: true, radius: 24 };
  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const zoomed = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }, { scale: scale.get() }],
  }));
  // Where the gesture started: the zoom and offset then, and the fingers' spread or position.
  const start = useSharedValue({
    scale: 1,
    x: 0,
    y: 0,
    spread: 0,
    pageX: 0,
    pageY: 0,
    pinching: false,
  });
  const lastTap = useSharedValue(0);
  const settle = (to: number) => {
    const spring = reanimatedSpring(springs.soft);
    scale.set(withSpring(to, spring));
    if (to === 1) {
      x.set(withSpring(0, spring));
      y.set(withSpring(0, spring));
    }
  };
  // Made once: its handlers read the gesture's start, and the zoom, as they run.
  const [responder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        const touches = event.nativeEvent.touches;
        const [first] = touches;
        start.set({
          scale: scale.get(),
          x: x.get(),
          y: y.get(),
          spread: 0,
          pageX: first?.pageX ?? 0,
          pageY: first?.pageY ?? 0,
          pinching: false,
        });
      },
      onPanResponderMove: (event) => {
        const [one, other] = event.nativeEvent.touches;
        if (one !== undefined && other !== undefined) {
          if (!start.get().pinching) {
            start.set({
              ...start.get(),
              scale: scale.get(),
              spread: spread(one, other),
              pinching: true,
            });
          }
          const next = (start.get().scale * spread(one, other)) / start.get().spread;
          scale.set(Math.min(Math.max(next, 0.8), MAX_ZOOM));
        } else if (one !== undefined && !start.get().pinching && scale.get() > 1) {
          x.set(start.get().x + one.pageX - start.get().pageX);
          y.set(start.get().y + one.pageY - start.get().pageY);
        }
      },
      onPanResponderRelease: (event, gesture) => {
        const pinched = start.get().pinching;
        if (scale.get() < 1) settle(1);
        if (pinched || Math.abs(gesture.dx) > 8 || Math.abs(gesture.dy) > 8) return;
        // A tap: a second one soon after zooms in, or back out.
        const now = event.nativeEvent.timestamp;
        if (now - lastTap.get() < DOUBLE_TAP_MS) {
          lastTap.set(0);
          settle(scale.get() > 1 ? 1 : TAP_ZOOM);
        } else {
          lastTap.set(now);
        }
      },
    }),
  );
  return (
    <View className="flex-1 bg-viewer">
      <StatusBar barStyle="light-content" />
      <View
        style={{ paddingTop: insets.top }}
        className="z-10 flex-row items-center gap-1 bg-viewer-bar px-2 pb-1"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("file.viewer.close")}
          onPress={onClose}
          android_ripple={ripple}
          className="size-12 items-center justify-center rounded-full"
        >
          <X size={22} color={ink} {...hidden} />
        </Pressable>
        <Text numberOfLines={1} className="flex-1 text-base font-medium text-viewer-foreground">
          {name}
        </Text>
        {source._tag === "file" && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("file.share", { name })}
            onPress={() => onShare(source.attachment)}
            android_ripple={ripple}
            className="size-12 items-center justify-center rounded-full"
          >
            <Share2 size={20} color={ink} {...hidden} />
          </Pressable>
        )}
      </View>
      <View className="flex-1 overflow-hidden" {...responder.panHandlers}>
        {image._tag !== "shown" ? (
          <View className="flex-1 items-center justify-center px-6">
            <Text
              accessibilityLiveRegion="polite"
              className="text-center text-sm text-viewer-muted-foreground"
            >
              {image._tag === "failed"
                ? source._tag === "file"
                  ? t("file.unreachable", { name })
                  : t("work.image.unavailable")
                : t("file.opening")}
            </Text>
          </View>
        ) : (
          <Animated.View style={[{ flex: 1 }, zoomed]}>
            <Image
              source={{ uri: image.uri }}
              accessibilityLabel={name}
              resizeMode="contain"
              style={{ flex: 1 }}
            />
          </Animated.View>
        )}
      </View>
      <View style={{ height: insets.bottom }} />
    </View>
  );
}
