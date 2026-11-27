// SPDX-License-Identifier: AGPL-3.0-or-later
import { diffTones } from "@j3-bots/client-runtime/presentation";
import { useJ3Client } from "@j3-bots/client-runtime/react";
import type {
  ApprovalChange,
  ApprovalDecision,
  ApprovalEntry,
  SessionGrant,
} from "@j3-bots/contracts";
import { layout, springs } from "@j3-bots/design-tokens";
import type { KeyWith } from "@j3-bots/i18n";
import { Check, ChevronRight, Shield, ShieldCheck, ShieldX } from "lucide-react-native";
import { use, useState } from "react";
import { View } from "react-native";
import { FadeOut } from "react-native-reanimated";
import { Text } from "../text.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { Button } from "../ui.tsx";
import { enteringWhen, popIn, settleIn } from "../motion.ts";
import { AnimatedView } from "./animated.ts";
import { CardFrame, useClosedHere, useOutcomeFocus, useSubmitting } from "./CardFrame.tsx";
import { PressScale } from "../press.tsx";
import { CodeBlock, Scrolling } from "./CodeBlock.tsx";
import { EntryWidths } from "./widths.ts";

const kindTitle: Record<ApprovalEntry["kind"], KeyWith> = {
  command: "approval.kind.command",
  "file-change": "approval.kind.fileChange",
  "file-read": "approval.kind.fileRead",
  tool: "approval.kind.tool",
  other: "approval.kind.other",
};

const decisionText: Record<ApprovalDecision, KeyWith> = {
  "allow-once": "approval.allowedOnce",
  "allow-session": "approval.allowedSession",
  deny: "approval.denied",
};

const summaryOnly: Record<ApprovalEntry["kind"], KeyWith> = {
  command: "approval.summaryOnly.command",
  "file-change": "approval.summaryOnly.fileChange",
  "file-read": "approval.summaryOnly.fileRead",
  tool: "approval.summaryOnly.tool",
  other: "approval.summaryOnly.other",
};

// What "Don’t ask again" allows from then on, in words, starting with the button's name: under
// the buttons, so on a phone it never reads as the consequence of the full-width button above it.
const grantScope: Record<SessionGrant["covers"], KeyWith> = {
  "every-command": "approval.grant.everyCommand",
  "every-file-change": "approval.grant.everyFileChange",
};

// The same, on a card where it was chosen.
const grantedScope: Record<SessionGrant["covers"], KeyWith> = {
  "every-command": "approval.granted.everyCommand",
  "every-file-change": "approval.granted.everyFileChange",
};

// A new or deleted file is said beside its path; an update needs no word.
const operationLabel: Record<NonNullable<ApprovalChange["operation"]>, KeyWith | null> = {
  add: "approval.operation.add",
  delete: "approval.operation.delete",
  update: null,
};

/**
 * A bot asking to do one thing its permission mode does not allow outright.
 * What it asks is always on the card, exactly as the engine recorded it: the
 * whole command, or a file change's path and its diff, tinted by line, or a
 * new or deleted file's contents, labelled beside the path. Why it asks, when
 * the provider said, is a quiet line above, never mixed into it. When the
 * provider shared only a summary, the card says so and sets the summary as
 * prose; it can still be allowed once, but never for the whole session. A
 * grant for the session says, under the buttons, what it will allow from
 * then on.
 */
