// SPDX-License-Identifier: AGPL-3.0-or-later
import { Collapsible } from "@base-ui/react/collapsible";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { DictationHandle, SettingsSaves } from "@j3-bots/client-runtime";
import { useAnswer } from "@j3-bots/client-runtime/react";
import {
  CLOUD_PROVIDER_KEY_PAGES,
  CLOUD_PROVIDER_NAMES,
  dictationBlockWords,
  dictationFailureWords,
  languageName,
} from "@j3-bots/client-runtime/wording";
import {
  type CloudVoiceKeys,
  CloudVoiceProvider,
  DICTATION_LANGUAGES,
  type Settings,
  type VoiceSettings,
  type VoiceSettingsChange,
  VoiceWords,
} from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  CheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  InfoIcon,
  LoaderCircleIcon,
  MicIcon,
  XIcon,
} from "lucide-react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { useLoadedHandle } from "../lib/useLoadedHandle";
import type { ShellIntents, VoiceSettingsIntents } from "../shell/data";
import { littleEndian, microphoneFailureWords } from "./Dictation";
import { Section, SwitchRow } from "./SettingsSection";
import { Button } from "./ui/button";
import { ChoiceIndicator, choiceRow } from "./ui/choice";
import { lineField } from "./ui/field";
import { SkeletonRows } from "./ui/skeleton";

const providers = CloudVoiceProvider.literals;
const isProvider = Schema.is(CloudVoiceProvider);
const isWords = Schema.is(VoiceWords);

/** Where a phone dictates, as the page offers it: a provider place is `service`. */
type PhoneChoice = "automatic" | "device" | "service";
const phoneChoices: ReadonlyArray<PhoneChoice> = ["automatic", "device", "service"];

const choice = cn(
  choiceRow,
  "group/option hover:bg-muted data-checked:border-foreground/60 data-checked:bg-muted data-disabled:opacity-50 data-readonly:hover:bg-transparent",
);

/** How long the test listens, in ms. */
const TEST_LENGTH = 2000;

