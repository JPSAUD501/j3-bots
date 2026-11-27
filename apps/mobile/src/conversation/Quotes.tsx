// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Revealed } from "@j3-bots/client-runtime";
import {
  passageOf,
  type QuotableMessage,
  replyTo,
  takesPassage,
} from "@j3-bots/client-runtime/presentation";
import { useDraft, useJ3Client } from "@j3-bots/client-runtime/react";
import type { EntryId, EntryTarget, MessageQuote } from "@j3-bots/contracts";
import { motion } from "@j3-bots/design-tokens";
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { View } from "react-native";
import {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { Sheet } from "../components/Sheet.tsx";
import { useReducedMotion } from "../motion.ts";
import { usePresentation } from "../presentation.tsx";
import { Text, TextInput } from "../text.tsx";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";

/**
 * Which message is drawn highlighted, as the source of a quote the operator
 * tapped: each flash counts up, so the same message flashes again when asked
 * again.
 */
interface Highlights {
  readonly subscribe: (listener: () => void) => () => void;
  /** This flash's count while `entryId` is the one highlighted; 0 otherwise. */
  readonly flashOf: (entryId: EntryId | null) => number;
  readonly flash: (entryId: EntryId) => void;
}

export const createHighlights = (): Highlights => {
  const listeners = new Set<() => void>();
  let current: { readonly entryId: EntryId; readonly count: number } | null = null;
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    flashOf: (entryId) => (current !== null && current.entryId === entryId ? current.count : 0),
    flash: (entryId) => {
      current = { entryId, count: (current?.count ?? 0) + 1 };
      for (const listener of listeners) listener();
    },
  };
};

interface Quoting {
  /**
   * Whether Reply and Quote part are offered here: the server takes quotes
   * and the conversation takes messages.
   */
  readonly offered: boolean;
  /** Puts a reply to `message` in the draft and takes the operator to the composer. */
  readonly reply: (message: QuotableMessage) => void;
  /** Opens the sheet to pick a passage of `message` to quote. */
  readonly quotePart: (message: QuotableMessage) => void;
  /**
   * Shows the message a quote came from: reads the conversation back to it,
   * scrolls to it and highlights it once it is `shown`.
   */
  readonly goTo: (entryId: EntryId) => Promise<Revealed>;
  readonly highlights: Highlights;
}

const QuotingContext = createContext<Quoting | null>(null);

/** What quoting a message does in this conversation. */
export const useQuoting = (): Quoting => {
  const quoting = use(QuotingContext);
  if (quoting === null) throw new Error("useQuoting needs Quotes above it.");
  return quoting;
};

/** How long a message the operator was taken to stays highlighted before it fades. */
const HIGHLIGHT_HOLD = 900;

/**
 * The style of a message's highlight, as the source of a quote tapped: it
 * comes up quickly and fades after a moment. Reduced motion shows it and
 * takes it away, without a fade.
 */
export function useHighlight(entryId: EntryId | null) {
  const { highlights } = useQuoting();
  const flash = useSyncExternalStore(highlights.subscribe, () => highlights.flashOf(entryId));
  const reduced = useReducedMotion();
  const shown = useSharedValue(0);
  useEffect(() => {
    if (flash === 0) return;
    if (reduced) {
      shown.set(1);
      const timer = setTimeout(() => shown.set(0), HIGHLIGHT_HOLD + motion.slow);
      return () => {
        clearTimeout(timer);
        shown.set(0);
      };
    }
    shown.set(
      withSequence(
        withTiming(1, { duration: motion.fast }),
        withDelay(HIGHLIGHT_HOLD, withTiming(0, { duration: motion.slow })),
      ),
    );
    return undefined;
  }, [flash, reduced, shown]);
  return useAnimatedStyle(() => ({ opacity: shown.get() }));
}

/**
 * Quoting the messages of one conversation (decision 0094): Reply puts a
 * message in the draft whole, Quote part opens one sheet to pick a passage
 * of it, and a quote's card leads to the message it came from, which the
 * conversation highlights through `highlights`. What the draft cannot take
 * says so in a toast.
 */
export function Quotes({
  target,
  offered,
  onQuoted,
  goTo,
  highlights,
  children,
}: {
  readonly target: EntryTarget;
  readonly offered: boolean;
  /** The draft took a quote: the composer takes the focus. */
  readonly onQuoted: () => void;
  readonly goTo: (entryId: EntryId) => Promise<Revealed>;
  readonly highlights: Highlights;
  readonly children: ReactNode;
}) {
  const client = useJ3Client();
  const say = useSay();
  const { t } = usePresentation().i18n;
  const [picking, setPicking] = useState<QuotableMessage | null>(null);
  const quote = useCallback(
    (added: MessageQuote) => {
      const result = client.quoteInDraft(target, added);
      if (result === "full") say(t("quote.full"));
      else if (result === "added") onQuoted();
    },
    [client, target, say, t, onQuoted],
  );
  // One value while nothing it holds changes, so the conversation's rows are not all drawn again.
  const value = useMemo<Quoting>(
    () => ({
      offered,
      reply: (message) => quote(replyTo(message)),
      quotePart: setPicking,
      goTo,
      highlights,
    }),
    [offered, quote, goTo, highlights],
  );
  return (
    <QuotingContext value={value}>
      {children}
      <Sheet
        open={picking !== null}
        title={t("quote.sheet.title")}
        onClose={() => setPicking(null)}
      >
        {picking !== null && (
          <PassagePicker
            target={target}
            message={picking}
            onQuote={(passage) => {
              setPicking(null);
              quote(passage);
            }}
          />
        )}
      </Sheet>
    </QuotingContext>
  );
}

/**
 * A message's words in a field that takes no change, to select a passage of
 * them, and Quote, which quotes what is selected. Quote waits for a
 * selection, and says why it cannot quote one too long, or one more than the
 * draft takes.
 *
 * Android selects only in a field that is enabled, so the field is one that
 * opens no keyboard, hides its caret and puts back the message's words if
 * anything changes them.
 */
function PassagePicker({
  target,
  message,
  onQuote,
}: {
  readonly target: EntryTarget;
  readonly message: QuotableMessage;
  readonly onQuote: (passage: MessageQuote) => void;
}) {
  const { t } = usePresentation().i18n;
  const draft = useDraft(target);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const passage = useMemo(
    () => passageOf(message, selection.start, selection.end),
    [message, selection],
  );
  const full = !takesPassage(draft.quotes);
  const problem = full ? t("quote.full") : passage === "too-long" ? t("quote.tooLong") : null;
  const ready = !full && passage !== null && passage !== "too-long" ? passage : null;
  return (
    <View className="gap-3">
      <Text className="text-sm text-muted-foreground">{t("quote.sheet.hint")}</Text>
      <TextInput
        value={message.text}
        multiline
        scrollEnabled={false}
        showSoftInputOnFocus={false}
        caretHidden
        accessibilityLabel={t("quote.sheet.title")}
        onSelectionChange={({ nativeEvent }) => setSelection(nativeEvent.selection)}
        className="rounded-lg border border-border bg-background px-3 py-2.5 text-base text-foreground"
      />
      {problem !== null && (
        <Text accessibilityLiveRegion="polite" className="text-xs text-muted-foreground">
          {problem}
        </Text>
      )}
      <Button
        label={t("quote.quote")}
        variant="primary"
        disabled={ready === null}
        onPress={() => {
          if (ready !== null) onQuote(ready);
        }}
      />
    </View>
  );
}
