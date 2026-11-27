// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type DictationState,
  type IntentResult,
  type SettingsSaves,
} from "@j3-bots/client-runtime";
import { dictationPath } from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable, useSettings } from "@j3-bots/client-runtime/react";
import {
  CLOUD_PROVIDER_KEY_PAGES,
  CLOUD_PROVIDER_NAMES,
  dictationBlockWords,
  dictationFailureWords,
  languageName,
} from "@j3-bots/client-runtime/wording";
import {
  type CloudVoiceModel,
  CloudVoiceProvider,
  DICTATION_LANGUAGES,
  MAX_VOICE_WORD_LENGTH,
  MAX_VOICE_WORDS,
  type VoiceLanguage,
  type VoiceSettings,
  type VoiceSettingsChange,
} from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";
import { getLocales } from "expo-localization";
import { ExternalLink, Info, X } from "lucide-react-native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Linking, View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import {
  ChoiceRow,
  Problem,
  Quiet,
  Section,
  SkeletonRows,
  SwitchRow,
  TextField,
} from "../components/form.tsx";
import { useI18n } from "../i18n.ts";
import { askMicrophone, usePhoneRecognizer } from "../platform/dictation.ts";
import { voiceCapture } from "../platform/voiceCapture.ts";
import { PressScale } from "../press.tsx";
import { SecretField } from "../secrets/SecretsForms.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { useCloudKeys } from "../voiceStatus.ts";

const PROVIDERS = CloudVoiceProvider.literals;

/** Where a phone dictates, as the page offers it: a provider place is `service`. */
type PhoneChoice = "automatic" | "device" | "service";
const PHONE_CHOICES: ReadonlyArray<PhoneChoice> = ["automatic", "device", "service"];

/** How long the test listens, in ms. */
const TEST_LENGTH = 2000;

/** A word's key for telling it from the others: the same word in any case is the same. */
const wordKey = (word: string) => word.normalize("NFC").toLocaleLowerCase();

/**
 * Settings → Voice: dictation's preferences, one set for the server and every
 * device. Facing a server older than dictation through a service, only what
 * this phone does by itself.
 */
export function VoiceSection({ connected }: { readonly connected: boolean }) {
  const settings = useSettings();
  if (settings._tag !== "ready") {
    return (
      <Section open>
        <SkeletonRows />
      </Section>
    );
  }
  const voice = settings.value.voice;
  return voice === null || voice.provider === undefined ? (
    <ThisPhoneOnly />
  ) : (
    <VoiceForm voice={voice} connected={connected} />
  );
}

/** A server older than dictation through a service: this phone dictates by itself. */
function ThisPhoneOnly() {
  const { t } = useI18n();
  return (
    <Section open>
      <Text className="text-base text-foreground">{t("voice.place.device")}</Text>
      <Quiet>{t("voice.place.device.description")}</Quiet>
    </Section>
  );
}

/**
 * One page, as on a computer: what dictation still needs, while it needs it;
 * the dictation service and its key, a test, the language, and where this
 * phone dictates; under More, the words to always spell right and the
 * filler words. Each choice saves at once, as the notifications do: offline,
 * or while a save is under way, the page shows what it holds and takes no
 * change. A key is saved in the server's Secrets and never shown back.
 */
