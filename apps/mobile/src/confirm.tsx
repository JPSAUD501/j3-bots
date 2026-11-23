// SPDX-License-Identifier: AGPL-3.0-or-later
import { motion, reanimatedSpring, springs } from "@j3-bots/design-tokens";
import {
  type ComponentRef,
  createContext,
  type ReactNode,
  use,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AccessibilityInfo,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  View,
} from "react-native";
import Animated, { FadeIn, FadeOut, ZoomIn } from "react-native-reanimated";
import { useReducedMotion } from "./motion.ts";
import { Text, TextInput, displaySpacing } from "./text.tsx";
import { OVERLAY_ELEVATION, useColor } from "./theme.ts";
import { Button } from "./ui.tsx";

/** What a confirmation asks: what goes and what stays, and the two answers. */
interface Confirmation {
  readonly title: string;
  readonly body: string;
  /** The answer that keeps things as they are, which comes first. */
  readonly cancel: string;
  /** The answer that acts. */
  readonly confirm: string;
  /**
   * How the answer that acts is drawn: `blocked` for what cannot be undone,
   * the default; `accent` for a change that can be, which still asks because
   * it takes something from another bot, as making a bot the primary one does.
   */
  readonly tone?: "destructive" | "primary";
  readonly onConfirm: () => void;
}

/** What a name dialog asks for: a short name, as for a section, typed or changed. */
interface NameRequest {
  readonly title: string;
  readonly label: string;
  readonly placeholder: string;
  /** The name it starts with: empty for a new one. */
  readonly initial: string;
  readonly maxLength: number;
  readonly cancel: string;
  readonly confirm: string;
  /** Runs with the name trimmed, only when it is not empty and not `initial`. */
  readonly onConfirm: (name: string) => void;
}

type Asked =
  | { readonly _tag: "confirm"; readonly confirmation: Confirmation }
  | { readonly _tag: "name"; readonly request: NameRequest };

const AskContext = createContext<((asked: Asked) => void) | null>(null);

const pop = reanimatedSpring(springs.pop);

/**
 * Asks before something that cannot be undone, or that undoes something else,
 * in the app's own short dialog
 * rather than the system's alert, so it reads and moves like every other
 * surface: a `surface` panel over the scrim that pops in from slightly
 * smaller on `pop` and leaves on `out`. The answer that keeps things as they
 * are comes first; Back or a tap outside gives that answer too. The same
 * dialog asks for a name, with a field in place of the body, which rises
 * above the keyboard.
 */
export function Confirmations({ children }: { readonly children: ReactNode }) {
  const [asked, setAsked] = useState<Asked | null>(null);
  const reduced = useReducedMotion();
  // The modal stays up while the panel leaves, then goes, on a timer rather
  // than the animation's own end, as the New menu does, so a modal with
  // nothing left in it never stays over the app taking its touches.
  const [held, setHeld] = useState(asked);
  if (asked !== null && asked !== held) setHeld(asked);
  useEffect(() => {
    if (asked !== null || held === null) return;
    const timer = setTimeout(() => setHeld(null), reduced ? 0 : motion.state);
    return () => clearTimeout(timer);
  }, [asked, held, reduced]);
  const close = () => setAsked(null);
  return (
    <AskContext value={setAsked}>
      {children}
      <Modal
        visible={held !== null}
        transparent
        statusBarTranslucent
        animationType="none"
        onRequestClose={close}
      >
        {asked !== null && (
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            className="flex-1 items-center justify-center px-6"
          >
            <Animated.View
              entering={FadeIn.duration(motion.slow)}
              exiting={FadeOut.duration(motion.state)}
              className="absolute inset-0 bg-scrim"
            >
              <Pressable
                accessible={false}
                importantForAccessibility="no"
                onPress={close}
                className="flex-1"
              />
            </Animated.View>
            {asked._tag === "confirm" ? (
              <Panel
                title={asked.confirmation.title}
                cancel={asked.confirmation.cancel}
                confirm={asked.confirmation.confirm}
                tone={asked.confirmation.tone ?? "destructive"}
                onCancel={close}
                onConfirm={() => {
                  close();
                  asked.confirmation.onConfirm();
                }}
              >
                <Text className="text-base text-muted-foreground">{asked.confirmation.body}</Text>
              </Panel>
            ) : (
              <NamePanel
                request={asked.request}
                onCancel={close}
                onConfirm={(name) => {
                  close();
                  asked.request.onConfirm(name);
                }}
              />
            )}
          </KeyboardAvoidingView>
        )}
      </Modal>
    </AskContext>
  );
}

