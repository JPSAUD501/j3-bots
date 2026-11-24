// SPDX-License-Identifier: AGPL-3.0-or-later
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import { Check } from "lucide-react-native";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Text, TextInput } from "../text.tsx";
import { KeyboardAwareScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConfirm } from "../confirm.tsx";
import { useI18n } from "../i18n.ts";
import Animated, {
  cancelAnimation,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useReducedMotion } from "../motion.ts";
import { useColor } from "../theme.ts";
import { PressScale } from "../press.tsx";
import { Button, Switch } from "../ui.tsx";
import { Icon } from "./Icon.tsx";

// The parts the details, the forms and Settings are built from. Each owns its
// look: callers pick what to show, they do not restyle.

/**
 * A titled part of a screen, ruled off from the next; an `open` one, as in the
 * details, is set apart by space alone.
 */
export function Section(props: {
  /** None, or undefined, for a section the screen's own title names. */
  readonly title?: string | undefined;
  /** Beside the title, at its end. */
  readonly action?: ReactNode;
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <View
      className={props.open === true ? "gap-2 px-5 pt-6" : "gap-3 border-b border-border px-4 py-4"}
    >
      {props.title !== undefined && (
        <View className="flex-row items-center justify-between gap-2">
          <Text accessibilityRole="header" className="text-xs font-medium text-muted-foreground">
            {props.title}
          </Text>
          {props.action}
        </View>
      )}
      {props.children}
    </View>
  );
}

/** A quiet sentence, as for what a list holds when it is empty. */
export function Quiet(props: { readonly children: ReactNode }) {
  return <Text className="text-sm text-muted-foreground">{props.children}</Text>;
}

/**
 * The shape of rows still loading, as tall as the rows that replace them, so
 * the screen does not shift while it is read. They breathe slowly; reduced
 * motion keeps them still. Screen readers hear "Loading…".
 */
export function SkeletonRows(props: { readonly count?: number }) {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reduced) {
      opacity.set(1);
      return;
    }
    opacity.set(withRepeat(withTiming(0.5, { duration: 1400 }), -1, true));
    return () => cancelAnimation(opacity);
  }, [reduced, opacity]);
  const breathing = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    // The fade in and the breathing each own a view, so neither overrides the other's opacity.
    <Animated.View
      accessible
      accessibilityLabel={t("details.loading")}
      entering={FadeIn.delay(150)}
    >
      <Animated.View style={breathing}>
        {Array.from({ length: props.count ?? 2 }, (_, index) => (
          <View key={index} className="min-h-11 flex-row items-center gap-3 py-2">
            <View className="size-5 rounded-sm bg-muted" />
            <View className="flex-1 gap-2">
              <View className="h-3 w-2/3 rounded-sm bg-muted" />
              <View className="h-2.5 w-1/3 rounded-sm bg-muted" />
            </View>
          </View>
        ))}
      </Animated.View>
    </Animated.View>
  );
}

/** What went wrong, read out as it appears. Nothing shows while `children` is null. */
export function Problem(props: { readonly children: string | null }) {
  if (props.children === null) return null;
  return (
    <Text accessibilityLiveRegion="polite" role="alert" className="text-sm text-blocked">
      {props.children}
    </Text>
  );
}

/** Filled, with no outline until something is wrong with it: its label and its text say it is a field. */
const fieldClass = "min-h-11 rounded-md border bg-muted px-3 text-base";

/** A labelled text field, with a hint under it and, once something is wrong, why. */
export function TextField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly hint?: string;
  readonly error?: string | null;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly readOnly?: boolean;
  readonly multiline?: boolean;
  readonly autoCapitalize?: "none" | "sentences" | "words";
  readonly onBlur?: () => void;
}) {
  const placeholderColor = useColor("accent-muted-foreground");
  const error = props.error ?? null;
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        accessibilityHint={props.hint}
        aria-invalid={error !== null}
        value={props.value}
        onChangeText={props.onChange}
        onBlur={props.onBlur}
        editable={props.readOnly !== true}
        placeholder={props.placeholder}
        placeholderTextColor={placeholderColor}
        maxLength={props.maxLength}
        multiline={props.multiline === true}
        autoCapitalize={props.autoCapitalize ?? "sentences"}
        autoCorrect={props.multiline === true}
        textAlignVertical={props.multiline === true ? "top" : "center"}
        className={`${fieldClass} ${error === null ? "border-transparent" : "border-blocked"} ${props.readOnly === true ? "text-muted-foreground" : "text-foreground"} ${props.multiline === true ? "min-h-28 py-2" : ""}`}
      />
      {props.hint !== undefined && (
        <Text className="text-xs text-muted-foreground">{props.hint}</Text>
      )}
      <Problem>{error}</Problem>
    </View>
  );
}

