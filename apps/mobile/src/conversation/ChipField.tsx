// SPDX-License-Identifier: AGPL-3.0-or-later
import type { DraftFile } from "@j3-bots/client-runtime";
import { draftFileName, FILE_MARK } from "@j3-bots/client-runtime/presentation";
import type { AttachmentId, Avatar, BotId } from "@j3-bots/contracts";
import { botBubble, fontFamilies, layout, resolveAvatar, typeScale } from "@j3-bots/design-tokens";
import { hexColor } from "@j3-bots/design-tokens/raster";
import { requireNativeView } from "expo";
import { type ComponentRef, type Ref, useImperativeHandle, useRef, useState } from "react";
import {
  type NativeSyntheticEvent,
  PixelRatio,
  Platform,
  processColor,
  type ViewProps,
} from "react-native";
import { useUniwind } from "uniwind";
import { TextInput } from "../text.tsx";
import { useColor } from "../theme.ts";
import { MENTION_FACE } from "./MentionChip.tsx";
import { mentionFace, roomMentionMark } from "./mentionFace.ts";

/** What the composer does with its field besides typing in it. */
export interface FieldHandle {
  readonly focus: () => void;
  readonly blur: () => void;
  readonly select: (start: number, end: number) => void;
}

/** An edit of the field: its text, each chip as its mark, the chips' order, and the selection after it. */
export interface FieldEdit {
  readonly text: string;
  readonly order: ReadonlyArray<string>;
  readonly selection: readonly [number, number];
}

/**
 * A picked mention the field draws as a chip over its text: where it starts,
 * its text, and what it names, a bot by its face or a room by its mark.
 */
export interface FieldMention {
  readonly at: number;
  readonly text: string;
  readonly of:
    | { readonly _tag: "bot"; readonly botId: BotId; readonly avatar: Avatar }
    | {
        readonly _tag: "room";
        readonly members: ReadonlyArray<{ readonly avatar: Avatar }>;
      };
}

interface FieldProps {
  readonly ref: Ref<FieldHandle>;
  /** The draft's text, with a mark where each file stands. */
  readonly value: string;
  /** The draft's files, in the order of their marks. */
  readonly files: ReadonlyArray<DraftFile>;
  /** The local images of the draft's files that show as images, by file. */
  readonly images: ReadonlyMap<AttachmentId, string>;
  /** The picked mentions that count, drawn as chips where the field can. */
  readonly mentions: ReadonlyArray<FieldMention>;
  readonly placeholder: string;
  /** The words dictation may still change, `[start, end)`, drawn lighter where the field can. */
  readonly open: readonly [number, number] | null;
  readonly editable: boolean;
  readonly label: string;
  readonly onEdit: (edit: FieldEdit) => void;
  readonly onSelection: (selection: readonly [number, number]) => void;
  readonly onFocusChange: (focused: boolean) => void;
  /** A tap on a file's chip. */
  readonly onPressFile: (key: string) => void;
  /** A tap on a file's way out. */
  readonly onRemoveFile: (key: string) => void;
}

/**
 * The composer's field: on Android, editable text in which each file of the
 * draft is a chip where the operator placed it, showing its image or a page,
 * its name and a way out, deleted as one character, and each picked mention
 * a chip over its text: a bot's face on a tint of its color, or a room's mark
 * on a neutral fill. Words dictation may still change are drawn lighter.
 * Elsewhere, where the app has no
 * such field, the text without its marks, its files following it.
 */
export function ChipField(props: FieldProps) {
  return Platform.OS === "android" && NativeChipField !== null ? (
    <AndroidField {...props} />
  ) : (
    <PlainField {...props} />
  );
}

interface NativeChange {
  readonly text: string;
  readonly keys: ReadonlyArray<string>;
  readonly start: number;
  readonly end: number;
  readonly eventCount: number;
}

