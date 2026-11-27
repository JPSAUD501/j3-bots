// SPDX-License-Identifier: AGPL-3.0-or-later
import { Collapsible } from "@base-ui/react/collapsible";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { SettingsSaves } from "@j3-bots/client-runtime";
import { useAnswer } from "@j3-bots/client-runtime/react";
import {
  CLOUD_PROVIDER_NAMES,
  languageName,
  sizeWords,
  voiceModelWords,
  voicePlaceWords,
} from "@j3-bots/client-runtime/wording";
import {
  type CloudVoiceProvider,
  cloudProviderOf,
  type Settings,
  type VoiceInstall,
  type VoiceModel,
  VoicePlace,
  type VoiceSettings,
  type VoiceSettingsChange,
  VoiceWords,
} from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChevronRightIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { useLoadedHandle } from "../lib/useLoadedHandle";
import type { ShellIntents, VoiceSettingsIntents } from "../shell/data";
import { Section, SwitchRow } from "./SettingsSection";
import { Button } from "./ui/button";
import { ChoiceIndicator, choiceRow } from "./ui/choice";
import { lineField } from "./ui/field";
import { SkeletonRows } from "./ui/skeleton";

const places = VoicePlace.literals;
const isPlace = Schema.is(VoicePlace);
const isWords = Schema.is(VoiceWords);

const choice = cn(
  choiceRow,
  "group/option hover:bg-muted data-checked:border-foreground/60 data-checked:bg-muted data-readonly:hover:bg-transparent",
);

/**
 * Settings → Voice: where dictation turns speech into words, its language,
 * the words it always spells right and whether it takes filler words out;
 * under More, the server's speech model and the AI's tidy-up. Each change
 * saves at once, as the notification switches do: offline, or while a save
 * is under way, the page shows what it holds and takes no change. With a
 * cloud provider chosen, its key, which is saved in Secrets and never shown
 * back, and for OpenRouter the model it transcribes with.
 */
export function VoiceSection({
  settings,
  save,
  connected,
  onSave,
  voice,
}: {
  settings: Settings | null;
  save: SettingsSaves["voice"];
  connected: boolean;
  onSave: ShellIntents["updateSettings"];
  voice: VoiceSettingsIntents;
}) {
  const saving = save._tag === "saving";
  // A save under way when the page opened is followed, so its failure shows.
  const [watching, setWatching] = useState(saving);
  if (settings?.voice == null) {
    return (
      <Section>
        <SkeletonRows />
      </Section>
    );
  }
  const shown: VoiceSettings = { ...settings.voice, ...(saving ? save.changes : undefined) };
  const readOnly = saving || !connected;
  const change = (changes: VoiceSettingsChange) => {
    if (readOnly) return;
    setWatching(true);
    onSave({ section: "voice", changes });
  };
  return (
    <VoiceForm
      shown={shown}
      readOnly={readOnly}
      failed={watching && save._tag === "failed"}
      connected={connected}
      onChange={change}
      voice={voice}
    />
  );
}