/**
 * One option of a choice, at least 44 px tall: a round mark for one of
 * several, a square one for any number. An unavailable option stays in reach
 * of a screen reader and does nothing.
 */
export function ChoiceRow(props: {
  readonly kind: "one" | "any";
  readonly label: string;
  readonly description?: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly unavailable?: boolean;
  /** Before the label, as a bot's shape. */
  readonly leading?: ReactNode;
}) {
  const unavailable = props.unavailable === true;
  return (
    <PressScale
      depth="row"
      accessibilityRole={props.kind === "one" ? "radio" : "checkbox"}
      accessibilityState={
        props.kind === "one"
          ? { selected: props.selected, disabled: unavailable }
          : { checked: props.selected, disabled: unavailable }
      }
      accessibilityLabel={props.label}
      accessibilityHint={props.description}
      onPress={() => {
        if (!unavailable) props.onPress();
      }}
      className={`min-h-11 flex-row items-center gap-3 rounded-md border px-3 py-2 ${props.selected ? "border-foreground bg-muted" : "border-border"}`}
    >
      <View
        className={`size-5 items-center justify-center border ${props.kind === "one" ? "rounded-pill" : "rounded-sm"} ${props.selected ? "border-foreground bg-foreground" : "border-input"}`}
      >
        {props.selected &&
          (props.kind === "one" ? (
            <View className="size-2 rounded-pill bg-background" />
          ) : (
            <Icon icon={Check} size={12} color="accent-background" />
          ))}
      </View>
      {props.leading}
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          className={`text-base ${unavailable && !props.selected ? "text-muted-foreground" : "text-foreground"}`}
        >
          {props.label}
        </Text>
        {props.description !== undefined && (
          <Text className="text-xs text-muted-foreground">{props.description}</Text>
        )}
      </View>
    </PressScale>
  );
}

/**
 * A few choices side by side in one pill, one of them picked: the picked one
 * a raised `surface` segment, the others quiet text on `muted`, as on the web.
 * For two to four short choices; more, or long ones, are `ChoiceRow`s.
 */
export function Segmented<T extends string>(props: {
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
  /** Names the group for screen readers. */
  readonly label: string;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={props.label}
      className="flex-row gap-1 rounded-pill bg-muted p-1"
    >
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <PressScale
            key={option.value}
            frame={{ flex: 1 }}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={option.label}
            onPress={() => props.onChange(option.value)}
            className={`min-h-11 items-center justify-center rounded-pill px-3 ${selected ? "bg-surface" : ""}`}
          >
            <Text
              numberOfLines={1}
              className={`text-sm font-medium ${selected ? "text-foreground" : "text-muted-foreground"}`}
            >
              {option.label}
            </Text>
          </PressScale>
        );
      })}
    </View>
  );
}

/** A setting that is on or off: its name and what it does, beside the switch. */
export function SwitchRow(props: {
  readonly label: string;
  readonly hint?: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  /** Shows the value it holds and takes no change, as while a save is under way. */
  readonly readOnly?: boolean;
}) {
  return (
    <View className="min-h-11 flex-row items-center gap-3">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base text-foreground">{props.label}</Text>
        {props.hint !== undefined && (
          <Text className="text-xs text-muted-foreground">{props.hint}</Text>
        )}
      </View>
      <Switch
        accessibilityLabel={props.label}
        accessibilityHint={props.hint}
        value={props.value}
        onChange={props.onChange}
        disabled={props.readOnly === true}
      />
    </View>
  );
}

