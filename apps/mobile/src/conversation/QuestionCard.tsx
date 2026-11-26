// SPDX-License-Identifier: AGPL-3.0-or-later
import { refusedWith } from "@j3-bots/client-runtime";
import {
  assembleAnswers,
  optionDescription,
  type QuestionDraft,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import {
  cardQuestions,
  type QuestionAnswers,
  type QuestionEntry,
  type QuestionOption,
  type WholeQuestion,
} from "@j3-bots/contracts";
import { springs } from "@j3-bots/design-tokens";
import { Check, MessageCircleQuestionMark } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Text, TextInput } from "../text.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { useColor } from "../theme.ts";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";
import { enteringWhen, popIn, settleIn } from "../motion.ts";
import { AnimatedView } from "./animated.ts";
import { CardFrame, useClosedHere, useOutcomeFocus, useSubmitting } from "./CardFrame.tsx";
import { PressScale } from "../press.tsx";

/** A chosen option's check, popping in as the choice confirms. */
/** A bordered row the operator picks; a picked one is filled. */
export const choiceRow = (picked: boolean) =>
  `min-h-11 flex-row items-start gap-2.5 rounded-md border px-3 py-2 ${picked ? "border-foreground/60 bg-muted" : "border-input"}`;

/**
 * A bot asking the operator to choose. A single question with single choice
 * and no typed answer is answered by tapping an option; anything else is a
 * form of radio buttons, checkboxes and text, sent with "Send answer". An
 * `ask` question takes a note beside a choice; the harness's own question
 * takes one or the other, so typing clears the choice and choosing clears the
 * text. Only an `ask` question can be dismissed, which reads as "no", and its
 * button says so: the harness's own question holds its turn until it is
 * answered or the turn is stopped. An answer too long to reach the bot leaves
 * the card open with what was typed. A harness's question can come with a
 * header over it and a preview under an option, shown as the harness gives
 * them. Several questions stack, each under the one before, however many.
 */
