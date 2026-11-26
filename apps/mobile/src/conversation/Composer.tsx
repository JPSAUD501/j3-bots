// SPDX-License-Identifier: AGPL-3.0-or-later
import { type DraftMention, targetKey } from "@j3-bots/client-runtime";
import {
  draftReadiness,
  EVERYONE,
  followFieldEdit,
  insertMention,
  markCount,
  placedMessage,
  type Mentionable,
  mentionOptions,
  mentionQuery,
  type MentionOption,
  standingMentions,
} from "@j3-bots/client-runtime/presentation";
import { useDraft, useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import { fileProblemText, messageProblemText } from "@j3-bots/client-runtime/wording";
import type { Attachment, Avatar, EntryTarget } from "@j3-bots/contracts";
import { reanimatedSpring, springs } from "@j3-bots/design-tokens";
import { ArrowUp, File, Images, Plus, Users } from "lucide-react-native";
import { type ComponentRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, ScrollView, View } from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { Text } from "../text.tsx";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { Icon } from "../components/Icon.tsx";
import { Menu, type MenuAnchor } from "../components/Menu.tsx";
import { useI18n } from "../i18n.ts";
import { useImageFiles } from "../platform/images.ts";
import { type PickedFile, pickDocuments, pickPhotos } from "../platform/pick.ts";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import {
  ChipField,
  type FieldEdit,
  type FieldHandle,
  type FieldMention,
  type FieldStatus,
} from "./ChipField.tsx";
import { DictationButton, DictationLine, useDictation } from "./Dictation.tsx";
import { useFileOpener } from "./FileOpener.tsx";
import { AnimatedView } from "./animated.ts";
import { composerButtonFrame, composerButtonSlop } from "./composerButton.ts";
import { appear } from "../motion.ts";
import { PressScale } from "../press.tsx";
import { PromptForm, PromptList, usePromptPicker } from "./PromptPicker.tsx";
import { useTint } from "./tint.ts";

/** A room member the composer offers after `@`, drawn by its shape. */
export interface MentionCandidate extends Mentionable {
  readonly avatar: Avatar;
}

/**
 * The composer at the bottom of a conversation, a rounded rectangle that
 * grows with its text, bound to the conversation's draft: what anything else writes to the draft, text or files, shows here.
 * Files picked upload at once and stand in the text where the caret was, each
 * a chip showing its image or a page and its name, which a tap opens once it
 * is uploaded and whose × removes it; the message goes once they all have. A message over a limit of `message.send` is kept, and says
 * why instead of sending. While Send hands the draft over, or the drafts load
 * or could not be read, the field takes no change, and attaching and removing
 * files are unavailable. In a room, `@` offers its members and `@everyone`
 * above the composer; only a pick mentions one, and a quiet line under it
 * says who the message wakes. In a bot's conversation, `/` offers the prompts
 * its connectors offer the same way; a prompt with arguments asks for them
 * above the composer, and what its server writes becomes the draft, which the
 * operator reads and sends as their own. While the field has focus the composer's border
 * takes the conversation's tint (`tint`, the bot's avatar; none in a room).
 * While the draft has no words, the trailing button dictates where the
 * platform has a speech recognizer, beside Send when files wait to go: what is
 * heard becomes the draft's words as it is heard, where the caret was, and
 * waits there for Send; while it listens, the field says so where the text
 * goes, and sizes nothing. Typing
 * stops it, and so does the conversation leaving the operator's view. A
 * reply the AI suggests shows in place of the placeholder while the draft is
 * empty and nothing is offered above it, with Use beside it, which puts it in
 * the draft, with the caret after it, to send or change; typing hides it.
 * Mount one per conversation.
 */
export function Composer({
  target,
  recipient,
  mentionable,
  onSend,
  inView,
  tint: tintOf = null,
  suggestion = null,
}: {
  readonly target: EntryTarget;
  /** Who the message goes to: a bot's or a room's name. */
  readonly recipient: string;
  /** In a room, its members, which `@` offers. */
  readonly mentionable?: ReadonlyArray<MentionCandidate>;
  readonly onSend: () => void;
  /** The operator can see the conversation: its screen has the focus, and the app is in front. */
  readonly inView: boolean;
  /** The bot whose color tints the composer; none in a room. */
  readonly tint?: Avatar | null;
  /** In a bot's conversation, the reply the AI guessed the operator may send next, or null. */
  readonly suggestion?: string | null;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const draft = useDraft(target);
  const switching = useReadable(client.draftsSwitching);
  const readFailed = useReadable(client.draftsReadFailed);
  const notSaved = useReadable(client.draftsNotSaved).has(targetKey(target));
  const field = useRef<FieldHandle>(null);
  const attachButton = useRef<ComponentRef<typeof View>>(null);
  const [attachAt, setAttachAt] = useState<MenuAnchor | null>(null);
  const opener = useFileOpener();

  const { text, mentions, files } = draft;
  const label = t("composer.label", { name: recipient });
  const { empty, uploading, sendable, problem } = draftReadiness(text, files);
  // No words yet, though files may stand there: what dictation can fill.
  const wordless = placedMessage(text).text === "";
  // The draft takes no change while it is handed over, loads, or could not be read.
  const frozen = draft.sending || switching || readFailed;
  const uploaded = useMemo(
    () =>
      files.flatMap((file): ReadonlyArray<Attachment> =>
        file._tag === "ready" ? [file.attachment] : [],
      ),
    [files],
  );
  const images = useImageFiles(client, uploaded);
  // Dictation starts only on a draft with no words, so what is heard is all of
  // them: it goes where the caret was when the first of it was heard, between
  // the draft's files, a space apart from a file on either side.
  const dictatedInto = useRef<{ readonly text: string; readonly at: number } | null>(null);
  const dictation = useDictation({
    onHeard: (heard) => {
      const held = client.drafts.get().get(targetKey(target))?.text ?? "";
      const into = (dictatedInto.current ??= {
        text: held,
        at: Math.min(selection.current[0], held.length),
      });
      const before = into.text.slice(0, into.at);
      const after = into.text.slice(into.at);
      const lead = heard !== "" && before !== "" && !/\s$/.test(before) ? " " : "";
      const tail = heard !== "" && after !== "" && !/^\s/.test(after) ? " " : "";
      client.setDraftText(target, before + lead + heard + tail + after);
    },
    frozen,
    inView,
  });
  const listening = dictation?.state._tag === "listening";
  const dictationIdle = dictation === null || dictation.state._tag === "idle";
  useEffect(() => {
    if (dictationIdle) dictatedInto.current = null;
  }, [dictationIdle]);
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
  // Where the caret goes once the text a pick or an attach wrote has reached the field.
  const placeCaret = useRef<{
    readonly reached: (text: string) => boolean;
    readonly at: number;
    /** The field takes the focus back, as after a picker, which takes it away. */
    readonly focus: boolean;
  } | null>(null);

  // A prompt its server wrote cut short says so until the operator edits it.
  const [cut, setCut] = useState(false);
  const edit = (change: FieldEdit) => {
    setNotTaken(false);
    setCut(false);
    dictation?.abort();
    dictation?.dismiss();
    const [start, end] = selection.current;
    const followed = followFieldEdit(
      {
        _tag: "change",
        before: text,
        after: change.text,
        // An edit over a selection replaced it; the field does not tell what it wrote.
        over: start < end ? [start, end] : null,
        written: null,
        caret: null,
      },
      mentions,
    );
    selection.current = change.selection;
    client.setDraftText(target, change.text, followed, change.order);
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
    else
      placeCaret.current = {
        reached: (shown) => shown === next.text,
        at: next.caret,
        focus: false,
      };
    client.setDraftText(target, next.text, next.mentions);
  };
  const prompt = usePromptPicker({
    botId: frozen || target._tag !== "conversation" ? null : target.botId,
    text,
    focused,
    onWritten: (written, wasCut) => {
      setCut(wasCut);
      placeCaret.current = {
        reached: (shown) => shown === written,
        at: written.length,
        focus: true,
      };
      client.setDraftText(target, written, []);
    },
  });
  const offered =
    suggestion !== null &&
    text === "" &&
    files.length === 0 &&
    !frozen &&
    !listening &&
    options.length === 0 &&
    prompt.options.length === 0 &&
    prompt.chosen === null
      ? suggestion
      : null;
  // The suggestion becomes the draft, with the caret after it, to send or change.
  const takeSuggestion = (taken: string) => {
    placeCaret.current = { reached: (shown) => shown === taken, at: taken.length, focus: true };
    client.setDraftText(target, taken, []);
  };
  const moveCaret = (at: number) => {
    field.current?.select(at, at);
    selection.current = [at, at];
    setCaret(focused ? at : null);
  };
  useLayoutEffect(() => {
    const pending = placeCaret.current;
    if (pending === null || !pending.reached(text)) return;
    placeCaret.current = null;
    if (pending.focus) field.current?.focus();
    moveCaret(pending.at);
  });

  const attach = (picked: ReadonlyArray<PickedFile>) => {
    if (picked.length === 0) return;
    // The draft may have changed, or stopped taking changes, while the picker was open.
    const now = client.drafts.get().get(targetKey(target));
    const stillFrozen =
      now?.sending === true || client.draftsSwitching.get() || client.draftsReadFailed.get();
    setNotTaken(stillFrozen);
    if (stillFrozen) return;
    // The files stand where the caret was, and the caret goes after them.
    const held = now?.text ?? "";
    const at = Math.min(selection.current[0], held.length);
    const marks = markCount(held) + picked.length;
    placeCaret.current = {
      reached: (shown) => markCount(shown) === marks,
      at: at + picked.length,
      focus: true,
    };
    client.attachFiles(target, picked, at);
  };
  // The keyboard goes first: the + moves down with the composer as it hides, so
  // a menu placed while it was up would be left floating where the + had been.
  // The composer follows the keyboard on the UI thread and takes its last
  // place a frame after the hide reaches here, at once when nothing animates,
  // so the + is measured on that frame.
  const openPicker = () =>
    void KeyboardController.dismiss().then(() =>
      requestAnimationFrame(() =>
        attachButton.current?.measureInWindow((x, y, width, height) =>
          setAttachAt({ x, y, width, height }),
        ),
      ),
    );

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

  // A ready file opens; one still uploading, or that failed, has nothing to open yet.
  const openFile = (key: string) => {
    const file = files.find((held) => held.key === key);
    if (file?._tag === "ready") opener.open(file.attachment);
  };
  const status: FieldStatus | null =
    dictation?.state._tag === "listening"
      ? {
          text: t("composer.dictation.listening"),
          note: dictation.state.place === "device" ? null : t("composer.dictation.onlineNote"),
        }
      : null;

  return (
    <View className="gap-1.5 px-3 pt-1 pb-2">
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
      {prompt.options.length > 0 && <PromptList options={prompt.options} onPick={prompt.pick} />}
      {prompt.chosen !== null && (
        <PromptForm
          chosen={prompt.chosen}
          onFill={prompt.fill}
          onUse={prompt.use}
          onCancel={() => {
            prompt.cancel();
            field.current?.focus();
          }}
        />
      )}
      <AnimatedView
        // Focused, the border takes the bot's color, which reaches 3:1 on the surface.
        style={[settled, focused ? { borderColor: tint.color } : undefined]}
        className="flex-row items-end rounded-composer border border-input bg-surface"
      >
        <PressScale
          depth="round"
          accessibilityRole="button"
          accessibilityLabel={t("composer.attach")}
          accessibilityState={{ disabled: frozen }}
          ref={attachButton}
          onPress={frozen ? undefined : openPicker}
          frame={composerButtonFrame}
          hitSlop={composerButtonSlop}
          className="size-8 items-center justify-center rounded-full active:bg-muted"
        >
          <Icon icon={Plus} size={18} color="accent-muted-foreground" />
        </PressScale>
        <ChipField
          ref={field}
          value={text}
          files={files}
          images={images}
          mentions={fieldMentions(text, mentions, mentionable ?? [])}
          placeholder={offered ?? label}
          status={status}
          editable={!frozen}
          label={label}
          onEdit={edit}
          onSelection={(next) => {
            selection.current = next;
            setCaret(next[0] === next[1] ? next[1] : null);
          }}
          onFocusChange={(now) => {
            const [start, end] = selection.current;
            setCaret(now && start === end ? end : null);
            setFocused(now);
          }}
          onPressFile={openFile}
          onRemoveFile={(key) => {
            if (!frozen) client.detachFile(target, key);
          }}
        />
        {offered !== null && (
          <Animated.View entering={appear} className="self-center">
            <PressScale
              accessibilityRole="button"
              accessibilityLabel={t("composer.suggestion.useLabel")}
              accessibilityHint={t("composer.suggestion", { text: offered })}
              onPress={() => takeSuggestion(offered)}
              className="min-h-11 justify-center rounded-full px-3 active:bg-muted"
            >
              <Text className="text-sm font-medium text-muted-foreground">
                {t("composer.suggestion.use")}
              </Text>
            </PressScale>
          </Animated.View>
        )}
        {/* With files and no words, both: dictating about the files, or sending them. */}
        {dictation !== null && (wordless || listening) && !draft.sending && (
          <DictationButton dictation={dictation} unavailable={frozen} />
        )}
        {(dictation === null || draft.sending || !(empty || listening)) && (
          <SendButton
            state={draft.sending ? "sending" : ready ? "ready" : "disabled"}
            tint={tint.color}
            hint={uploading ? t("composer.stillUploading") : undefined}
            onSend={onSend}
          />
        )}
      </AnimatedView>
      <Menu
        anchor={attachAt}
        edge="start"
        onClose={() => setAttachAt(null)}
        label={t("composer.attach")}
        entries={[
          {
            label: t("composer.attach.photos"),
            icon: Images,
            onPress: () => void pickPhotos().then(attach),
          },
          {
            label: t("composer.attach.files"),
            icon: File,
            onPress: () => void pickDocuments().then(attach),
          },
        ]}
      />
      {dictation !== null && <DictationLine dictation={dictation} />}
      {cut && <Text className="px-3 text-xs text-muted-foreground">{t("prompt.cut")}</Text>}
      {/* Quiet: it clears by itself once the device keeps the draft. */}
      {notSaved && (
        <Text className="px-3 text-xs text-muted-foreground">{t("composer.notSaved")}</Text>
      )}
      {failures.length > 0 && <Text className="px-3 text-xs text-blocked">{failuresText}</Text>}
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
    transform: [{ translateY: -10 * lift.get() }, { scale: scale.get() }],
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
      frame={composerButtonFrame}
      hitSlop={composerButtonSlop}
      style={filled ? { backgroundColor: tint } : undefined}
      className={`size-8 items-center justify-center rounded-full ${filled ? "" : "bg-muted"}`}
    >
      <Animated.View style={arrow}>
        <Icon
          icon={ArrowUp}
          size={18}
          color={filled ? "accent-avatar-ink" : "accent-muted-foreground"}
        />
      </Animated.View>
    </PressScale>
  );
}

/**
 * Each pick of a member that addresses it as the draft stands, which the
 * field draws as its chip, so what it shows is whom the message wakes.
 * `@everyone`, and a member no longer in the room, stay text.
 */
function fieldMentions(
  text: string,
  mentions: ReadonlyArray<DraftMention>,
  members: ReadonlyArray<MentionCandidate>,
): ReadonlyArray<FieldMention> {
  return standingMentions(text, mentions).flatMap((mention) => {
    if (mention._tag !== "bot") return [];
    const member = members.find((candidate) => candidate.id === mention.botId);
    if (member === undefined) return [];
    return [
      { at: mention.position, text: `@${mention.label}`, botId: member.id, avatar: member.avatar },
    ];
  });
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
                {avatar !== undefined && (
                  <BotAvatar avatar={avatar} seed={option.id} state="idle" size={24} still />
                )}
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