/**
 * A form on a screen of its own: its fields scroll, and the bar under them,
 * which says why it did not save and holds what it does, rides on the
 * keyboard, so Save stays in reach while typing.
 */
export function FormScreen(props: {
  readonly children: ReactNode;
  readonly problem: string | null;
  /** Saving takes a connection: offline, the bar says so. */
  readonly offline: boolean;
  /** The bar's buttons. */
  readonly actions: ReactNode;
}) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const [footerHeight, setFooterHeight] = useState(0);
  return (
    <View className="flex-1 bg-background">
      <KeyboardAwareScrollView
        bottomOffset={footerHeight + 8}
        keyboardShouldPersistTaps="handled"
        // A library's view: it takes styles, not classes.
        contentContainerStyle={{ gap: 20, padding: 16 }}
      >
        {props.children}
      </KeyboardAwareScrollView>
      <KeyboardStickyView offset={{ closed: 0, opened: insets.bottom }}>
        <View
          onLayout={(event) => setFooterHeight(event.nativeEvent.layout.height)}
          className="gap-2 border-t border-border bg-background px-4 pt-3"
          style={{ paddingBottom: insets.bottom + 12 }}
        >
          <Problem>{props.problem}</Problem>
          {props.offline && (
            <Text className="text-sm text-muted-foreground">{t("settings.save.offline")}</Text>
          )}
          <View className="flex-row flex-wrap justify-end gap-2">{props.actions}</View>
        </View>
      </KeyboardStickyView>
    </View>
  );
}

/** A button that takes no second press until what it started has an answer. */
export function PendingButton(props: {
  readonly label: string;
  readonly onPress: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="secondary"
      label={props.label}
      disabled={pending}
      onPress={() => {
        setPending(true);
        void props.onPress().finally(() => setPending(false));
      }}
    />
  );
}

/**
 * Deletes, once the operator agrees to the question it asks, and takes no
 * press until the server has answered.
 */
export function DeleteButton(props: {
  readonly label: string;
  readonly title: string;
  readonly body: string;
  readonly cancel: string;
  readonly onDelete: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="destructive"
      label={props.label}
      disabled={pending}
      onPress={() =>
        confirm({
          title: props.title,
          body: props.body,
          cancel: props.cancel,
          confirm: props.label,
          onConfirm: () => {
            setPending(true);
            void props.onDelete().finally(() => setPending(false));
          },
        })
      }
    />
  );
}

/**
 * While `unsaved`, leaving the screen, by its back button, the system's back
 * or a swipe, asks first, so what the operator typed is never thrown away by
 * a stray gesture. A caller passes false while a save is under way: the save
 * goes on, and says in a toast if it fails. `onLeave` runs once the screen is
 * really left, never while it only asks. Returns what leaves without asking,
 * as once a save went through: `go` is the navigation that leaves.
 */
export function useDiscardGuard(unsaved: boolean, onLeave?: () => void): (go: () => void) => void {
  const { t } = useI18n();
  const confirm = useConfirm();
  const navigation = useNavigation();
  const leaving = useRef(false);
  const guarded = useRef(unsaved);
  const left = useRef(onLeave);
  useLayoutEffect(() => {
    guarded.current = unsaved;
    left.current = onLeave;
  });
  // Every removal passes here; one the guard holds back is left to the question below.
  useEffect(
    () =>
      navigation.addListener("beforeRemove", () => {
        if (!guarded.current || leaving.current) left.current?.();
      }),
    [navigation],
  );
  usePreventRemove(unsaved, ({ data }) => {
    if (leaving.current) {
      navigation.dispatch(data.action);
      return;
    }
    confirm({
      title: t("form.discard.title"),
      body: t("form.discard.body"),
      cancel: t("form.discard.keep"),
      confirm: t("form.discard"),
      // The action goes again past the screens it already asked, so nothing above runs for it.
      onConfirm: () => {
        left.current?.();
        navigation.dispatch(data.action);
      },
    });
  });
  return (go) => {
    leaving.current = true;
    go();
  };
}