function VoiceForm({
  voice,
  connected,
}: {
  readonly voice: VoiceSettings;
  readonly connected: boolean;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const save: SettingsSaves["voice"] = useReadable(client.settingsSaves.voice);
  const saving = save._tag === "saving";
  const [watching, setWatching] = useState(saving);
  const [more, setMore] = useState(false);
  const keys = useCloudKeys(true);
  const shown: VoiceSettings = { ...voice, ...(saving ? save.changes : undefined) };
  const phone = usePhoneRecognizer(shown.language);
  const readOnly = saving || !connected;
  const change = (changes: VoiceSettingsChange) => {
    if (readOnly) return;
    setWatching(true);
    void client.updateSettings({ section: "voice", changes });
  };
  const provider = shown.provider ?? null;
  const path =
    phone === null
      ? null
      : dictationPath({ voice: shown, device: phone.state, keys, secureContext: true });
  const ready =
    provider !== null &&
    keys !== null &&
    keys[provider] &&
    (provider !== "openrouter" || shown.openRouterModel !== null);
  const choice: PhoneChoice =
    shown.place === "device" ? "device" : shown.place === "automatic" ? "automatic" : "service";
  return (
    <>
      {path?._tag === "blocked" && path.block === "setup" && (
        <Section open>
          <View className="flex-row items-start gap-2 rounded-md bg-muted px-3 py-2.5">
            <Icon icon={Info} size={16} color="accent-muted-foreground" />
            <Text className="flex-1 text-sm text-foreground">
              {dictationBlockWords("setup", i18n)}
            </Text>
          </View>
        </Section>
      )}
      <Section open title={t("voice.service")}>
        <Quiet>{t("voice.service.description")}</Quiet>
        <View accessibilityRole="radiogroup" className="gap-1">
          {PROVIDERS.map((option) => (
            <ChoiceRow
              key={option}
              kind="one"
              label={CLOUD_PROVIDER_NAMES[option]}
              selected={provider === option}
              unavailable={readOnly}
              onPress={() => change({ provider: option })}
            />
          ))}
          <ChoiceRow
            kind="one"
            label={t("voice.service.none")}
            description={t("voice.service.none.description")}
            selected={provider === null}
            unavailable={readOnly}
            onPress={() => change({ provider: null })}
          />
        </View>
      </Section>
      {provider !== null && (
        // One per provider: a key typed for one is never saved for another.
        <CloudKey
          key={provider}
          provider={provider}
          saved={keys === null ? null : keys[provider]}
        />
      )}
      {provider === "openrouter" && keys?.openrouter === true && (
        <OpenRouterModel
          chosen={shown.openRouterModel}
          readOnly={readOnly}
          onChoose={(openRouterModel) => change({ openRouterModel })}
        />
      )}
      {ready && voiceCapture !== null && <VoiceTest key={provider} connected={connected} />}
      <Languages
        chosen={shown.language}
        readOnly={readOnly}
        onChoose={(language) => change({ language })}
      />
      <Section open title={t("voice.phone")}>
        <View accessibilityRole="radiogroup" className="gap-1">
          {PHONE_CHOICES.map((option) => (
            <ChoiceRow
              key={option}
              kind="one"
              label={t(`voice.place.${option}`)}
              description={t(`voice.place.${option}.description`)}
              selected={choice === option}
              unavailable={readOnly || (option === "service" && provider === null)}
              onPress={() => {
                if (option !== "service") change({ place: option });
                else if (provider !== null) change({ place: provider });
              }}
            />
          ))}
        </View>
      </Section>
      <Section open>
        <View className="items-start">
          <Button label={t("voice.more")} expanded={more} onPress={() => setMore(!more)} />
        </View>
      </Section>
      {more && (
        <>
          <Words words={shown.words} readOnly={readOnly} onChange={(words) => change({ words })} />
          <Section open>
            <SwitchRow
              label={t("voice.removeFillers")}
              hint={t("voice.removeFillers.description")}
              value={shown.removeFillers}
              readOnly={readOnly}
              onChange={(removeFillers) => change({ removeFillers })}
            />
          </Section>
        </>
      )}
      <Section open>
        <Problem>{watching && save._tag === "failed" ? t("settings.saveFailed") : null}</Problem>
        {!connected && <Quiet>{t("settings.save.offline")}</Quiet>}
      </Section>
    </>
  );
}

/**
 * The language dictation listens for: Automatic, the phone's own and the one
 * chosen first, then, on request, every other the services take, each named
 * in the reader's language.
 */
function Languages({
  chosen,
  readOnly,
  onChoose,
}: {
  readonly chosen: VoiceLanguage;
  readonly readOnly: boolean;
  readonly onChoose: (language: VoiceLanguage) => void;
}) {
  const i18n = useI18n();
  const [all, setAll] = useState(false);
  const own = getLocales()[0]?.languageCode ?? null;
  const first = [
    ...new Set([...(own === null ? [] : [own]), ...(chosen === "auto" ? [] : [chosen])]),
  ].filter((code) => DICTATION_LANGUAGES.includes(code));
  const rest = DICTATION_LANGUAGES.filter((code) => !first.includes(code));
  const named = (codes: ReadonlyArray<string>) =>
    codes
      .map((code) => ({ code, name: languageName(code, i18n) }))
      .sort((a, b) => a.name.localeCompare(b.name, i18n.locale));
  const options = [
    { code: "auto", name: i18n.t("voice.language.auto") },
    ...named(first),
    ...(all ? named(rest) : []),
  ];
  return (
    <Section open title={i18n.t("voice.language")}>
      <View accessibilityRole="radiogroup" className="gap-1">
        {options.map(({ code, name }) => (
          <ChoiceRow
            key={code}
            kind="one"
            label={name}
            selected={chosen === code}
            unavailable={readOnly}
            onPress={() => onChoose(code)}
          />
        ))}
      </View>
      {!all && (
        <View className="items-start">
          <Button label={i18n.t("voice.language.more")} onPress={() => setAll(true)} />
        </View>
      )}
    </Section>
  );
}

/** How the test went: listening, being written down, and what it heard or why not. */
type TestRun =
  | { readonly _tag: "idle" }
  | { readonly _tag: "listening" }
  | { readonly _tag: "writing" }
  | { readonly _tag: "heard"; readonly text: string }
  | { readonly _tag: "nothing" }
  | { readonly _tag: "failed"; readonly text: string };

/**
 * Test: the microphone listens for two seconds, the service writes it down,
 * and the words show here. Nothing is kept or sent anywhere else.
 */
function VoiceTest({ connected }: { readonly connected: boolean }) {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const [run, setRun] = useState<TestRun>({ _tag: "idle" });
  // The test under way: ending it lets the microphone go and drops its dictation.
  const live = useRef<(() => void) | null>(null);
  useEffect(() => () => live.current?.(), []);
  const start = async () => {
    if (live.current !== null || !connected || voiceCapture === null) return;
    const microphone = voiceCapture;
    const access = await askMicrophone();
    if (access !== "granted") {
      setRun({
        _tag: "failed",
        text: t(access === "denied" ? "composer.dictation.denied" : "composer.dictation.blocked"),
      });
      return;
    }
    const handle = client.voice.dictate();
    /** Whether the microphone is still feeding the test. */
    const test = { capturing: false };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (!test.capturing) return;
      test.capturing = false;
      microphone.stop();
      handle.finish();
      setRun({ _tag: "writing" });
    };
    const release = () => {
      live.current = null;
      if (timer !== null) clearTimeout(timer);
      test.capturing = false;
      microphone.stop();
      unsubscribe();
      handle.cancel();
    };
    live.current = release;
    setRun({ _tag: "listening" });
    const unsubscribe = handle.state.subscribe(() => {
      const now: DictationState = handle.state.get();
      if (now._tag === "listening" && !test.capturing && timer === null) {
        if (!microphone.start()) {
          release();
          setRun({ _tag: "failed", text: t("dictation.microphoneFailed") });
          return;
        }
        test.capturing = true;
        timer = setTimeout(finish, TEST_LENGTH);
        void (async () => {
          while (test.capturing) {
            const piece = await microphone.read().catch(() => null);
            if (piece === null || !test.capturing) break;
            handle.audio(piece);
          }
          finish();
        })();
        return;
      }
      if (now._tag !== "done" && now._tag !== "failed") return;
      release();
      setRun(
        now._tag === "failed"
          ? { _tag: "failed", text: dictationFailureWords(now.reason, i18n) }
          : now.text.trim() === ""
            ? { _tag: "nothing" }
            : { _tag: "heard", text: now.text.trim() },
      );
    });
  };
  const busy = run._tag === "listening" || run._tag === "writing";
  const said =
    run._tag === "listening"
      ? t("voice.test.listening")
      : run._tag === "writing"
        ? t("voice.test.writing")
        : run._tag === "heard"
          ? t("voice.test.heard", { text: run.text })
          : run._tag === "nothing"
            ? t("voice.test.nothing")
            : run._tag === "failed"
              ? run.text
              : null;
  return (
    <Section open>
      <View className="flex-row items-center gap-3">
        <Button
          label={t("voice.test")}
          held={busy}
          disabled={!connected}
          onPress={() => void start()}
        />
        <View className="flex-1">
          <Quiet>{t("voice.test.hint")}</Quiet>
        </View>
      </View>
      {said !== null && (
        <Text
          accessibilityLiveRegion="polite"
          className={`text-sm ${run._tag === "failed" || run._tag === "nothing" ? "text-blocked" : "text-foreground"}`}
        >
          {said}
        </Text>
      )}
    </Section>
  );
}

