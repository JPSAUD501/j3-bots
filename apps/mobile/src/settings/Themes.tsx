// SPDX-License-Identifier: AGPL-3.0-or-later
import { type ThemeChoice, themeChoices } from "@j3-bots/client-runtime/presentation";
import { useConnection } from "@j3-bots/client-runtime/react";
import { themeDescription, themeMakerText, themeName } from "@j3-bots/client-runtime/wording";
import { THEME_NAME_LENGTH, type ThemeDefinition, type ThemeSeed } from "@j3-bots/contracts";
import { resolveTheme } from "@j3-bots/design-tokens";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useLayoutEffect, useMemo, useState } from "react";
import { useColorScheme, View } from "react-native";
import { FormScreen, Problem, Section, TextField, useDiscardGuard } from "../components/form.tsx";
import { useConfirm } from "../confirm.tsx";
import { useI18n } from "../i18n.ts";
import type { Navigation, Screens } from "../navigation.tsx";
import { setThemeId, usePreferences } from "../preferences.ts";
import { useBots } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text, TextInput } from "../text.tsx";
import { ThemePreview } from "../themes/ThemePreview.tsx";
import { type ShownThemes, useShownThemes } from "../themes/ThemeRuntime.tsx";
import { useColor } from "../theme.ts";
import { Body, Button, Centered } from "../ui.tsx";

type Appearance = "light" | "dark";

/** How many themes stand side by side in the grid. */
const COLUMNS = 2;

/**
 * Settings → Appearance's themes (decision 0104): every theme drawn small, in
 * the appearance this phone shows, the one in use marked, picked by tapping
 * another. Under them, the one in use: what it is, and on a server that keeps
 * themes, whether new devices start with it, and for a saved one, Delete. The
 * operator makes their own from two colors.
 */
export function ThemesSection() {
  const themes = useShownThemes();
  const appearance = useColorScheme() === "dark" ? "dark" : "light";
  if (themes === null) return null;
  return <Themes themes={themes} appearance={appearance} />;
}