export function ApprovalCard({ entry }: { readonly entry: ApprovalEntry }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const widths = use(EntryWidths);
  const submitting = useSubmitting(entry.id);
  const { status, detail, sessionGrant } = entry;
  const pending = status._tag === "pending";
  const { outcome, answered } = useOutcomeFocus(pending);
  // Decided while on screen, the buttons fold away and the outcome settles in; allowed, the card
  // gives one small pulse and its check pops in.
  const { closedHere } = useClosedHere(pending);
  const allowed = status._tag === "decided" && status.decision !== "deny";
  const [shown, setShown] = useState(false);
  const scope = sessionGrant === null ? null : t(grantScope[sessionGrant.covers]);
  // On a phone the buttons fill the row they share, and the operation goes under the path.
  const narrow = widths.column < layout.breakpoints.tablet;
  const decide = (decision: ApprovalDecision) => () => {
    if (submitting) return;
    answered();
    void client.answerCard(entry.id, { _tag: "approval", decision });
  };
  const icon =
    status._tag !== "decided" ? Shield : status.decision === "deny" ? ShieldX : ShieldCheck;
  // A new or deleted file's text is its contents; anything else's is the change.
  const wholeFile = detail?.operation === "add" || detail?.operation === "delete";
  const operation =
    detail === null || detail.operation === null ? null : operationLabel[detail.operation];

  // The changed file's path, with what happens to it when that is more than a change in place.
  const paths = (className: string) => (
    <View
      className={`bg-code-background ${narrow ? "" : "flex-row items-start gap-2"} ${className}`}
    >
      <CodeBlock
        text={entry.action}
        // The path is not everything the bot will do: the change under it is part of it.
        label={null}
        strong={pending}
        className={narrow ? "" : "flex-1"}
      />
      {operation !== null && (
        <Text
          className={`text-2xs leading-5 text-muted-foreground ${narrow ? "px-2.5 pb-2" : "py-2 pe-2.5"}`}
        >
          {t(operation)}
        </Text>
      )}
    </View>
  );
  // Only an update's text is a diff: a new file's contents can start lines with `-` or `+` too.
  const change = (text: string, className: string) => (
    <CodeBlock
      text={text}
      label={t(wholeFile ? "approval.contents" : "approval.change")}
      {...(detail?.operation === "update" ? { tones: diffTones } : {})}
      className={`bg-code-background ${className}`}
    />
  );

  return (
    <CardFrame
      icon={icon}
      title={t(kindTitle[entry.kind])}
      attention={pending}
      pulse={closedHere && allowed}
    >
      {entry.reason !== null && (
        <Text className="text-xs text-muted-foreground">{entry.reason}</Text>
      )}
      {!entry.exact ? (
        <View className="gap-1.5">
          {pending ? (
            <Text className="text-xs font-medium text-foreground">
              {t(summaryOnly[entry.kind])}
            </Text>
          ) : (
            // Decided or expired, the record still says what was decided on.
            <Text className="text-2xs text-muted-foreground">{t("approval.summaryQualifier")}</Text>
          )}
          {/* Prose, not code: it lines up with the card's other lines, with no block around it. */}
          <Scrolling label={t("approval.summary")}>
            <Text selectable className="text-sm text-foreground">
              {entry.action}
            </Text>
          </Scrolling>
        </View>
      ) : detail === null ? (
        // The action alone, such as a whole command.
        <CodeBlock
          text={entry.action}
          label={t("approval.action")}
          className="rounded-md bg-code-background"
        />
      ) : pending ? (
        // One block in two parts, joined by a seam of the card's own surface. The path stays put;
        // only the diff scrolls, so it never leaves view.
        <View className="gap-px overflow-hidden rounded-md">
          {paths("")}
          {change(detail.text, "")}
        </View>
      ) : (
        <>
          {paths("rounded-md overflow-hidden")}
          <PressScale
            accessibilityRole="button"
            accessibilityState={{ expanded: shown }}
            onPress={() => setShown((was) => !was)}
            frame={{ alignSelf: "flex-start" }}
            className="min-h-11 flex-row items-center gap-1"
          >
            <View style={{ transform: [{ rotate: shown ? "90deg" : "0deg" }] }}>
              <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
            </View>
            <Text className="text-xs text-muted-foreground">
              {t(wholeFile ? "approval.showFile" : "approval.showChange")}
            </Text>
          </PressScale>
          {shown && change(detail.text, "rounded-md")}
        </>
      )}
      {pending ? (
        <AnimatedView exiting={FadeOut.duration(160)} className="gap-2">
          <View className="flex-row flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              label={t("approval.deny")}
              onPress={decide("deny")}
              held={submitting}
              grow={narrow}
            />
            {scope !== null && (
              <Button
                variant="outline"
                label={t("approval.allowSession")}
                accessibilityHint={scope}
                onPress={decide("allow-session")}
                held={submitting}
                grow={narrow}
              />
            )}
            <Button
              variant="primary"
              label={t("approval.allowOnce")}
              onPress={decide("allow-once")}
              held={submitting}
              grow={narrow}
            />
          </View>
          {scope !== null && (
            // The button's hint says it to a screen reader, which skips the line itself.
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              className="text-end text-2xs text-muted-foreground"
            >
              {scope}
            </Text>
          )}
        </AnimatedView>
      ) : (
        <AnimatedView {...enteringWhen(closedHere, settleIn(springs.soft))} className="gap-0.5">
          <View className="flex-row items-center gap-1.5">
            {allowed && (
              <AnimatedView {...enteringWhen(closedHere, popIn(120))}>
                <Icon icon={Check} size={14} color="accent-success" />
              </AnimatedView>
            )}
            <Text
              ref={outcome}
              className={`text-xs ${status._tag === "decided" && status.decision === "deny" ? "text-blocked" : allowed ? "text-success" : "text-muted-foreground"}`}
            >
              {status._tag === "decided"
                ? t(decisionText[status.decision])
                : status._tag === "refused"
                  ? t("approval.refused")
                  : t("approval.expired")}
            </Text>
          </View>
          {status._tag === "decided" &&
            status.decision === "allow-session" &&
            sessionGrant !== null && (
              <Text className="text-2xs text-muted-foreground">
                {t(grantedScope[sessionGrant.covers])}
              </Text>
            )}
        </AnimatedView>
      )}
    </CardFrame>
  );
}
