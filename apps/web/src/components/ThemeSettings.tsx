// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { type ThemeChoice, themeChoices } from "@j3-bots/client-runtime/presentation";
import { themeDescription, themeMakerText, themeName } from "@j3-bots/client-runtime/wording";
import { THEME_NAME_LENGTH, type ThemeDefinition, type ThemeSeed } from "@j3-bots/contracts";
import { resolveTheme } from "@j3-bots/design-tokens";
import { PlusIcon } from "lucide-react";
import { useDeferredValue, useId, useMemo, useState } from "react";
import { useBots, useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { setThemeId, usePreferences } from "../preferences/preferences";
import { ThemePreview } from "../themes/ThemePreview";
import { type ShownThemes, useShownThemes, useThemePicture } from "../themes/ThemeRuntime";
import { Button } from "./ui/button";
import { Confirm } from "./ui/confirm";
import { alertDialog, dialogBackdrop, dialogTitle } from "./ui/dialog";
import { lineField } from "./ui/field";

/**
 * Settings → Appearance's themes (decision 0104): every theme drawn small, the
 * one this device shows marked, picked by choosing another. Under them, the
 * one in use: what it is, who made it, and on a server that keeps themes,
 * whether new devices start with it, and for a saved one, Delete. The
 * operator makes their own from two colors.
 */
export function ThemeSettings({
  appearance,
}: {
  /** The appearance the previews are drawn in; the page's when left out. */
  readonly appearance?: "light" | "dark";
}) {
  const themes = useShownThemes();
  const { theme } = usePreferences();
  if (themes === null) return null;
  return <Themes themes={themes} appearance={appearance ?? theme} />;
}

function Themes({
  themes,
  appearance,
}: {
  readonly themes: ShownThemes;
  readonly appearance: "light" | "dark";
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const { themeId } = usePreferences();
  const bots = useBots();
  const library = themes.themes.library;
  const choices = useMemo(() => themeChoices(library), [library]);
  const headingId = useId();
  const groupName = useId();
  const [editing, setEditing] = useState<ThemeEditing | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const shown = themes.shown;
  const botList = useMemo(() => [...bots.values()], [bots]);

  const act = (run: () => Promise<{ readonly _tag: "done" | "failed" }>) => {
    setBusy(true);
    setFailed(false);
    void run().then((result) => {
      setBusy(false);
      setFailed(result._tag === "failed");
    });
  };

  const saved = shown !== null && shown.origin._tag !== "built-in" ? shown : null;
  const startsNew = shown !== null && library?.defaultTheme === shown.id;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span id={headingId} className="text-xs">
          {t("settings.themes")}
        </span>
        {themes.themes.supported && (
          <Button size="sm" variant="ghost-muted" onClick={() => setEditing({ _tag: "new" })}>
            <PlusIcon aria-hidden />
            {t("settings.themes.create")}
          </Button>
        )}
      </div>
      <div
        role="radiogroup"
        aria-labelledby={headingId}
        className="grid grid-cols-2 gap-2 tablet:grid-cols-3"
      >
        {choices.map((choice) => (
          <ThemeOption
            key={choice.id}
            choice={choice}
            appearance={appearance}
            name={groupName}
            checked={shown?.id === choice.id}
            maker={themeMakerText(choice, botList, i18n)}
            load={themes.intents.background}
          />
        ))}
      </div>
      {shown !== null && (
        <div className="flex flex-col gap-2 rounded-lg bg-muted px-3 py-2.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm">{themeName(shown, i18n)}</span>
            {themeDescription(shown, i18n) !== null && (
              <span className="text-xs text-muted-foreground">{themeDescription(shown, i18n)}</span>
            )}
          </div>
          {themes.themes.supported && (
            <div className="flex flex-wrap items-center gap-2">
              {startsNew ? (
                <span className="text-xs text-muted-foreground">
                  {t("settings.themes.startsNew")}
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => act(() => themes.intents.setDefault(shown.id))}
                >
                  {t("settings.themes.makeStart")}
                </Button>
              )}
              {saved !== null && saved.origin._tag === "operator" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setEditing({ _tag: "edit", choice: saved })}
                >
                  {t("settings.themes.edit")}
                </Button>
              )}
              {saved !== null && (
                <Confirm
                  trigger={<Button size="sm" variant="destructive-outline" disabled={busy} />}
                  title={t("settings.themes.delete.title", { name: themeName(saved, i18n) })}
                  body={t("settings.themes.delete.body")}
                  cancel={t("settings.themes.create.cancel")}
                  confirm={t("settings.themes.delete.confirm")}
                  busy={busy}
                  onConfirm={() =>
                    act(() =>
                      themes.intents.remove(saved.id).then((result) => {
                        // This device goes back to the theme new devices start with.
                        if (result._tag === "done" && themeId === saved.id) setThemeId(null);
                        return result;
                      }),
                    )
                  }
                >
                  {t("settings.themes.delete", { name: themeName(saved, i18n) })}
                </Confirm>
              )}
            </div>
          )}
        </div>
      )}
      {failed && (
        <p role="status" className="text-xs text-blocked">
          {t("settings.themes.failed")}
        </p>
      )}
      <ThemeFormDialog
        editing={editing}
        onClose={() => setEditing(null)}
        save={themes.intents.save}
      />
    </div>
  );
}