function VoiceForm({
  shown,
  readOnly,
  failed,
  connected,
  onChange,
  voice,
}: {
  shown: VoiceSettings;
  readOnly: boolean;
  failed: boolean;
  connected: boolean;
  onChange: (changes: VoiceSettingsChange) => void;
  voice: VoiceSettingsIntents;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const languageId = useId();
  const status = useLoadedHandle(voice.openStatus);
  const keys = useLoadedHandle(voice.openCloudKeys);
  const provider = cloudProviderOf(shown.place);
  // The languages the server's model hears, and the one chosen, by name.
  const languages = [
    ...new Set([
      ...(status?._tag === "available" ? status.model.languages : []),
      ...(shown.language === "auto" ? [] : [shown.language]),
    ]),
  ]
    .map((code) => ({ code, name: languageName(code, i18n) }))
    .toSorted((a, b) => a.name.localeCompare(b.name, i18n.locale));
  return (
    <>
      <Section title={t("voice.place")}>
        <RadioGroup
          aria-label={t("voice.place")}
          value={shown.place}
          onValueChange={(picked: unknown) => {
            if (isPlace(picked)) onChange({ place: picked });
          }}
          readOnly={readOnly}
          className="flex flex-col gap-1.5"
        >
          {places.map((place) => {
            const words = voicePlaceWords(place, i18n);
            return (
              <Radio.Root key={place} value={place} className={choice}>
                <ChoiceIndicator shape="round">
                  <Radio.Indicator className="size-2 rounded-pill bg-background" />
                </ChoiceIndicator>
                <span className="flex flex-col">
                  <span>{words.label}</span>
                  <span className="text-xs text-muted-foreground">{words.description}</span>
                </span>
              </Radio.Root>
            );
          })}
        </RadioGroup>
        {provider !== null && (
          <CloudKey
            key={provider}
            provider={provider}
            saved={keys === null ? null : keys[provider]}
            connected={connected}
            onSet={voice.setCloudKey}
          />
        )}
        {provider === "openrouter" && (
          <OpenRouterModel
            value={shown.openRouterModel}
            readOnly={readOnly}
            load={voice.cloudModels}
            onChange={(openRouterModel) => onChange({ openRouterModel })}
          />
        )}
      </Section>
      <Section>
        <div className="flex flex-col gap-1">
          <label htmlFor={languageId} className="text-xs">
            {t("voice.language")}
          </label>
          <select
            id={languageId}
            value={shown.language}
            aria-readonly={readOnly}
            onChange={(event) => {
              const picked = event.currentTarget.value;
              if (
                !readOnly &&
                (picked === "auto" || languages.some((one) => one.code === picked))
              ) {
                onChange({ language: picked });
              }
            }}
            className={lineField}
          >
            <option value="auto">{t("voice.language.auto")}</option>
            {languages.map(({ code, name }) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </div>
      </Section>
      <Section title={t("voice.words")}>
        <Words words={shown.words} readOnly={readOnly} onChange={(words) => onChange({ words })} />
      </Section>
      <Section>
        <SwitchRow
          label={t("voice.removeFillers")}
          hint={t("voice.removeFillers.description")}
          checked={shown.removeFillers}
          readOnly={readOnly}
          onChange={(removeFillers) => onChange({ removeFillers })}
        />
      </Section>
      <Collapsible.Root className="flex flex-col gap-3">
        <Collapsible.Trigger className="pressable group -ms-2 flex min-h-8 items-center gap-1.5 self-start rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 transition-transform duration-(--duration-pop) ease-pop group-data-panel-open:rotate-90 rtl:-scale-x-100"
          />
          {t("voice.more")}
        </Collapsible.Trigger>
        <Collapsible.Panel className="flex h-(--collapsible-panel-height) flex-col gap-6 overflow-hidden transition-[height,opacity] duration-(--duration-slide) ease-slide data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0">
          <Section title={t("voice.model")}>
            <Models
              chosen={shown.model}
              installing={status?._tag === "available" ? status.installing : null}
              readOnly={readOnly}
              load={voice.models}
              onChange={(model) => onChange({ model })}
            />
          </Section>
          <Section>
            <SwitchRow
              label={t("voice.cleanUp")}
              hint={t("voice.cleanUp.description")}
              checked={shown.cleanUp}
              readOnly={readOnly}
              onChange={(cleanUp) => onChange({ cleanUp })}
            />
          </Section>
        </Collapsible.Panel>
      </Collapsible.Root>
      {/* Exposed while empty, so a failure that arrives later is announced. */}
      <p role="status" className="text-xs text-blocked empty:sr-only">
        {failed && t("settings.saveFailed")}
      </p>
      {!connected && <p className="text-xs text-muted-foreground">{t("settings.save.offline")}</p>}
    </>
  );
}

/**
 * The words dictation always spells right, each removable, and a field to add
 * one. A word already there, in any case, or one past the limits, adds nothing.
 */
function Words({
  words,
  readOnly,
  onChange,
}: {
  words: ReadonlyArray<string>;
  readOnly: boolean;
  onChange: (words: ReadonlyArray<string>) => void;
}) {
  const { t } = useI18n();
  const descriptionId = useId();
  const [typed, setTyped] = useState("");
  const next = [...words, typed.trim()];
  const addable = typed.trim() !== "" && isWords(next);
  return (
    <div className="flex flex-col gap-2">
      <p id={descriptionId} className="text-2xs text-muted-foreground">
        {t("voice.words.description")}
      </p>
      {words.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {words.map((word) => (
            <li
              key={word}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-muted ps-2.5 pe-1 text-sm"
            >
              {word}
              <button
                type="button"
                aria-label={t("voice.words.remove", { word })}
                aria-disabled={readOnly}
                onClick={() => {
                  if (!readOnly) onChange(words.filter((one) => one !== word));
                }}
                className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground aria-disabled:opacity-50"
              >
                <XIcon aria-hidden className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (readOnly || !addable) return;
          onChange(next);
          setTyped("");
        }}
      >
        <input
          value={typed}
          maxLength={50}
          readOnly={readOnly}
          placeholder={t("voice.words.placeholder")}
          aria-label={t("voice.words.placeholder")}
          aria-describedby={descriptionId}
          onChange={(event) => setTyped(event.currentTarget.value)}
          className={lineField}
        />
        <Button type="submit" size="sm" aria-disabled={readOnly || !addable} className="h-9">
          {t("voice.words.add")}
        </Button>
      </form>
    </div>
  );
}

/**
 * The cloud provider's key: whether one is saved, a field to save one, and a
 * way to remove it. The key typed leaves the field once saved, and a saved key
 * is never shown back.
 */
function CloudKey({
  provider,
  saved,
  connected,
  onSet,
}: {
  provider: CloudVoiceProvider;
  /** Null while it is not known yet. */
  saved: boolean | null;
  connected: boolean;
  onSet: VoiceSettingsIntents["setCloudKey"];
}) {
  const { t } = useI18n();
  const fieldId = useId();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<"save" | "remove" | null>(null);
  const name = CLOUD_PROVIDER_NAMES[provider];
  const set = (value: Redacted.Redacted<string> | null) => {
    if (busy || !connected) return;
    setBusy(true);
    setFailure(null);
    void onSet(provider, value).then((result) => {
      setBusy(false);
      if (result._tag === "failed") setFailure(value === null ? "remove" : "save");
      else if (value !== null) setKey("");
    });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-xs">
        {t("voice.cloud.key", { provider: name })}
      </label>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (key.trim() !== "") set(Redacted.make(key.trim()));
        }}
      >
        <input
          id={fieldId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          maxLength={10_000}
          placeholder={t("voice.cloud.key.placeholder")}
          onChange={(event) => setKey(event.currentTarget.value)}
          className={lineField}
        />
        <Button
          type="submit"
          size="sm"
          className="h-9"
          aria-disabled={busy || !connected || key.trim() === ""}
        >
          {t("voice.cloud.key.save")}
        </Button>
      </form>
      {saved === true && (
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">{t("voice.cloud.key.saved")}</p>
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={busy || !connected}
            onClick={() => set(null)}
          >
            {t("voice.cloud.key.remove")}
          </Button>
        </div>
      )}
      <p role="status" className="text-xs text-blocked empty:sr-only">
        {failure === "save" && t("voice.cloud.key.failed")}
        {failure === "remove" && t("voice.cloud.key.removeFailed")}
      </p>
    </div>
  );
}

/** The model OpenRouter transcribes with, picked from those it offers now. */
function OpenRouterModel({
  value,
  readOnly,
  load,
  onChange,
}: {
  value: VoiceSettings["openRouterModel"];
  readOnly: boolean;
  load: VoiceSettingsIntents["cloudModels"];
  onChange: (model: VoiceSettings["openRouterModel"]) => void;
}) {
  const { t } = useI18n();
  const fieldId = useId();
  const { answer } = useAnswer("openrouter", load);
  if (answer._tag === "loading") return <SkeletonRows count={1} />;
  if (answer._tag === "failed") {
    return <p className="text-xs text-muted-foreground">{t("voice.cloud.model.failed")}</p>;
  }
  if (answer.value.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("voice.cloud.model.none")}</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={fieldId} className="text-xs">
        {t("voice.cloud.model")}
      </label>
      <select
        id={fieldId}
        value={value ?? ""}
        aria-readonly={readOnly}
        onChange={(event) => {
          const picked = answer.value.find((model) => model.id === event.currentTarget.value);
          if (!readOnly && picked !== undefined) onChange(picked.id);
        }}
        className={lineField}
      >
        {value === null && (
          <option value="" disabled>
            {t("voice.cloud.model.pick")}
          </option>
        )}
        {answer.value.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The server's speech models, each in the terms one is chosen by, the one J3
 * Bots picks marked. Choosing it saves no choice (`model: null`), so the
 * server's pick follows J3 Bots'. A download under way shows how far it got.
 */
function Models({
  chosen,
  installing,
  readOnly,
  load,
  onChange,
}: {
  chosen: VoiceSettings["model"];
  installing: VoiceInstall | null;
  readOnly: boolean;
  load: VoiceSettingsIntents["models"];
  onChange: (model: VoiceSettings["model"]) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const { answer } = useAnswer("models", load);
  if (answer._tag === "loading") return <SkeletonRows count={2} />;
  if (answer._tag === "failed") {
    return <p className="text-xs text-muted-foreground">{t("voice.models.failed")}</p>;
  }
  const models: ReadonlyArray<VoiceModel> = answer.value;
  const current = chosen ?? models.find((model) => model.recommended)?.id ?? null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-2xs text-muted-foreground">{t("voice.model.description")}</p>
      <RadioGroup
        aria-label={t("voice.model")}
        value={current}
        onValueChange={(picked: unknown) => {
          const model = models.find((one) => one.id === picked);
          if (model !== undefined) onChange(model.recommended ? null : model.id);
        }}
        readOnly={readOnly}
        className="flex flex-col gap-1.5"
      >
        {models.map((model) => {
          const download = installing?.modelId === model.id ? installing : null;
          return (
            <Radio.Root key={model.id} value={model.id} className={choice}>
              <ChoiceIndicator shape="round">
                <Radio.Indicator className="size-2 rounded-pill bg-background" />
              </ChoiceIndicator>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-x-2">
                  <span>{model.name}</span>
                  {model.recommended && (
                    <span className="text-2xs font-medium text-accent">
                      {t("voice.model.recommended")}
                    </span>
                  )}
                  {model.installed && download === null && (
                    <span className="text-2xs text-muted-foreground">
                      {t("voice.model.installed")}
                    </span>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  {voiceModelWords(model, i18n).join(" · ")}
                </span>
                {download !== null && (
                  <span className="text-xs text-foreground tabular-nums">
                    {t("voice.model.installing", {
                      received: sizeWords(download.received, i18n),
                      total: sizeWords(download.total, i18n),
                    })}
                  </span>
                )}
              </span>
            </Radio.Root>
          );
        })}
      </RadioGroup>
    </div>
  );
}