interface NativeFieldProps extends ViewProps {
  /** The native view, whose methods Expo puts on the component it returns. */
  readonly ref?: Ref<unknown>;
  readonly value: {
    readonly text: string;
    readonly keys: ReadonlyArray<string>;
    readonly mentions: ReadonlyArray<{
      readonly start: number;
      readonly end: number;
      readonly text: string;
      readonly face: string;
      readonly fill: number;
    }>;
    readonly eventCount: number;
    readonly open: { readonly start: number; readonly end: number } | null;
  };
  readonly chips: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly image: string | null;
    readonly state: DraftFile["_tag"];
    readonly removable: boolean;
  }>;
  readonly look: {
    readonly textColor: number;
    readonly mutedColor: number;
    readonly chipBackground: number;
    readonly chipBorder: number;
    readonly failedBackground: number;
    readonly failedText: number;
    readonly mentionText: number;
    readonly fontFamily: string;
    readonly fontSize: number;
    readonly paddingHorizontal: number;
    readonly paddingVertical: number;
  };
  readonly placeholder: string;
  readonly editable: boolean;
  readonly label: string;
  readonly onChangeText: (event: NativeSyntheticEvent<NativeChange>) => void;
  readonly onSelectionChange: (
    event: NativeSyntheticEvent<{ readonly start: number; readonly end: number }>,
  ) => void;
  readonly onFocusChange: (event: NativeSyntheticEvent<{ readonly focused: boolean }>) => void;
  readonly onContentHeight: (event: NativeSyntheticEvent<{ readonly height: number }>) => void;
  readonly onChipPress: (event: NativeSyntheticEvent<{ readonly key: string }>) => void;
  readonly onChipRemove: (event: NativeSyntheticEvent<{ readonly key: string }>) => void;
}

interface NativeFieldMethods {
  focus(): Promise<void>;
  blur(): Promise<void>;
  select(start: number, end: number): Promise<void>;
}

/** The app's own field (`modules/chip-field`), on Android only. */
const NativeChipField =
  Platform.OS === "android" ? requireNativeView<NativeFieldProps>("ChipField") : null;

/** An ARGB color as the native field takes it. */
const argb = (color: string): number => {
  const processed = processColor(color);
  if (typeof processed !== "number") throw new Error(`${color} is not a color.`);
  return processed;
};

// The field's text is a message's, and one line of it with its padding is a
// touch target tall: the composer's round buttons are laid out around that line.
const FONT_SIZE = typeScale.lg.touch.size;
const MIN_HEIGHT = layout.touchTarget;
const PADDING_X = 4;
const PADDING_Y = (MIN_HEIGHT - typeScale.lg.touch.lineHeight) / 2;

