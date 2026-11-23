// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DraftFile, targetKey } from "@j3-bots/client-runtime";
import {
  draftFileName,
  draftReadiness,
  EVERYONE,
  followFieldEdit,
  insertMention,
  type Mentionable,
  mentionOptions,
  mentionQuery,
  type MentionOption,
} from "@j3-bots/client-runtime/presentation";
import { useDraft, useJ3Client, useReadable, useRestored } from "@j3-bots/client-runtime/react";
import {
  draftFileDetail,
  fileProblemText,
  messageProblemText,
} from "@j3-bots/client-runtime/wording";
import type { Avatar, EntryTarget } from "@j3-bots/contracts";
import { layout, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { ArrowUp, File, Plus, Users, X } from "lucide-react-native";
import { type ComponentRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AccessibilityInfo, Alert, ScrollView, View } from "react-native";
import { Text, TextInput } from "../text.tsx";
import { AvatarShape } from "../components/Avatar.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { type PickedFile, pickDocuments, pickPhotos } from "../platform/pick.ts";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { enteringWhen, settleIn } from "../motion.ts";
import { useColor } from "../theme.ts";
import { DictationButton, DictationLine, useDictation } from "./Dictation.tsx";
import { AnimatedView } from "./animated.ts";
import { PressScale } from "../press.tsx";
import { useTint } from "./tint.ts";

/** A room member the composer offers after `@`, drawn by its shape. */
export interface MentionCandidate extends Mentionable {
  readonly avatar: Avatar;
}

/**
 * The composer at the bottom of a conversation, a rounded rectangle that
 * grows with its text, bound to the conversation's draft: what anything else writes to the draft, text or files, shows here.
 * Files picked upload at once and show above the pill; the message goes once
 * they all have. A message over a limit of `message.send` is kept, and says
 * why instead of sending. While Send hands the draft over, or the drafts load
 * or could not be read, the field takes no change, and attaching and removing
 * files are unavailable. In a room, `@` offers its members and `@everyone`
 * above the composer; only a pick mentions one, and a quiet line under it
 * says who the message wakes. While the field has focus the composer's border
 * takes the conversation's tint (`tint`, the bot's avatar; none in a room). While there is nothing to send, the trailing
 * button dictates where the platform has a speech recognizer: what is heard
 * becomes the draft's text as it is heard, and waits there for Send. Typing
 * stops it, and so does the conversation leaving the operator's view. Mount
 * one per conversation.
 */
export function Composer({
  target,
  recipient,
  mentionable,
  addressee,
  onSend,
  inView,
  tint: tintOf = null,
}: {
  readonly target: EntryTarget;
  /** Who the message goes to: a bot's or a room's name. */
  readonly recipient: string;
  /** In a room, its members, which `@` offers. */
  readonly mentionable?: ReadonlyArray<MentionCandidate>;
  /** In a room, who the message wakes as it stands. */
  readonly addressee?: string;
  readonly onSend: () => void;
  /** The operator can see the conversation: its screen has the focus, and the app is in front. */
  readonly inView: boolean;
  /** The bot whose color tints the composer; none in a room. */
  readonly tint?: Avatar | null;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const draft = useDraft(target);
  const switching = useReadable(client.draftsSwitching);
  const readFailed = useReadable(client.draftsReadFailed);
  const notSaved = useReadable(client.draftsNotSaved).has(targetKey(target));
  const field = useRef<ComponentRef<typeof TextInput>>(null);
  const placeholderColor = useColor("accent-muted-foreground");

  const { text, mentions, files } = draft;
  const label = t("composer.label", { name: recipient });
  const { empty, uploading, sendable, problem } = draftReadiness(text, files);
  // The draft takes no change while it is handed over, loads, or could not be read.
  const frozen = draft.sending || switching || readFailed;
  // Files the draft already held when shown appear in place; only those attached since arrive.
  const restored = useRestored(
    targetKey(target),
    files.map((file) => file.key),
    switching || readFailed,
  );
  // Dictation starts only on an empty draft, so what is heard is the whole text.
  const dictation = useDictation({
    onHeard: (heard) => client.setDraftText(target, heard),
    frozen,
    inView,
  });
  const listening = dictation?.state._tag === "listening";
  const ready = !frozen && sendable;
  const tint = useTint(tintOf);
  const [focused, setFocused] = useState(false);
  // Once the draft is handed over and the field is clear, the composer settles back with a pop.
  const settle = useSharedValue(1);
  const settled = useAnimatedStyle(() => ({ transform: [{ scale: settle.get() }] }));
  const wasSending = useRef(draft.sending);
  useEffect(() => {
    const handedOver = wasSending.current && !draft.sending;
    wasSending.current = draft.sending;
    if (handedOver) {
      settle.set(0.97);
      settle.set(withSpring(1, reanimatedSpring(springs.pop)));
    }
  }, [draft.sending, settle]);
  // Files picked while the draft took no change, which it did not take.
  const [notTaken, setNotTaken] = useState(false);

  // The field's selection as the operator last left it: what an edit replaces.
  const selection = useRef<readonly [number, number]>([text.length, text.length]);
  // Where the caret is while the field has focus, collapsed; null otherwise.
  const [caret, setCaret] = useState<number | null>(null);
  // Where the caret goes once the text a pick wrote has reached the field.
  const placeCaret = useRef<{ readonly text: string; readonly at: number } | null>(null);

  const edit = (after: string) => {
    setNotTaken(false);
    dictation?.abort();
    dictation?.dismiss();
    const [start, end] = selection.current;
    const followed = followFieldEdit(
      {
        _tag: "change",
        before: text,
        after,
        // An edit over a selection replaced it; the field does not tell what it wrote.
        over: start < end ? [start, end] : null,
        written: null,
        caret: null,
      },
      mentions,
    );
    client.setDraftText(target, after, followed);
  };

  const members = frozen ? undefined : mentionable;
  const query =
    members === undefined || caret === null ? null : mentionQuery(text, caret, mentions);
  const options =
    query === null || members === undefined ? [] : mentionOptions(query.query, members);
  const pick = (option: MentionOption) => {
    if (query === null || caret === null) return;
    const next = insertMention(text, caret, mentions, query, option);
    // A pick that leaves the text as it was changes nothing in the field: the caret moves now.
    if (next.text === text) moveCaret(next.caret);
    else placeCaret.current = { text: next.text, at: next.caret };
    client.setDraftText(target, next.text, next.mentions);
  };
  const moveCaret = (at: number) => {
    field.current?.setSelection(at, at);
    selection.current = [at, at];
    setCaret(at);
  };
  useLayoutEffect(() => {
    const pending = placeCaret.current;
    if (pending === null || pending.text !== text) return;
    placeCaret.current = null;
    field.current?.setSelection(pending.at, pending.at);
    selection.current = [pending.at, pending.at];
    setCaret(pending.at);
  }, [text]);

  const attach = (picked: ReadonlyArray<PickedFile>) => {
    if (picked.length === 0) return;
    // The draft may have stopped taking changes while the picker was open.
    const stillFrozen =
      client.drafts.get().get(targetKey(target))?.sending === true ||
      client.draftsSwitching.get() ||
      client.draftsReadFailed.get();
    setNotTaken(stillFrozen);
    if (!stillFrozen) client.attachFiles(target, picked);
  };
  const openPicker = () =>
    Alert.alert(t("composer.attach"), undefined, [
      { text: t("composer.attach.photos"), onPress: () => void pickPhotos().then(attach) },
      { text: t("composer.attach.files"), onPress: () => void pickDocuments().then(attach) },
      { text: t("composer.attach.cancel"), style: "cancel" },
    ]);

  // Each read in vain is said again, though the words are the same.
  const retryRead = () =>
    void client.retryDrafts().then((read) => {
      if (read) field.current?.focus();
      else AccessibilityInfo.announceForAccessibility(t("composer.unread"));
    });

  // A file that cannot go is said once, as it fails.
  const failures = files.flatMap((file) =>
    file._tag === "failed"
      ? [
          t("composer.file.failed", {
            name: file.name,
            reason: fileProblemText(file.problem, i18n),
          }),
        ]
      : [],
  );
  const failuresText = failures.join(" ");
  useEffect(() => {
    if (failuresText !== "") AccessibilityInfo.announceForAccessibility(failuresText);
  }, [failuresText]);

  const alert = notTaken
    ? t("composer.waitToAttach")
    : problem === null
      ? null
      : messageProblemText(problem, i18n);

  return (
    <View className="gap-1.5 px-3 pt-1 pb-2">
      {files.length > 0 && (
        <ScrollView
          accessibilityLabel={t("composer.files")}
          className="max-h-28 grow-0"
          contentContainerClassName="flex-row flex-wrap gap-1.5"
          keyboardShouldPersistTaps="handled"
        >
          {files.map((file) => (
            <FileChip
              key={file.key}
              file={file}
              arriving={!restored.has(file.key)}
              onRemove={() => {
                if (!frozen) client.detachFile(target, file.key);
              }}
              unavailable={frozen}
            />
          ))}
        </ScrollView>
      )}
      {/* Drafts that load say nothing: it takes a moment. Drafts that could not be read say so until read. */}
      {readFailed && !switching && (
        <View className="flex-row items-center justify-between gap-2 ps-3">
          <Text className="flex-1 text-xs text-muted-foreground">{t("composer.unread")}</Text>
          <PressScale
            accessibilityRole="button"
            onPress={retryRead}
            className="min-h-11 justify-center px-3"
          >
            <Text className="text-sm text-accent">{t("composer.unread.retry")}</Text>
          </PressScale>
        </View>
      )}
      {query !== null && options.length > 0 && (
        <MentionList options={options} members={mentionable ?? []} onPick={pick} />
      )}
      <AnimatedView
        // Focused, the border takes the bot's color, which reaches 3:1 on the surface.
        style={[settled, focused ? { borderColor: tint.color } : undefined]}
        className="flex-row items-end gap-1 rounded-composer border border-input bg-surface p-1"
      >
        <PressScale
          depth="round"
          accessibilityRole="button"
          accessibilityLabel={t("composer.attach")}
          accessibilityState={{ disabled: frozen }}
          onPress={frozen ? undefined : openPicker}
          className="size-11 items-center justify-center rounded-full active:bg-muted"
        >
          <Icon icon={Plus} size={20} color="accent-muted-foreground" />
        </PressScale>
        <TextInput
          ref={field}
          multiline
          value={text}
          editable={!frozen}
          onChangeText={edit}
          onSelectionChange={({ nativeEvent: { selection: next } }) => {
            selection.current = [next.start, next.end];
            setCaret(next.start === next.end ? next.end : null);
          }}
          onFocus={() => {
            const [start, end] = selection.current;
            setCaret(start === end ? end : null);
            setFocused(true);
          }}
          onBlur={() => {
            setCaret(null);
            setFocused(false);
          }}
          placeholder={label}
          placeholderTextColor={placeholderColor}
          accessibilityLabel={label}
          accessibilityHint={addressee}
          style={{ maxHeight: layout.composerMaxHeight }}
          className="min-h-11 flex-1 px-1 py-2.5 text-lg text-foreground"
        />
        {dictation !== null && (empty || listening) && !draft.sending ? (
          <DictationButton dictation={dictation} unavailable={frozen} />
        ) : (
          <SendButton
            state={draft.sending ? "sending" : ready ? "ready" : "disabled"}
            tint={tint.color}
            hint={uploading ? t("composer.stillUploading") : undefined}
            onSend={onSend}
          />
        )}
      </AnimatedView>
      {dictation !== null && <DictationLine dictation={dictation} />}
      {addressee !== undefined && (
        <Text numberOfLines={1} className="px-3 text-xs text-muted-foreground">
          {addressee}
        </Text>
      )}
      {/* Quiet: it clears by itself once the device keeps the draft. */}
      {notSaved && (
        <Text className="px-3 text-xs text-muted-foreground">{t("composer.notSaved")}</Text>
      )}
      {alert !== null && (
        <Text accessibilityLiveRegion="assertive" className="px-3 text-xs text-blocked">
          {alert}
        </Text>
      )}
    </View>
  );
}

/**
 * Send, in three looks: nothing to send yet, a message ready to go, whose
 * arrow pops in on the bot's color, and one on its way, whose arrow leaves
 * upward with it.
 */
function SendButton({
  state,
  tint,
  hint,
  onSend,
}: {
  readonly state: "disabled" | "ready" | "sending";
  readonly tint: string;
  readonly hint: string | undefined;
  readonly onSend: () => void;
}) {
  const { t } = useI18n();
  const scale = useSharedValue(1);
  const lift = useSharedValue(0);
  const arrow = useAnimatedStyle(() => ({
    opacity: 1 - lift.get(),
    transform: [{ translateY: -14 * lift.get() }, { scale: scale.get() }],
  }));
  useEffect(() => {
    if (state === "ready") {
      lift.set(0);
      scale.set(0.4);
      scale.set(withSpring(1, reanimatedSpring(springs.pop)));
    } else if (state === "sending") {
      lift.set(withTiming(1, { duration: 220, easing: Easing.bezier(0.2, 0.8, 0.2, 1) }));
    } else {
      lift.set(0);
      scale.set(1);
    }
  }, [state, scale, lift]);
  const filled = state !== "disabled";
  return (
    <PressScale
      depth="round"
      accessibilityRole="button"
      accessibilityLabel={t("composer.send")}
      accessibilityHint={hint}
      accessibilityState={{ disabled: state !== "ready", busy: state === "sending" }}
      onPress={state === "ready" ? onSend : undefined}
      style={filled ? { backgroundColor: tint } : undefined}
      className={`size-11 items-center justify-center rounded-full ${filled ? "" : "bg-muted"}`}
    >
      <Animated.View style={arrow}>
        <Icon
          icon={ArrowUp}
          size={20}
          color={filled ? "accent-avatar-ink" : "accent-muted-foreground"}
        />
      </Animated.View>
    </PressScale>
  );
}

/** A file in the draft: its name, how its upload goes or why it cannot go, and a way out. */
function FileChip({
  file,
  arriving,
  onRemove,
  unavailable,
}: {
  readonly file: DraftFile;
  /** Attached since the draft was shown: it settles in. */
  readonly arriving: boolean;
  readonly onRemove: () => void;
  /** The draft takes no change: the file cannot be removed meanwhile. */
  readonly unavailable: boolean;
}) {
  const i18n = useI18n();
  const name = draftFileName(file);
  const failed = file._tag === "failed";
  return (
    <AnimatedView
      {...enteringWhen(arriving, settleIn(springs.soft))}
      className={`max-w-full flex-row items-center gap-2 rounded-md border ps-2 ${
        failed ? "border-blocked/40 bg-blocked-surface" : "border-border bg-surface"
      }`}
    >
      <Icon icon={File} size={16} color="accent-muted-foreground" />
      <View className="min-w-0 shrink py-1">
        <Text numberOfLines={1} className="max-w-48 text-xs font-medium text-foreground">
          {name}
        </Text>
        <Text className={`text-2xs ${failed ? "text-blocked" : "text-muted-foreground"}`}>
          {/* The phone's uploader reports no progress: it refuses redirects instead (`platform/upload.ts`). */}
          {draftFileDetail(file, i18n, { progress: false })}
        </Text>
      </View>
      <PressScale
        accessibilityRole="button"
        accessibilityLabel={i18n.t("composer.file.remove", { name })}
        accessibilityState={{ disabled: unavailable }}
        onPress={unavailable ? undefined : onRemove}
        className="size-11 items-center justify-center"
      >
        <Icon icon={X} size={16} color="accent-muted-foreground" />
      </PressScale>
    </AnimatedView>
  );
}

/** The members and `@everyone` the operator can mention, above the composer. A tap picks. */
function MentionList({
  options,
  members,
  onPick,
}: {
  readonly options: ReadonlyArray<MentionOption>;
  readonly members: ReadonlyArray<MentionCandidate>;
  readonly onPick: (option: MentionOption) => void;
}) {
  const { t } = useI18n();
  const avatars = new Map(members.map((member) => [member.id, member.avatar]));
  return (
    <ScrollView
      accessibilityLabel={t("mention.label")}
      // A tap picks without closing the keyboard.
      keyboardShouldPersistTaps="always"
      className="max-h-60 grow-0 rounded-lg border border-border bg-surface"
      contentContainerClassName="p-1"
    >
      {options.map((option) => {
        const avatar = option._tag === "bot" ? avatars.get(option.id) : undefined;
        return (
          <PressScale
            key={option._tag === "bot" ? option.id : EVERYONE}
            depth="row"
            accessibilityRole="button"
            onPress={() => onPick(option)}
            className="min-h-11 flex-row items-center gap-2 rounded-md px-2 active:bg-muted"
          >
            {option._tag === "bot" ? (
              <>
                {avatar !== undefined && <AvatarShape avatar={avatar} size={20} />}
                <Text numberOfLines={1} className="shrink text-base text-foreground">
                  {option.name}
                </Text>
              </>
            ) : (
              <>
                <Icon icon={Users} size={20} color="accent-muted-foreground" />
                <Text className="text-base text-foreground">@{EVERYONE}</Text>
                <Text numberOfLines={1} className="shrink text-xs text-muted-foreground">
                  {t("mention.everyone")}
                </Text>
              </>
            )}
          </PressScale>
        );
      })}
    </ScrollView>
  );
}