/** The words to always spell right: each with a way out, and one more to add. */
function Words({
  words,
  readOnly,
  onChange,
}: {
  readonly words: ReadonlyArray<string>;
  readonly readOnly: boolean;
  readonly onChange: (words: ReadonlyArray<string>) => void;
}) {
  const { t } = useI18n();
  const [typed, setTyped] = useState("");
  const word = typed.trim();
  const full = words.length >= MAX_VOICE_WORDS;
  const addable =
    !readOnly &&
    word !== "" &&
    word.length <= MAX_VOICE_WORD_LENGTH &&
    !words.some((held) => wordKey(held) === wordKey(word));
  const add = () => {
    if (!addable) return;
    onChange([...words, word]);
    setTyped("");
  };
  return (
    <Section open title={t("voice.words")}>
      <Quiet>{t("voice.words.description")}</Quiet>
      {words.length > 0 && (
        <View className="flex-row flex-wrap gap-2">
          {words.map((held) => (
            <PressScale
              key={held}
              depth="round"
              accessibilityRole="button"
              accessibilityLabel={t("voice.words.remove", { word: held })}
              accessibilityState={{ disabled: readOnly }}
              onPress={() => {
                if (!readOnly) onChange(words.filter((other) => other !== held));
              }}
              className="min-h-11 flex-row items-center gap-1.5 rounded-pill bg-muted ps-3 pe-2"
            >
              <Text className="text-sm text-foreground">{held}</Text>
              <Icon icon={X} size={14} color="accent-muted-foreground" />
            </PressScale>
          ))}
        </View>
      )}
      {!full && (
        <View className="flex-row items-end gap-2">
          <View className="flex-1">
            <TextField
              label={t("voice.words.placeholder")}
              value={typed}
              maxLength={MAX_VOICE_WORD_LENGTH}
              readOnly={readOnly}
              autoCapitalize="none"
              onChange={setTyped}
            />
          </View>
          <Button label={t("voice.words.add")} disabled={!addable} onPress={add} />
        </View>
      )}
    </Section>
  );
}