export function QuestionCard({ entry }: { readonly entry: QuestionEntry }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const submitting = useSubmitting(entry.id);
  const { status } = entry;
  const pending = status._tag === "pending";
  const { outcome, answered } = useOutcomeFocus(pending);
  const questions = cardQuestions(entry);
  const [first] = questions;

  const answer = (answers: QuestionAnswers) => {
    if (submitting) return;
    answered();
    void client.answerCard(entry.id, { _tag: "question", answers }).then((result) => {
      if (refusedWith(result, "answer-length")) say(t("question.tooLong"));
    });
  };
  const dismiss =
    entry.origin === "ask"
      ? () => {
          if (submitting) return;
          answered();
          void client.answerCard(entry.id, { _tag: "dismiss" });
        }
      : null;
  const answersOnTap = pending && questions.length === 1 && !first.multiple && !first.acceptsText;
  // The option tapped confirms while its answer is on its way: it takes a check, and the others
  // step back. Refused, the card waits again with every option as it was.
  const [tapped, setTapped] = useState<string | null>(null);
  const chosen = submitting ? tapped : null;
  const { closedHere } = useClosedHere(pending);

  return (
    <CardFrame icon={MessageCircleQuestionMark} title={t("question.title")} attention={pending}>
      {!pending ? (
        <AnimatedView {...enteringWhen(closedHere, settleIn(springs.soft))} className="gap-3">
          {questions.map((question) => (
            <Resolved
              key={question.id}
              question={question}
              answer={status._tag === "answered" ? (status.answers[question.id] ?? null) : null}
              popped={closedHere}
            />
          ))}
          <Text ref={outcome} className="text-xs text-muted-foreground">
            {status._tag === "answered"
              ? t("question.answered")
              : status._tag === "dismissed"
                ? t("question.dismissed")
                : status._tag === "refused"
                  ? t("question.refused")
                  : t("question.expired")}
          </Text>
        </AnimatedView>
      ) : answersOnTap ? (
        <>
          <View className="gap-1.5">
            <QuestionHeader question={first} />
            <Text className="mb-1 text-sm font-medium text-foreground">{first.prompt}</Text>
            {first.options.map((option) => (
              <PressScale
                key={option.id}
                depth="row"
                accessibilityRole="button"
                accessibilityState={{ disabled: submitting, selected: chosen === option.id }}
                onPress={
                  submitting
                    ? undefined
                    : () => {
                        setTapped(option.id);
                        answer({ [first.id]: { optionIds: [option.id], text: null } });
                      }
                }
                className={`${choiceRow(chosen === option.id)} ${chosen !== null && chosen !== option.id ? "opacity-50" : ""}`}
              >
                <OptionText option={option} />
                {chosen === option.id && (
                  <AnimatedView entering={popIn()} className="ms-auto mt-0.5">
                    <Icon icon={Check} size={16} color="accent-foreground" />
                  </AnimatedView>
                )}
              </PressScale>
            ))}
          </View>
          {dismiss !== null && <Actions onDismiss={dismiss} submitting={submitting} send={null} />}
        </>
      ) : (
        // Keyed by the entry, so a draft never outlives the card it was typed into.
        <QuestionForm
          key={entry.id}
          questions={questions}
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
  readonly questions: ReadonlyArray<WholeQuestion>;
  readonly textReplacesChoice: boolean;
  readonly onAnswer: (answers: QuestionAnswers) => void;
  readonly onDismiss: (() => void) | null;
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
      {questions.map((question, index) => (
        <QuestionFields
          key={question.id}
          separated={index > 0}
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
  separated,
  draft,
  textReplacesChoice,
  readOnly,
  onChange,
}: {
  readonly question: WholeQuestion;
  /** Under another question of the card: a line between them. */
  readonly separated: boolean;
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
    <View className={`gap-2 ${separated ? "border-t border-border pt-3" : ""}`}>
      <QuestionHeader question={question} />
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
              <PressScale
                key={option.id}
                depth="row"
                accessibilityRole={question.multiple ? "checkbox" : "radio"}
                accessibilityState={{ checked, disabled: readOnly }}
                onPress={readOnly ? undefined : () => toggle(option)}
                className={choiceRow(checked)}
              >
                <Indicator shape={question.multiple ? "square" : "round"} checked={checked} />
                <OptionText option={option} />
              </PressScale>
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
export function Indicator({
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

/** An option's label, what the bot says of it in words, and what its description adds. */
function OptionText({ option }: { readonly option: QuestionOption }) {
  const { t } = useI18n();
  const destructive = option.style === "destructive";
  const description = optionDescription(option);
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
      {description !== null && <Text className="text-xs text-muted-foreground">{description}</Text>}
      {option.preview !== undefined && (
        <ScrollView horizontal className="mt-1.5 max-h-48 rounded-sm bg-muted">
          <Text className="px-2.5 py-2 font-mono text-xs text-muted-foreground">
            {option.preview}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

/** What a harness's question is about, in a few words over it, when it says. */
function QuestionHeader({ question }: { readonly question: WholeQuestion }) {
  if (question.header === undefined) return null;
  return (
    <View className="self-start rounded-sm bg-muted px-1.5 py-0.5">
      <Text className="text-2xs font-medium text-muted-foreground">{question.header}</Text>
    </View>
  );
}

/**
 * Dismiss, on an `ask` question, and Send answer on a form, which takes no
 * press until every question has an answer. A card answered by a tap has no
 * Send answer.
 */
function Actions({
  onDismiss,
  submitting,
  send,
}: {
  readonly onDismiss: (() => void) | null;
  readonly submitting: boolean;
  readonly send: { readonly ready: boolean; readonly onPress: () => void } | null;
}) {
  const { t } = useI18n();
  return (
    <View className="flex-row flex-wrap items-center justify-end gap-2">
      {onDismiss !== null && (
        <Button
          variant="outline"
          label={t("question.dismiss")}
          onPress={onDismiss}
          held={submitting}
        />
      )}
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
  popped,
}: {
  readonly question: WholeQuestion;
  readonly answer: QuestionAnswers[string] | null;
  /** Answered while on screen: each chosen option's check pops in. */
  readonly popped: boolean;
}) {
  const chosen = question.options.filter((option) => answer?.optionIds.includes(option.id));
  return (
    <View className="gap-2">
      <QuestionHeader question={question} />
      <Text className="text-sm font-medium text-foreground">{question.prompt}</Text>
      {chosen.map((option) => (
        <View key={option.id} className={choiceRow(true)}>
          <OptionText option={option} />
          <AnimatedView {...enteringWhen(popped, popIn())} className="ms-auto mt-0.5">
            <Icon icon={Check} size={16} color="accent-foreground" />
          </AnimatedView>
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