/** One theme in the grid: its preview, name and maker, chosen like a radio button. */
function ThemeOption({
  choice,
  appearance,
  name,
  checked,
  maker,
  load,
}: {
  readonly choice: ThemeChoice;
  readonly appearance: "light" | "dark";
  readonly name: string;
  readonly checked: boolean;
  readonly maker: string | null;
  readonly load: ShownThemes["intents"]["background"];
}) {
  const i18n = useI18n();
  const picture = useThemePicture(choice, load);
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-xl p-1.5 transition-colors duration-(--duration-fast) ease-out hover:bg-muted",
        "has-focus-visible:outline-2 has-focus-visible:outline-accent",
        checked && "bg-muted",
      )}
    >
      <input
        type="radio"
        name={name}
        value={choice.id}
        checked={checked}
        onChange={() => setThemeId(choice.id)}
        className="sr-only"
      />
      <ThemePreview
        definition={choice.definition}
        appearance={appearance}
        picture={picture}
        className={cn(checked && "outline-2 outline-offset-1 outline-accent")}
      />
      <span className="flex min-w-0 items-baseline gap-1.5 px-0.5 text-xs">
        <span className="truncate">{themeName(choice, i18n)}</span>
        {checked && (
          <span className="shrink-0 text-2xs text-muted-foreground">
            {i18n.t("settings.themes.inUse")}
          </span>
        )}
      </span>
      {maker !== null && (
        <span className="truncate px-0.5 text-2xs text-muted-foreground">{maker}</span>
      )}
    </label>
  );
}

/** What the form is open for: a new theme, or the colors of one the operator made. */
type ThemeEditing =
  | { readonly _tag: "new" }
  | { readonly _tag: "edit"; readonly choice: ThemeChoice };