function AndroidField({
  ref,
  value,
  files,
  images,
  mentions,
  placeholder,
  open,
  editable,
  label,
  onEdit,
  onSelection,
  onFocusChange,
  onPressFile,
  onRemoveFile,
}: FieldProps) {
  const native = useRef<NativeFieldMethods>(null);
  const theme = useUniwind().theme === "dark" ? "dark" : "light";
  // The newest of the field's edits the draft has taken. The field shows
  // `value` only when it has made no edit since, as React Native's own field
  // does: the draft takes each edit as it is told, so a value that answers an
  // older count is one the operator has typed past.
  const [eventCount, setEventCount] = useState(0);
  const [height, setHeight] = useState<number>(MIN_HEIGHT);
  useImperativeHandle(ref, () => ({
    focus: () => void native.current?.focus(),
    blur: () => void native.current?.blur(),
    select: (start, end) => void native.current?.select(start, end),
  }));
  const look = {
    textColor: argb(useColor("accent-foreground")),
    mutedColor: argb(useColor("accent-muted-foreground")),
    chipBackground: argb(useColor("accent-muted")),
    chipBorder: argb(useColor("accent-border")),
    failedBackground: argb(useColor("accent-blocked-surface")),
    failedText: argb(useColor("accent-blocked")),
    mentionText: argb(useColor("accent-bubble-bot-foreground")),
    fontFamily: fontFamilies.text,
    fontSize: FONT_SIZE,
    paddingHorizontal: PADDING_X,
    paddingVertical: PADDING_Y,
  };
  const Field = NativeChipField;
  if (Field === null) return null;
  return (
    <Field
      // The native view's methods, which Expo puts on the component it returns.
      ref={(view: unknown) => {
        native.current = isFieldMethods(view) ? view : null;
      }}
      value={{
        text: value,
        keys: files.map((file) => file.key),
        mentions: mentions.map(({ at, text, of }) => ({
          start: at,
          end: at + text.length,
          text,
          ...(of._tag === "bot"
            ? {
                face: mentionFace(of.avatar, of.botId, theme, MENTION_FACE, PixelRatio.get()),
                fill: argb(hexColor(botBubble(resolveAvatar(of.avatar).color)[theme])),
              }
            : {
                face: roomMentionMark(of.members, theme, MENTION_FACE, PixelRatio.get()),
                // A room has no color of its own: its chip takes the neutral fill.
                fill: look.chipBackground,
              }),
        })),
        eventCount,
        open: open === null ? null : { start: open[0], end: open[1] },
      }}
      chips={files.map((file) => ({
        key: file.key,
        label: draftFileName(file),
        image: file._tag === "ready" ? (images.get(file.attachment.id) ?? null) : null,
        state: file._tag,
        removable: true,
      }))}
      look={look}
      placeholder={placeholder}
      editable={editable}
      label={label}
      onChangeText={({ nativeEvent }) => {
        setEventCount(nativeEvent.eventCount);
        onEdit({
          text: nativeEvent.text,
          order: nativeEvent.keys,
          selection: [nativeEvent.start, nativeEvent.end],
        });
      }}
      onSelectionChange={({ nativeEvent }) => onSelection([nativeEvent.start, nativeEvent.end])}
      onFocusChange={({ nativeEvent }) => onFocusChange(nativeEvent.focused)}
      onContentHeight={({ nativeEvent }) => setHeight(nativeEvent.height)}
      onChipPress={({ nativeEvent }) => onPressFile(nativeEvent.key)}
      onChipRemove={({ nativeEvent }) => onRemoveFile(nativeEvent.key)}
      style={{
        height: Math.min(Math.max(height, MIN_HEIGHT), layout.composerMaxHeight),
        flex: 1,
      }}
    />
  );
}

const isFieldMethods = (view: unknown): view is NativeFieldMethods =>
  typeof view === "object" &&
  view !== null &&
  "focus" in view &&
  typeof view.focus === "function" &&
  "select" in view &&
  typeof view.select === "function";

/**
 * React Native's own field, where the app has no chip field: the text without
 * its marks. The draft then places its files after the text.
 */
function PlainField({
  ref,
  value,
  placeholder,
  editable,
  label,
  onEdit,
  onSelection,
  onFocusChange,
  files,
}: FieldProps) {
  const field = useRef<ComponentRef<typeof TextInput>>(null);
  const placeholderColor = useColor("accent-muted-foreground");
  useImperativeHandle(ref, () => ({
    focus: () => field.current?.focus(),
    blur: () => field.current?.blur(),
    select: (start, end) => field.current?.setSelection(start, end),
  }));
  const shown = value.replaceAll(FILE_MARK, "");
  return (
    <TextInput
      ref={field}
      multiline
      value={shown}
      editable={editable}
      onChangeText={(text) =>
        onEdit({
          text: text + FILE_MARK.repeat(files.length),
          order: files.map((file) => file.key),
          selection: [text.length, text.length],
        })
      }
      onSelectionChange={({ nativeEvent: { selection } }) =>
        onSelection([selection.start, selection.end])
      }
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
      placeholder={placeholder}
      placeholderTextColor={placeholderColor}
      accessibilityLabel={label}
      style={{ maxHeight: layout.composerMaxHeight }}
      className="min-h-11 flex-1 px-1 py-2.5 text-lg text-foreground"
    />
  );
}
