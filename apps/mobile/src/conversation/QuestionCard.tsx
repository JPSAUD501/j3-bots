// SPDX-License-Identifier: AGPL-3.0-or-later
import { refusedWith } from "@j3-bots/client-runtime";
import { assembleAnswers, type QuestionDraft } from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type { Question, QuestionAnswers, QuestionEntry, QuestionOption } from "@j3-bots/contracts";
import { Check, MessageCircleQuestionMark } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { useColor } from "../theme.ts";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";
import { CardFrame, useOutcomeFocus, useSubmitting } from "./CardFrame.tsx";

/** A bordered row the operator picks; a picked one is filled. */
const choiceRow = (picked: boolean) =>
  `min-h-11 flex-row items-start gap-2.5 rounded-md border px-3 py-2 ${picked ? "border-foreground/60 bg-muted" : "border-input"}`;

/**
 * A bot asking the operator to choose. A single question with single choice
 * and no typed answer is answered by tapping an option; anything else is a
 * form of radio buttons, checkboxes and text, sent with "Send answer". An
 * `ask` question takes a note beside a choice; the harness's own question
 * takes one or the other, so typing clears the choice and choosing clears the
 * text. Dismissing reads as "no", and its button says so. An answer too long
 * to reach the bot leaves the card open with what was typed.
 */
export function QuestionCard({ entry }: { readonly entry: QuestionEntry }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const submitting = useSubmitting(entry.id);
  const { status } = entry;
  const pending = status._tag === "pending";
  const { outcome, answered } = useOutcomeFocus(pending);
  const [first] = entry.questions;

  const answer = (answers: QuestionAnswers) => {
    if (submitting) return;
    answered();
    void client.answerCard(entry.id, { _tag: "question", answers }).then((result) => {
      if (refusedWith(result, "answer-length")) say(t("question.tooLong"));
    });
  };
  const dismiss = () => {
    if (submitting) return;
    answered();
    void client.answerCard(entry.id, { _tag: "dismiss" });
  };
  const answersOnTap =
    pending && entry.questions.length === 1 && !first.multiple && !first.acceptsText;

  return (
    <CardFrame
      icon={MessageCircleQuestionMark}
      title={pending ? t("question.pending") : t("question.title")}
      attention={pending}
    >
      {!pending ? (
        <>
          {entry.questions.map((question) => (
            <Resolved
              key={question.id}
              question={question}
              answer={status._tag === "answered" ? (status.answers[question.id] ?? null) : null}
            />
          ))}
          <Text ref={outcome} className="text-xs text-muted-foreground">
            {status._tag === "answered"
              ? t("question.answered")
              : status._tag === "dismissed"
                ? t("question.dismissed")
                : t("question.expired")}
          </Text>
        </>
      ) : answersOnTap ? (
        <>
          <View accessibilityRole="list" accessibilityLabel={first.prompt} className="gap-1.5">
            <Text className="mb-1 text-sm font-medium text-foreground">{first.prompt}</Text>
            {first.options.map((option) => (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityState={{ disabled: submitting }}
                onPress={
                  submitting
                    ? undefined
                    : () => answer({ [first.id]: { optionIds: [option.id], text: null } })
                }
                className={choiceRow(false)}
              >
                <OptionText option={option} />
              </Pressable>
            ))}
          </View>
          <Actions onDismiss={dismiss} submitting={submitting} send={null} />
        </>
      ) : (
        // Keyed by the entry, so a draft never outlives the card it was typed into.
        <QuestionForm
          key={entry.id}
          questions={entry.questions}
          textReplacesChoice={entry.origin === "engine"}
          onAnswer={answer}
          onDismiss={dismiss}
          submitting={submitting}
        />
      )}
    </CardFrame>
  );
}

function QuestionForm({
  questions,
  textReplacesChoice,
  onAnswer,
  onDismiss,
  submitting,
}: {
  readonly questions: ReadonlyArray<Question>;
  readonly textReplacesChoice: boolean;
  readonly onAnswer: (answers: QuestionAnswers) => void;
  readonly onDismiss: () => void;
  readonly submitting: boolean;
}) {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, QuestionDraft>>(() => new Map());
  const answers = assembleAnswers(questions, drafts);
  const update = (id: string, change: Partial<QuestionDraft>) =>
    setDrafts((current) => {
      const next = new Map(current);
      next.set(id, { optionIds: [], text: "", ...current.get(id), ...change });
      return next;
    });
  return (
    <>
      {questions.map((question) => (
        <QuestionFields
          key={question.id}
          question={question}
          draft={drafts.get(question.id) ?? null}
          textReplacesChoice={textReplacesChoice}
          readOnly={submitting}
          onChange={(change) => update(question.id, change)}
        />
      ))}
      <Actions
        onDismiss={onDismiss}
        submitting={submitting}
        send={{
          ready: answers !== null,
          onPress: () => {
            if (answers !== null) onAnswer(answers);
          },
        }}
      />
    </>
  );
}