function Themes({
  themes,
  appearance,
}: {
  readonly themes: ShownThemes;
  readonly appearance: Appearance;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const { themeId } = usePreferences();
  const bots = useBots();
  const navigation = useNavigation<Navigation>();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const library = themes.library;
  const choices = useMemo(() => themeChoices(library), [library]);
  const botList = useMemo(() => [...bots.values()], [bots]);
  const rows = useMemo(() => {
    const grouped: Array<ReadonlyArray<ThemeChoice>> = [];
    for (let at = 0; at < choices.length; at += COLUMNS) {
      grouped.push(choices.slice(at, at + COLUMNS));
    }
    return grouped;
  }, [choices]);
  const shown = themes.shown;
  const saved = shown !== null && shown.origin._tag !== "built-in" ? shown : null;
  const startsNew = shown !== null && library?.defaultTheme === shown.id;
  const styledElsewhere = choices.some((choice) => choice.definition.css !== undefined);

  const act = (run: () => Promise<{ readonly _tag: "done" | "failed" }>) => {
    setBusy(true);
    setFailed(false);
    void run().then((result) => {
      setBusy(false);
      setFailed(result._tag === "failed");
    });
  };

  return (
    <Section open title={t("settings.themes")}>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t("settings.themes")}
        className="gap-2"
      >
        {rows.map((row) => (
          <View key={row[0]?.id} className="flex-row gap-2">
            {row.map((choice) => (
              <ThemeOption
                key={choice.id}
                choice={choice}
                appearance={appearance}
                checked={shown?.id === choice.id}
                maker={themeMakerText(choice, botList, i18n)}
              />
            ))}
            {/* The last row keeps the grid's widths. */}
            {Array.from({ length: COLUMNS - row.length }, (_, at) => (
              <View key={at} className="flex-1" />
            ))}
          </View>
        ))}
      </View>
      {styledElsewhere && (
        <Text className="text-xs text-muted-foreground">
          {t("settings.themes.styledElsewhere")}
        </Text>
      )}
      {shown !== null && (
        <View className="gap-3 rounded-lg bg-muted px-3 py-2.5">
          <View className="gap-0.5">
            <Text className="text-base text-foreground">{themeName(shown, i18n)}</Text>
            {themeDescription(shown, i18n) !== null && (
              <Text className="text-xs text-muted-foreground">{themeDescription(shown, i18n)}</Text>
            )}
          </View>
          {themes.supported && (
            <View className="flex-row flex-wrap items-center gap-2">
              {startsNew ? (
                <Text className="text-xs text-muted-foreground">
                  {t("settings.themes.startsNew")}
                </Text>
              ) : (
                <Button
                  variant="outline"
                  label={t("settings.themes.makeStart")}
                  disabled={busy}
                  onPress={() => act(() => themes.client.setDefault(shown.id))}
                />
              )}
              {saved !== null && saved.origin._tag === "operator" && (
                <Button
                  variant="outline"
                  label={t("settings.themes.edit")}
                  disabled={busy}
                  onPress={() => navigation.navigate("themeForm", { themeId: saved.id })}
                />
              )}
              {saved !== null && (
                <Button
                  variant="destructive"
                  label={t("settings.themes.delete", { name: themeName(saved, i18n) })}
                  disabled={busy}
                  onPress={() =>
                    confirm({
                      title: t("settings.themes.delete.title", { name: themeName(saved, i18n) }),
                      body: t("settings.themes.delete.body"),
                      cancel: t("settings.themes.create.cancel"),
                      confirm: t("settings.themes.delete.confirm"),
                      onConfirm: () =>
                        act(() =>
                          themes.client.remove(saved.id).then((result) => {
                            // This phone goes back to the theme new devices start with.
                            if (result._tag === "done" && themeId === saved.id) setThemeId(null);
                            return result;
                          }),
                        ),
                    })
                  }
                />
              )}
            </View>
          )}
        </View>
      )}
      <Problem>{failed ? t("settings.themes.failed") : null}</Problem>
      {themes.supported && (
        <View className="flex-row">
          <Button
            variant="secondary"
            label={t("settings.themes.create")}
            onPress={() => navigation.navigate("themeForm", { themeId: null })}
          />
        </View>
      )}
    </Section>
  );
}

/** One theme in the grid: its preview, name and maker, chosen like a radio button. */
function ThemeOption({
  choice,
  appearance,
  checked,
  maker,
}: {
  readonly choice: ThemeChoice;
  readonly appearance: Appearance;
  readonly checked: boolean;
  readonly maker: string | null;
}) {
  const i18n = useI18n();
  const name = themeName(choice, i18n);
  return (
    <PressScale
      depth="row"
      frame={{ flex: 1 }}
      accessibilityRole="radio"
      accessibilityState={{ checked }}
      accessibilityLabel={name}
      {...(maker === null ? {} : { accessibilityHint: maker })}
      onPress={() => setThemeId(choice.id)}
      className={`gap-1 rounded-xl p-1.5 ${checked ? "bg-muted" : ""}`}
    >
      <ThemePreview
        definition={choice.definition}
        appearance={appearance}
        choice={choice}
        outlined={checked}
      />
      <View className="min-w-0 flex-row items-baseline gap-1.5 px-0.5">
        <Text numberOfLines={1} className="shrink text-sm text-foreground">
          {name}
        </Text>
        {checked && (
          <Text className="shrink-0 text-2xs text-muted-foreground">
            {i18n.t("settings.themes.inUse")}
          </Text>
        )}
      </View>
      {maker !== null && (
        <Text numberOfLines={1} className="px-0.5 text-2xs text-muted-foreground">
          {maker}
        </Text>
      )}
    </PressScale>
  );
}

type Props = NativeStackScreenProps<Screens, "themeForm">;