/**
 * The dialog itself. A screen reader starts at its title, so the question is
 * heard before the answers, then reads on to the body and Keep. That happens
 * as the panel comes in, not when the modal shows, so a confirmation asked
 * while the last one leaves, with the modal still up, is read from its title
 * too.
 */
function Panel({
  title: titleText,
  cancel,
  confirm,
  tone,
  ready = true,
  onCancel,
  onConfirm,
  children,
}: {
  readonly title: string;
  readonly cancel: string;
  readonly confirm: string;
  readonly tone: "destructive" | "primary";
  /** Whether the answer that acts can be given yet. */
  readonly ready?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  /** What the dialog says or asks under its title. */
  readonly children: ReactNode;
}) {
  const title = useRef<ComponentRef<typeof Text>>(null);
  useEffect(() => {
    if (title.current !== null) AccessibilityInfo.sendAccessibilityEvent(title.current, "focus");
  }, []);
  return (
    <Animated.View
      accessibilityViewIsModal
      entering={ZoomIn.springify()
        .mass(pop.mass)
        .stiffness(pop.stiffness)
        .damping(pop.damping)
        .withInitialValues({ transform: [{ scale: 0.94 }] })}
      exiting={FadeOut.duration(motion.state)}
      className="w-full max-w-sm gap-2 rounded-xl border border-border bg-surface p-6"
      style={{ elevation: OVERLAY_ELEVATION }}
    >
      <Text
        ref={title}
        accessibilityRole="header"
        face="display"
        className="text-xl text-foreground"
        style={{ letterSpacing: displaySpacing(20) }}
      >
        {titleText}
      </Text>
      {children}
      <View className="flex-row flex-wrap justify-end gap-2 pt-4">
        {/* Each takes its share of the row it is on, so answers that wrap stack evenly. */}
        <Button grow variant="secondary" label={cancel} onPress={onCancel} />
        <Button grow variant={tone} label={confirm} disabled={!ready} onPress={onConfirm} />
      </View>
    </Animated.View>
  );
}

/**
 * A name typed in the dialog. The field has the keyboard as the panel comes
 * in, and its Done gives the name too; the answer that acts waits for a name
 * that is not empty and, renaming, not the one it had.
 */
function NamePanel({
  request,
  onCancel,
  onConfirm,
}: {
  readonly request: NameRequest;
  readonly onCancel: () => void;
  readonly onConfirm: (name: string) => void;
}) {
  const placeholder = useColor("accent-muted-foreground");
  const [name, setName] = useState(request.initial);
  const trimmed = name.trim();
  const ready = trimmed !== "" && trimmed !== request.initial;
  const submit = () => {
    if (ready) onConfirm(trimmed);
  };
  return (
    <Panel
      title={request.title}
      cancel={request.cancel}
      confirm={request.confirm}
      tone="primary"
      ready={ready}
      onCancel={onCancel}
      onConfirm={submit}
    >
      {/* Drawn as the forms' text fields are: filled, with its label above it. */}
      <View className="gap-1 pt-2">
        <Text className="text-sm text-foreground">{request.label}</Text>
        <TextInput
          accessibilityLabel={request.label}
          value={name}
          onChangeText={setName}
          placeholder={request.placeholder}
          placeholderTextColor={placeholder}
          maxLength={request.maxLength}
          autoFocus
          autoCapitalize="sentences"
          returnKeyType="done"
          onSubmitEditing={submit}
          className="min-h-11 rounded-md bg-muted px-3 text-base text-foreground"
        />
      </View>
    </Panel>
  );
}

/**
 * Asks before something that cannot be undone, naming what goes and what
 * stays; `onConfirm` runs only once the operator agrees.
 */
export const useConfirm = (): ((confirmation: Confirmation) => void) => {
  const ask = use(AskContext);
  if (ask === null) throw new Error("useConfirm needs Confirmations above it.");
  return (confirmation) => ask({ _tag: "confirm", confirmation });
};

/** Asks for a name in the same dialog; `onConfirm` runs only with a new, non-empty one. */
export const useAskName = (): ((request: NameRequest) => void) => {
  const ask = use(AskContext);
  if (ask === null) throw new Error("useAskName needs Confirmations above it.");
  return (request) => ask({ _tag: "name", request });
};