/** A list read from the server once, as it opens. */
type Listed<A> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly items: ReadonlyArray<A> }
  | { readonly _tag: "failed" };

function useListed<A>(load: () => Promise<IntentResult<ReadonlyArray<A>>>): Listed<A> {
  const [listed, setListed] = useState<Listed<A>>({ _tag: "loading" });
  const read = useEffectEvent(load);
  useEffect(() => {
    let live = true;
    void read().then((result) => {
      if (!live) return;
      setListed(
        result._tag === "done" ? { _tag: "ready", items: result.value } : { _tag: "failed" },
      );
    });
    return () => {
      live = false;
    };
  }, []);
  return listed;
}

/**
 * The service's key: once saved, that it is, which is never shown back, with
 * Remove; until then, where the service gives one and a field to paste it.
 * It is kept in the server's Secrets.
 */
function CloudKey({
  provider,
  saved,
}: {
  readonly provider: CloudVoiceProvider;
  /** Null while it is not known yet. */
  readonly saved: boolean | null;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const [typed, setTyped] = useState("");
  const [state, setState] = useState<"idle" | "pending" | "saveFailed" | "removeFailed">("idle");
  const label = t("voice.cloud.key", { provider: CLOUD_PROVIDER_NAMES[provider] });
  const setKey = (key: string | null) => {
    setState("pending");
    void client.voice
      .setCloudKey(provider, key === null ? null : Redacted.make(key))
      .then((result) => {
        if (result._tag === "done") {
          setTyped("");
          setState("idle");
        } else {
          setState(key === null ? "removeFailed" : "saveFailed");
        }
      });
  };
  const pending = state === "pending";
  return (
    <Section open title={label}>
      {saved === null ? (
        <SkeletonRows count={1} />
      ) : saved ? (
        <View className="flex-row flex-wrap items-center justify-between gap-2">
          <Quiet>{t("voice.cloud.key.saved")}</Quiet>
          <Button
            variant="destructive"
            label={t("voice.cloud.key.remove")}
            held={pending}
            onPress={() => setKey(null)}
          />
        </View>
      ) : (
        <View className="gap-2">
          <PressScale
            accessibilityRole="link"
            onPress={() => void Linking.openURL(CLOUD_PROVIDER_KEY_PAGES[provider])}
            className="min-h-11 flex-row items-center gap-1 self-start"
          >
            <Text className="text-sm text-accent">{t("voice.cloud.key.get")}</Text>
            <Icon icon={ExternalLink} size={14} color="accent-accent" />
          </PressScale>
          <SecretField
            label={label}
            value={typed}
            onChange={setTyped}
            editable={!pending}
            onSubmit={() => {
              if (typed.trim() !== "" && !pending) setKey(typed.trim());
            }}
          />
          <View className="items-start">
            <Button
              label={t("voice.cloud.key.save")}
              disabled={typed.trim() === ""}
              held={pending}
              onPress={() => setKey(typed.trim())}
            />
          </View>
        </View>
      )}
      <Problem>
        {state === "saveFailed"
          ? t("voice.cloud.key.failed")
          : state === "removeFailed"
            ? t("voice.cloud.key.removeFailed")
            : null}
      </Problem>
    </Section>
  );
}

/** The model OpenRouter writes speech down with, which that service needs chosen. */
function OpenRouterModel({
  chosen,
  readOnly,
  onChoose,
}: {
  readonly chosen: CloudVoiceModel["id"] | null;
  readonly readOnly: boolean;
  readonly onChoose: (model: CloudVoiceModel["id"]) => void;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  const models = useListed<CloudVoiceModel>(() => client.voice.cloudModels());
  return (
    <Section open title={t("voice.cloud.model")}>
      {chosen === null && <Quiet>{t("voice.cloud.model.pick")}</Quiet>}
      {models._tag === "loading" && <SkeletonRows count={3} />}
      {models._tag === "failed" && <Quiet>{t("voice.cloud.model.failed")}</Quiet>}
      {models._tag === "ready" && models.items.length === 0 && (
        <Quiet>{t("voice.cloud.model.none")}</Quiet>
      )}
      {models._tag === "ready" && models.items.length > 0 && (
        <View accessibilityRole="radiogroup" className="gap-1">
          {models.items.map((model) => (
            <ChoiceRow
              key={model.id}
              kind="one"
              label={model.name}
              selected={chosen === model.id}
              unavailable={readOnly}
              onPress={() => onChoose(model.id)}
            />
          ))}
        </View>
      )}
    </Section>
  );
}