/**
 * Settings → Voice, one page: the dictation service and its key, a test that
 * listens for two seconds and shows the words, the language, and where a
 * phone dictates; under More, the words to always spell right and the filler
 * words. While dictation is not set up, the page says what it needs first.
 * Each change saves at once, as the notification switches do: offline, or
 * while a save is under way, the page shows what it holds and takes no
 * change. A key is saved in Secrets and never shown back.
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

/** Whether dictation through the service is ready: one chosen, its key saved, its model chosen. */
const setUp = (voice: VoiceSettings, keys: CloudVoiceKeys | null): boolean | null => {
  const provider = voice.provider ?? null;
  if (provider === null) return false;
  if (keys === null) return null;
  return keys[provider] && (provider !== "openrouter" || voice.openRouterModel !== null);
};

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
  const keys = useLoadedHandle(voice.openCloudKeys);
  const provider = shown.provider ?? null;
  const ready = setUp(shown, keys);
  // The providers' languages, and one chosen before that is not among them, as on the phone.
  const codes = new Set([
    ...DICTATION_LANGUAGES,
    ...(shown.language === "auto" ? [] : [shown.language]),
  ]);
  const languages = [...codes]
    .map((code) => ({ code, name: languageName(code, i18n) }))
    .toSorted((a, b) => a.name.localeCompare(b.name, i18n.locale));
  const phone: PhoneChoice =
    shown.place === "device" ? "device" : shown.place === "automatic" ? "automatic" : "service";
  return (
    <>
      {ready === false && (
        <p className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
          <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          {dictationBlockWords("setup", i18n)}
        </p>
      )}
      <Section title={t("voice.service")}>
        <p className="-mt-1 text-2xs text-muted-foreground">{t("voice.service.description")}</p>
        <RadioGroup
          aria-label={t("voice.service")}
          value={provider ?? "none"}
          onValueChange={(picked: unknown) => {
            if (picked === "none") onChange({ provider: null });
            else if (isProvider(picked)) onChange({ provider: picked });
          }}
          readOnly={readOnly}
          className="flex flex-col gap-1.5"
        >
          {[...providers, "none" as const].map((option) => (
            <Radio.Root key={option} value={option} className={choice}>
              <ChoiceIndicator shape="round">
                <Radio.Indicator className="size-2 rounded-pill bg-background" />
              </ChoiceIndicator>
              {option === "none" ? (
                <span className="flex flex-col">
                  <span>{t("voice.service.none")}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("voice.service.none.description")}
                  </span>
                </span>
              ) : (
                <span>{CLOUD_PROVIDER_NAMES[option]}</span>
              )}
            </Radio.Root>
          ))}
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
        {provider === "openrouter" && keys?.openrouter === true && (
          <OpenRouterModel
            value={shown.openRouterModel}
            readOnly={readOnly}
            load={voice.cloudModels}
            onChange={(openRouterModel) => onChange({ openRouterModel })}
          />
        )}
        {ready === true && <VoiceTest key={provider} voice={voice} connected={connected} />}
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
              if (!readOnly && (picked === "auto" || codes.has(picked))) {
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
      <Section title={t("voice.phone")}>
        <RadioGroup
          aria-label={t("voice.phone")}
          value={phone}
          onValueChange={(picked: unknown) => {
            if (picked === "automatic" || picked === "device") onChange({ place: picked });
            else if (picked === "service" && provider !== null) onChange({ place: provider });
          }}
          readOnly={readOnly}
          className="flex flex-col gap-1.5"
        >
          {phoneChoices.map((option) => (
            <Radio.Root
              key={option}
              value={option}
              disabled={option === "service" && provider === null}
              className={choice}
            >
              <ChoiceIndicator shape="round">
                <Radio.Indicator className="size-2 rounded-pill bg-background" />
              </ChoiceIndicator>
              <span className="flex flex-col">
                <span>{t(`voice.place.${option}`)}</span>
                <span className="text-xs text-muted-foreground">
                  {t(`voice.place.${option}.description`)}
                </span>
              </span>
            </Radio.Root>
          ))}
        </RadioGroup>
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
          <Section title={t("voice.words")}>
            <Words
              words={shown.words}
              readOnly={readOnly}
              onChange={(words) => onChange({ words })}
            />
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
 * The service's key: once saved, that it is, with Remove; until then, a
 * field to paste it and a link to where the service gives one. The key
 * typed leaves the field once saved, and a saved key is never shown back.
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
  if (saved === null) return <SkeletonRows count={1} />;
  return (
    <div className="flex flex-col gap-1.5">
      {saved ? (
        <div className="flex items-center gap-2">
          <CheckIcon aria-hidden className="size-4 shrink-0 text-success" />
          <p className="me-auto text-sm">{t("voice.cloud.key.saved")}</p>
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={busy || !connected}
            onClick={() => set(null)}
          >
            {t("voice.cloud.key.remove")}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={fieldId} className="text-xs">
              {t("voice.cloud.key", { provider: name })}
            </label>
            <a
              href={CLOUD_PROVIDER_KEY_PAGES[provider]}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-xs underline underline-offset-2"
            >
              {t("voice.cloud.key.get")}
              <ExternalLinkIcon aria-hidden className="size-3" />
            </a>
          </div>
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
        </>
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

/** How the test went: listening, being written down, and what it heard or why not. */
export type VoiceTestRun =
  | { readonly _tag: "idle" }
  | { readonly _tag: "listening" }
  | { readonly _tag: "writing" }
  | { readonly _tag: "heard"; readonly text: string }
  | { readonly _tag: "nothing" }
  | { readonly _tag: "failed"; readonly text: string };

/** A test under way: its dictation, the microphone once open, and the timer that stops it. */
interface TestUnderWay {
  readonly handle: DictationHandle;
  stop: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Ends `mine` if it is still the test under way: its timer, its microphone and its dictation. */
const releaseTest = (live: RefObject<TestUnderWay | null>, mine: TestUnderWay) => {
  if (live.current !== mine) return;
  live.current = null;
  if (mine.timer !== null) clearTimeout(mine.timer);
  mine.stop?.();
  mine.handle.cancel();
};

/**
 * Test: the microphone listens for two seconds, the service writes it down,
 * and the words show here. Nothing is kept or sent anywhere else.
 */
export function VoiceTest({
  voice,
  connected,
  initial = { _tag: "idle" },
}: {
  voice: Pick<VoiceSettingsIntents, "dictate" | "microphone" | "app">;
  connected: boolean;
  /** How it shows first, as the gallery shows each step. */
  initial?: VoiceTestRun;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [run, setRun] = useState<VoiceTestRun>(initial);
  const live = useRef<TestUnderWay | null>(null);
  const release = (mine: TestUnderWay) => releaseTest(live, mine);
  useEffect(
    () => () => {
      if (live.current !== null) releaseTest(live, live.current);
    },
    [],
  );
  const start = () => {
    if (live.current !== null || !connected) return;
    const handle = voice.dictate();
    const mine: TestUnderWay = { handle, stop: null, timer: null };
    live.current = mine;
    setRun({ _tag: "listening" });
    const finish = () => {
      if (live.current !== mine) return;
      mine.stop?.();
      mine.stop = null;
      handle.finish();
      setRun({ _tag: "writing" });
    };
    const unsubscribe = handle.state.subscribe(() => {
      const now = handle.state.get();
      if (now._tag !== "done" && now._tag !== "failed") return;
      unsubscribe();
      if (live.current !== mine) return;
      release(mine);
      setRun(
        now._tag === "failed"
          ? { _tag: "failed", text: dictationFailureWords(now.reason, i18n) }
          : now.text.trim() === ""
            ? { _tag: "nothing" }
            : { _tag: "heard", text: now.text.trim() },
      );
    });
    void voice
      .microphone({
        samples: (samples) => {
          if (live.current === mine) handle.audio(littleEndian(samples));
        },
        lost: finish,
      })
      .then((opening) => {
        if (live.current !== mine) {
          if (opening._tag === "open") opening.stop();
          return;
        }
        if (opening._tag === "failed") {
          release(mine);
          setRun({
            _tag: "failed",
            text: microphoneFailureWords(opening.reason, voice.app, i18n),
          });
          return;
        }
        mine.stop = opening.stop;
        mine.timer = setTimeout(finish, TEST_LENGTH);
      });
  };
  const busy = run._tag === "listening" || run._tag === "writing";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="secondary"
          aria-disabled={busy || !connected}
          onClick={() => {
            if (!busy) start();
          }}
        >
          {busy ? (
            <LoaderCircleIcon aria-hidden className="motion-safe:animate-spin" />
          ) : (
            <MicIcon aria-hidden />
          )}
          {t("voice.test")}
        </Button>
        <p className="text-2xs text-muted-foreground">{t("voice.test.hint")}</p>
      </div>
      <p
        role="status"
        className={cn(
          "text-sm empty:sr-only",
          run._tag === "failed" || run._tag === "nothing" ? "text-blocked" : "text-foreground",
        )}
      >
        {run._tag === "listening" && t("voice.test.listening")}
        {run._tag === "writing" && t("voice.test.writing")}
        {run._tag === "heard" && t("voice.test.heard", { text: run.text })}
        {run._tag === "nothing" && t("voice.test.nothing")}
        {run._tag === "failed" && run.text}
      </p>
    </div>
  );
}