function ThemeFormDialog({
  editing,
  onClose,
  save,
}: {
  readonly editing: ThemeEditing | null;
  readonly onClose: () => void;
  readonly save: ShownThemes["intents"]["save"];
}) {
  const titleId = useId();
  const { t } = useI18n();
  return (
    <Dialog.Root
      open={editing !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className={cn(dialogBackdrop, "z-50")} />
        <Dialog.Popup
          aria-labelledby={titleId}
          className={cn(alertDialog, "z-50 max-w-md gap-4 p-5")}
        >
          <Dialog.Title id={titleId} className={dialogTitle}>
            {t("settings.themes.create.title")}
          </Dialog.Title>
          {editing !== null && (
            <ThemeForm
              // Each opening starts from its own theme.
              key={editing._tag === "edit" ? editing.choice.id : "new"}
              editing={editing}
              save={save}
              onDone={onClose}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const STARTING = { canvas: "#16181d", accent: "#3d6fd9" } as const;

/** One seed of a theme as the form edits it: the dark one where there are two. */
const seedOf = (seed: ThemeSeed): string => (typeof seed === "string" ? seed : seed.dark);

/**
 * The form a theme is made from: a name and two colors, its background and
 * its accent, with the theme drawn in light and dark as they change, and
 * whether it had to be adjusted to stay readable, or cannot be. A saved
 * theme is applied on this device, as the operator made it to use it.
 */
export function ThemeForm({
  editing,
  save,
  onDone,
}: {
  readonly editing: ThemeEditing;
  readonly save: ShownThemes["intents"]["save"];
  readonly onDone: () => void;
}) {
  const { t } = useI18n();
  const before = editing._tag === "edit" ? editing.choice.definition : null;
  const [name, setName] = useState(before?.name ?? "");
  const [canvas, setCanvas] = useState(before === null ? STARTING.canvas : seedOf(before.canvas));
  const [accent, setAccent] = useState(before === null ? STARTING.accent : seedOf(before.accent));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const nameId = useId();

  // A drag in the system's picker is drawn as it can be, never held up by it.
  const drawnCanvas = useDeferredValue(canvas);
  const drawnAccent = useDeferredValue(accent);
  const trimmed = name.trim();
  const definition: ThemeDefinition = useMemo(
    () => ({
      ...before,
      name: trimmed === "" ? t("settings.themes.create.namePlaceholder") : trimmed,
      canvas: drawnCanvas,
      accent: drawnAccent,
    }),
    [before, trimmed, drawnCanvas, drawnAccent, t],
  );
  const resolution = useMemo(() => resolveTheme(definition), [definition]);

  const submit = () => {
    if (trimmed === "" || resolution._tag === "refused" || saving) return;
    setSaving(true);
    setFailed(false);
    const themeId = editing._tag === "edit" ? editing.choice.id : undefined;
    void save({ ...definition, canvas, accent }, themeId).then((result) => {
      setSaving(false);
      if (result._tag === "failed") {
        setFailed(true);
        return;
      }
      setThemeId(result.value.id);
      onDone();
    });
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-xs">
          {t("settings.themes.create.name")}
        </label>
        <input
          id={nameId}
          value={name}
          maxLength={THEME_NAME_LENGTH}
          placeholder={t("settings.themes.create.namePlaceholder")}
          onChange={(event) => setName(event.currentTarget.value)}
          className={lineField}
        />
      </div>
      <ColorField
        label={t("settings.themes.create.canvas")}
        hint={t("settings.themes.create.canvas.hint")}
        value={canvas}
        onChange={setCanvas}
      />
      <ColorField
        label={t("settings.themes.create.accent")}
        hint={t("settings.themes.create.accent.hint")}
        value={accent}
        onChange={setAccent}
      />
      <div className="grid grid-cols-2 gap-2">
        {(["light", "dark"] as const).map((appearance) => (
          <div key={appearance} className="flex flex-col gap-1">
            <ThemePreview definition={definition} appearance={appearance} />
            <span className="px-0.5 text-2xs text-muted-foreground">
              {t(appearance === "light" ? "settings.light" : "settings.dark")}
            </span>
          </div>
        ))}
      </div>
      <p
        role="status"
        className={cn(
          "text-xs",
          resolution._tag === "refused" || failed ? "text-blocked" : "text-muted-foreground",
        )}
      >
        {failed
          ? t("settings.themes.failed")
          : resolution._tag === "refused"
            ? t("settings.themes.create.refused")
            : resolution.adjustments.length > 0
              ? t("settings.themes.create.adjusted")
              : null}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onDone}>{t("settings.themes.create.cancel")}</Button>
        <Button
          type="submit"
          variant="primary"
          disabled={trimmed === "" || resolution._tag === "refused" || saving}
        >
          {t("settings.themes.create.save")}
        </Button>
      </div>
    </form>
  );
}

const HEX = /^#?([0-9a-fA-F]{6})$/;

/**
 * A color, picked with the system's picker or typed as its code. A code
 * still being typed stays in the field and changes nothing until it is whole.
 */
function ColorField({
  label,
  hint,
  value,
  onChange,
}: {
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [typed, setTyped] = useState(value);
  const [shownValue, setShownValue] = useState(value);
  // A pick in the system's picker shows its code in the field.
  if (shownValue !== value) {
    setShownValue(value);
    setTyped(value);
  }
  const pickerId = useId();
  const hintId = useId();
  const whole = HEX.exec(typed);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={pickerId} className="text-xs">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={pickerId}
          type="color"
          value={value}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.currentTarget.value.toLowerCase())}
          className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-input bg-surface p-1 pointer-coarse:h-11"
        />
        <input
          value={typed}
          aria-label={t("settings.themes.create.hex")}
          aria-invalid={whole === null}
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setTyped(next);
            const code = HEX.exec(next)?.[1];
            if (code !== undefined) onChange(`#${code.toLowerCase()}`);
          }}
          className={cn(lineField, "font-mono")}
        />
      </div>
      <span id={hintId} className="text-2xs text-muted-foreground">
        {hint}
      </span>
    </div>
  );
}