/** One question's fields. While the answer is on its way they take no change but keep focus. */
function QuestionFields({
  question,
  draft,
  textReplacesChoice,
  readOnly,
  onChange,
}: {
  readonly question: Question;
  readonly draft: QuestionDraft | null;
  /** A typed answer goes instead of a choice, never beside it. */
  readonly textReplacesChoice: boolean;
  readonly readOnly: boolean;
  readonly onChange: (change: Partial<QuestionDraft>) => void;
}) {
  const { t } = useI18n();
  const placeholderColor = useColor("accent-muted-foreground");
  const picked = draft?.optionIds ?? [];
  // Where typed text goes with a chosen option, the field says so.
  const textLabel =
    question.options.length === 0
      ? t("question.typeAnswer")
      : picked.length > 0 && !textReplacesChoice
        ? t("question.addNote")
        : t("question.typeInstead");
  const choose = (optionIds: ReadonlyArray<string>) =>
    onChange(textReplacesChoice ? { optionIds, text: "" } : { optionIds });
  const toggle = (option: QuestionOption) => {
    if (!question.multiple) {
      choose([option.id]);
      return;
    }
    choose(
      picked.includes(option.id)
        ? picked.filter((id) => id !== option.id)
        : question.options.flatMap(({ id }) =>
            id === option.id || picked.includes(id) ? [id] : [],
          ),
    );
  };
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">{question.prompt}</Text>
      {question.options.length > 0 && (
        <View
          accessibilityRole={question.multiple ? "list" : "radiogroup"}
          accessibilityLabel={question.prompt}
          className="gap-1.5"
        >
          {question.options.map((option) => {
            const checked = picked.includes(option.id);
            return (
              <Pressable
                key={option.id}
                accessibilityRole={question.multiple ? "checkbox" : "radio"}
                accessibilityState={{ checked, disabled: readOnly }}
                onPress={readOnly ? undefined : () => toggle(option)}
                className={choiceRow(checked)}
              >
                <Indicator shape={question.multiple ? "square" : "round"} checked={checked} />
                <OptionText option={option} />
              </Pressable>
            );
          })}
        </View>
      )}
      {question.acceptsText && (
        <TextInput
          multiline
          value={draft?.text ?? ""}
          editable={!readOnly}
          onChangeText={(text) =>
            onChange(textReplacesChoice && text.trim() !== "" ? { text, optionIds: [] } : { text })
          }
          placeholder={textLabel}
          placeholderTextColor={placeholderColor}
          accessibilityLabel={question.options.length > 0 ? textLabel : question.prompt}
          className="min-h-11 rounded-md border border-input bg-surface px-3 py-2.5 text-base text-foreground"
        />
      )}
    </View>
  );
}

/** The drawn box or circle of a choice, filled once checked. */
function Indicator({
  shape,
  checked,
}: {
  readonly shape: "square" | "round";
  readonly checked: boolean;
}) {
  return (
    <View
      className={`mt-0.5 size-4 items-center justify-center border ${shape === "square" ? "rounded-sm" : "rounded-pill"} ${checked ? "border-foreground bg-foreground" : "border-control-off"}`}
    >
      {checked &&
        (shape === "square" ? (
          <Icon icon={Check} size={12} color="accent-background" />
        ) : (
          <View className="size-2 rounded-pill bg-background" />
        ))}
    </View>
  );
}

/** An option's label, what the bot says of it in words, and its description. */
function OptionText({ option }: { readonly option: QuestionOption }) {
  const { t } = useI18n();
  const destructive = option.style === "destructive";
  return (
    <View className="min-w-0 flex-1">
      <View className="flex-row flex-wrap items-baseline gap-x-2">
        <Text className={`text-sm ${destructive ? "text-blocked" : "text-foreground"}`}>
          {option.label}
        </Text>
        {option.style === "recommended" && (
          <Text className="text-2xs font-medium text-accent">{t("question.recommended")}</Text>
        )}
        {destructive && (
          <Text className="text-2xs font-medium text-blocked">{t("question.destructive")}</Text>
        )}
      </View>
      {option.description !== null && option.description !== "" && (
        <Text className="text-xs text-muted-foreground">{option.description}</Text>
      )}
    </View>
  );
}

/**
 * Dismiss, and Send answer on a form, which takes no press until every
 * question has an answer. A card answered by a tap has no Send answer.
 */
function Actions({
  onDismiss,
  submitting,
  send,
}: {
  readonly onDismiss: () => void;
  readonly submitting: boolean;
  readonly send: { readonly ready: boolean; readonly onPress: () => void } | null;
}) {
  const { t } = useI18n();
  return (
    <View className="flex-row flex-wrap items-center justify-end gap-2">
      <Button variant="quiet" label={t("question.dismiss")} onPress={onDismiss} held={submitting} />
      {send !== null && (
        <Button
          variant="primary"
          label={t("question.send")}
          onPress={send.onPress}
          disabled={!send.ready}
          held={submitting}
        />
      )}
    </View>
  );
}

/** A question once it no longer waits: what was chosen and typed, if anything. */
function Resolved({
  question,
  answer,
}: {
  readonly question: Question;
  readonly answer: QuestionAnswers[string] | null;
}) {
  const chosen = question.options.filter((option) => answer?.optionIds.includes(option.id));
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">{question.prompt}</Text>
      {chosen.map((option) => (
        <View key={option.id} className={choiceRow(true)}>
          <OptionText option={option} />
        </View>
      ))}
      {answer !== null && answer.text !== null && answer.text !== "" && (
        <Text selectable className="text-sm text-foreground">
          {answer.text}
        </Text>
      )}
    </View>
  );
}
