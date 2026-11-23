// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileIcon, type FileIcon } from "@j3-bots/client-runtime/presentation";
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
import { Pressable, View } from "react-native";
import { Text } from "../text.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { openAttachment } from "../platform/openFile.ts";
import { useSay } from "../toast.tsx";
import { EntryWidths } from "./widths.ts";

const kindIcons = {
  image: FileImage,
  text: FileText,
  archive: FileArchive,
  code: FileCode,
  other: File,
} as const satisfies Record<FileIcon, LucideIcon>;

/**
 * A file in the conversation: name, kind and size. Pressing it opens it in
 * the system's viewer, or the share sheet when no app views its type; while
 * its bytes come, it says it is opening and takes no second press.
 */
export function FileCard({ attachment }: { readonly attachment: Attachment }) {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const say = useSay();
  const widths = use(EntryWidths);
  const [opening, setOpening] = useState(false);
  const { name } = attachment;
  const open = () => {
    setOpening(true);
    void openAttachment(client, attachment)
      .then((outcome) => {
        switch (outcome) {
          case "gone":
            return say(t("file.gone", { name }));
          case "unreachable":
            return say(t("file.unreachable", { name }));
          case "failed":
            return say(t("file.cannotOpen", { name }));
          // Opened; or the pairing ended, and the pairing screen says so.
          case "opened":
          case "not-paired":
            return;
        }
      })
      .finally(() => setOpening(false));
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("file.open", { name })}
      accessibilityHint={fileDetail(attachment, i18n)}
      accessibilityState={{ busy: opening }}
      onPress={opening ? undefined : open}
      style={{ width: Math.min(256, widths.bubble) }}
      className="flex-row items-center gap-3 rounded-md border border-border bg-surface px-3 py-2"
    >
      <View className="size-8 items-center justify-center rounded-md bg-muted">
        <Icon icon={kindIcons[fileIcon(attachment.mediaType)]} color="accent-muted-foreground" />
      </View>
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