/**
 * Makes a theme from two colors (`themeId` null), or changes the colors of
 * one the operator made, on a screen of its own.
 */
export function ThemeFormScreen({ navigation, route }: Props) {
  const { t } = useI18n();
  const themes = useShownThemes();
  const { themeId } = route.params;
  useLayoutEffect(() => {
    navigation.setOptions({ title: t("settings.themes.create.title") });
  }, [navigation, t]);
  const choice =
    themeId === null || themes === null
      ? null
      : (themeChoices(themes.library).find((found) => found.id === themeId) ?? null);
  if (themes === null || (themeId !== null && choice === null && !themes.known)) {
    return <View className="flex-1 bg-background" />;
  }
  if (themeId !== null && choice === null) {
    // Deleted, here or from another device.
    return (
      <View className="flex-1 bg-background">
        <Centered>
          <Body>{t("message.offer.applyTheme.gone")}</Body>
          <Button
            variant="secondary"
            label={t("settings.themes.create.cancel")}
            onPress={navigation.goBack}
          />
        </Centered>
      </View>
    );
  }
  return (
    <ThemeForm
      // Each opening starts from its own theme.
      key={choice?.id ?? "new"}
      before={choice}
      save={themes.client.save}
      onClose={navigation.goBack}
    />
  );
}

const STARTING = { canvas: "#16181d", accent: "#3d6fd9" } as const;

/** Grounds to start from: dark and light, warm and cool. */
const CANVAS_PRESETS = ["#16181d", "#0f1a2b", "#1d2a22", "#2a1f2e", "#f7f5f0", "#eef2f7"] as const;
/** Accents to start from, around the color wheel. */
const ACCENT_PRESETS = ["#3d6fd9", "#2f9e72", "#d9653d", "#b04fd1", "#d94f7a", "#c99a2e"] as const;

/** One seed of a theme as the form edits it: the dark one where there are two. */
const seedOf = (seed: ThemeSeed): string => (typeof seed === "string" ? seed : seed.dark);

/**
 * The form a theme is made from: a name and two colors, its background and
 * its accent, with the theme drawn in light and dark as they change, and
 * whether it had to be adjusted to stay readable, or cannot be. A saved
 * theme is applied on this phone, as the operator made it to use it.
 */
function ThemeForm({
  before,
  save,
  onClose,
}: {
  readonly before: ThemeChoice | null;
  readonly save: ShownThemes["client"]["save"];
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const connected = useConnection()._tag === "connected";
  const was = before?.definition ?? null;
  const startName = was?.name ?? "";
  const startCanvas = was === null ? STARTING.canvas : seedOf(was.canvas);
  const startAccent = was === null ? STARTING.accent : seedOf(was.accent);
  const [name, setName] = useState(startName);
  const [canvas, setCanvas] = useState(startCanvas);
  const [accent, setAccent] = useState(startAccent);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const unsaved = name !== startName || canvas !== startCanvas || accent !== startAccent;
  const leave = useDiscardGuard(unsaved && !saving);

  const trimmed = name.trim();
  const definition: ThemeDefinition = useMemo(
    () => ({
      ...was,
      name: trimmed === "" ? t("settings.themes.create.namePlaceholder") : trimmed,
      canvas,
      accent,
    }),
    [was, trimmed, canvas, accent, t],
  );
  const resolution = useMemo(() => resolveTheme(definition), [definition]);
  const refused = resolution._tag === "refused";

  const submit = () => {
    if (trimmed === "" || refused || saving) return;
    setSaving(true);
    setFailed(false);
    void save(definition, before?.id).then((result) => {
      setSaving(false);
      if (result._tag === "failed") {
        setFailed(true);
        return;
      }
      setThemeId(result.value.id);
      leave(onClose);
    });
  };

  return (
    <FormScreen
      problem={failed ? t("settings.themes.failed") : null}
      offline={!connected}
      actions={
        <>
          <Button label={t("settings.themes.create.cancel")} onPress={onClose} />
          <Button
            variant="primary"
            label={t("settings.themes.create.save")}
            disabled={trimmed === "" || refused}
            held={saving}
            onPress={submit}
          />
        </>
      }
    >
      <TextField
        label={t("settings.themes.create.name")}
        value={name}
        onChange={setName}
        placeholder={t("settings.themes.create.namePlaceholder")}
        maxLength={THEME_NAME_LENGTH}
        autoCapitalize="sentences"
      />
      <ColorField
        label={t("settings.themes.create.canvas")}
        hint={t("settings.themes.create.canvas.hint")}
        presets={CANVAS_PRESETS}
        value={canvas}
        onChange={setCanvas}
      />
      <ColorField
        label={t("settings.themes.create.accent")}
        hint={t("settings.themes.create.accent.hint")}
        presets={ACCENT_PRESETS}
        value={accent}
        onChange={setAccent}
      />
      <View className="flex-row gap-2">
        {(["light", "dark"] as const).map((appearance) => (
          <View key={appearance} className="flex-1 gap-1">
            <ThemePreview definition={definition} appearance={appearance} />
            <Text className="px-0.5 text-2xs text-muted-foreground">
              {t(appearance === "light" ? "settings.light" : "settings.dark")}
            </Text>
          </View>
        ))}
      </View>
      {refused ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-blocked">
          {t("settings.themes.create.refused")}
        </Text>
      ) : resolution.adjustments.length > 0 ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-muted-foreground">
          {t("settings.themes.create.adjusted")}
        </Text>
      ) : null}
    </FormScreen>
  );
}

const HEX = /^#?([0-9a-fA-F]{6})$/;

/**
 * A color, picked from a few to start from or typed as its code. A code
 * still being typed stays in the field and changes nothing until it is whole.
 */
function ColorField({
  label,
  hint,
  presets,
  value,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly presets: ReadonlyArray<string>;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const placeholderColor = useColor("accent-muted-foreground");
  const [typed, setTyped] = useState(value);
  const [shownValue, setShownValue] = useState(value);
  // A swatch picked shows its code in the field.
  if (shownValue !== value) {
    setShownValue(value);
    setTyped(value);
  }
  const whole = HEX.exec(typed) !== null;
  return (
    <View className="gap-2">
      <View className="gap-0.5">
        <Text className="text-sm text-foreground">{label}</Text>
        <Text className="text-xs text-muted-foreground">{hint}</Text>
      </View>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
        className="flex-row flex-wrap"
      >
        {presets.map((preset) => {
          const selected = preset === value;
          return (
            <PressScale
              key={preset}
              depth="round"
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              accessibilityLabel={preset}
              onPress={() => onChange(preset)}
              className="size-11 items-center justify-center"
            >
              <View
                className={`size-9 items-center justify-center rounded-pill border-2 ${selected ? "border-foreground" : "border-transparent"}`}
              >
                <View
                  className="size-7 rounded-pill border border-border"
                  style={{ backgroundColor: preset }}
                />
              </View>
            </PressScale>
          );
        })}
      </View>
      <View className="flex-row items-center gap-2">
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="size-11 rounded-md border border-input"
          style={{ backgroundColor: value }}
        />
        <TextInput
          accessibilityLabel={t("settings.themes.create.hex")}
          accessibilityHint={label}
          aria-invalid={!whole}
          value={typed}
          onChangeText={(next) => {
            setTyped(next);
            const code = HEX.exec(next)?.[1];
            if (code !== undefined) onChange(`#${code.toLowerCase()}`);
          }}
          placeholder={t("settings.themes.create.hex")}
          placeholderTextColor={placeholderColor}
          maxLength={7}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          face="mono"
          className={`min-h-11 flex-1 rounded-md border bg-muted px-3 text-base text-foreground ${whole ? "border-transparent" : "border-blocked"}`}
        />
      </View>
    </View>
  );
}
