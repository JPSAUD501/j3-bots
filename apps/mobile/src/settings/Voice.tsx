// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IntentResult, SettingsSaves } from "@j3-bots/client-runtime";
import { useJ3Client, useReadable, useSettings } from "@j3-bots/client-runtime/react";
import {
  CLOUD_PROVIDER_NAMES,
  languageName,
  sizeWords,
  voiceModelWords,
  voicePlaceWords,
} from "@j3-bots/client-runtime/wording";
import {
  type CloudVoiceModel,
  type CloudVoiceProvider,
  cloudProviderOf,
  MAX_VOICE_WORD_LENGTH,
  MAX_VOICE_WORDS,
  type VoiceInstall,
  type VoiceLanguage,
  type VoiceModel,
  type VoiceModelId,
  type VoicePlace,
  type VoiceSettings,
  type VoiceSettingsChange,
} from "@j3-bots/contracts";
import * as Redacted from "effect/Redacted";
import { getLocales } from "expo-localization";
import { X } from "lucide-react-native";
import { useEffect, useEffectEvent, useState } from "react";
import { View } from "react-native";
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
import { usePhoneRecognizer } from "../platform/dictation.ts";
import { PressScale } from "../press.tsx";
import { SecretField } from "../secrets/SecretsForms.tsx";
import { Text } from "../text.tsx";
import { Button } from "../ui.tsx";
import { useCloudKeys, useVoiceStatus } from "../voiceStatus.ts";

/** Where speech can become words, in the order Settings lists them. */
const PLACES: ReadonlyArray<VoicePlace> = [
  "automatic",
  "device",
  "server",
  "openai",
  "xai",
  "openrouter",
];

/** A word's key for telling it from the others: the same word in any case is the same. */
const wordKey = (word: string) => word.normalize("NFC").toLocaleLowerCase();

/** A language the voice settings take: an ISO 639-1 code. */
const isLanguageCode = (code: string): boolean => /^[a-z]{2}$/.test(code);

/**
 * Settings → Voice: dictation's preferences, one set for the server and every
 * device. Facing a server older than dictation through it, only what this
 * phone does by itself.
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
  return voice === null ? <ThisPhoneOnly /> : <VoiceForm voice={voice} connected={connected} />;
}

/** A server older than dictation keeps no voice settings: this phone dictates by itself. */
function ThisPhoneOnly() {
  const words = voicePlaceWords("device", useI18n());
  return (
    <Section open>
      <Text className="text-base text-foreground">{words.label}</Text>
      <Quiet>{words.description}</Quiet>
    </Section>
  );
}

/**
 * Each choice saves at once, as the notifications do: offline, or while a
 * save is under way, the page shows what it holds and takes no change. How a
 * save ended shows only for one this page saw under way. A cloud provider's
 * key is saved in the server's Secrets and never shown back.
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
  const status = useVoiceStatus(true);
  const keys = useCloudKeys(true);
  const shown: VoiceSettings = { ...voice, ...(saving ? save.changes : undefined) };
  const phone = usePhoneRecognizer(shown.language);
  const readOnly = saving || !connected;
  const change = (changes: VoiceSettingsChange) => {
    if (readOnly) return;
    setWatching(true);
    void client.updateSettings({ section: "voice", changes });
  };
  const provider = cloudProviderOf(shown.place);
  const nowhere =
    status?._tag === "unavailable" &&
    phone !== null &&
    phone.state !== "ready" &&
    provider === null;
  return (
    <>
      <Section open title={t("voice.place")}>
        <View accessibilityRole="radiogroup" className="gap-1">
          {PLACES.map((place) => {
            const words = voicePlaceWords(place, i18n);
            return (
              <ChoiceRow
                key={place}
                kind="one"
                label={words.label}
                description={words.description}
                selected={shown.place === place}
                unavailable={readOnly}
                onPress={() => change({ place })}
              />
            );
          })}
        </View>
        {nowhere && <Quiet>{t("voice.unavailable")}</Quiet>}
      </Section>
      {provider !== null && (
        <CloudKey provider={provider} saved={keys === null ? null : keys[provider]} />
      )}
      {provider === "openrouter" && (
        <OpenRouterModel
          chosen={shown.openRouterModel}
          readOnly={readOnly}
          onChoose={(openRouterModel) => change({ openRouterModel })}
        />
      )}
      <Languages
        chosen={shown.language}
        heard={status?._tag === "available" ? status.model.languages : []}
        readOnly={readOnly}
        onChoose={(language) => change({ language })}
      />
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
      <Section open>
        <View className="items-start">
          <Button label={t("voice.more")} expanded={more} onPress={() => setMore(!more)} />
        </View>
      </Section>
      {more && (
        <>
          <Models
            chosen={shown.model}
            installing={status?._tag === "available" ? status.installing : null}
            readOnly={readOnly}
            onChoose={(model) => change({ model })}
          />
          <Section open>
            <SwitchRow
              label={t("voice.cleanUp")}
              hint={t("voice.cleanUp.description")}
              value={shown.cleanUp}
              readOnly={readOnly}
              onChange={(cleanUp) => change({ cleanUp })}
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
 * The language dictation listens for: Automatic, or one the server's model
 * hears, the one chosen and the phone's own, each named in the reader's
 * language.
 */
function Languages({
  chosen,
  heard,
  readOnly,
  onChoose,
}: {
  readonly chosen: VoiceLanguage;
  /** The languages the server's model hears. */
  readonly heard: ReadonlyArray<string>;
  readonly readOnly: boolean;
  readonly onChoose: (language: VoiceLanguage) => void;
}) {
  const i18n = useI18n();
  const own = getLocales()[0]?.languageCode ?? null;
  const codes = [
    ...new Set([...heard, ...(chosen === "auto" ? [] : [chosen]), ...(own === null ? [] : [own])]),
  ].filter(isLanguageCode);
  const named = codes
    .map((code) => ({ code, name: languageName(code, i18n) }))
    .sort((a, b) => a.name.localeCompare(b.name, i18n.locale));
  const options = [{ code: "auto", name: i18n.t("voice.language.auto") }, ...named];
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
 * The server's speech models, described as an operator chooses one, the
 * recommended one marked; choosing it is choosing J3 Bots' own pick. A
 * download under way shows how far it got.
 */
function Models({
  chosen,
  installing,
  readOnly,
  onChoose,
}: {
  readonly chosen: VoiceModelId | null;
  readonly installing: VoiceInstall | null;
  readonly readOnly: boolean;
  readonly onChoose: (model: VoiceModelId | null) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const client = useJ3Client();
  const models = useListed<VoiceModel>(() => client.voice.models());
  const describe = (model: VoiceModel) =>
    [
      ...(model.recommended ? [t("voice.model.recommended")] : []),
      ...voiceModelWords(model, i18n),
      ...(installing?.modelId === model.id
        ? [
            t("voice.model.installing", {
              received: sizeWords(installing.received, i18n),
              total: sizeWords(installing.total, i18n),
            }),
          ]
        : model.installed
          ? [t("voice.model.installed")]
          : []),
    ].join(" · ");
  return (
    <Section open title={t("voice.model")}>
      <Quiet>{t("voice.model.description")}</Quiet>
      {models._tag === "loading" && <SkeletonRows count={3} />}
      {models._tag === "failed" && <Quiet>{t("voice.models.failed")}</Quiet>}
      {models._tag === "ready" && (
        <View accessibilityRole="radiogroup" className="gap-1">
          {models.items.map((model) => (
            <ChoiceRow
              key={model.id}
              kind="one"
              label={model.name}
              description={describe(model)}
              selected={chosen === null ? model.recommended : chosen === model.id}
              unavailable={readOnly}
              onPress={() => onChoose(model.recommended ? null : model.id)}
            />
          ))}
        </View>
      )}
    </Section>
  );
}

/**
 * A cloud provider's key: whether one is saved, which is never shown back,
 * and saving or removing it. It is kept in the server's Secrets.
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

/** The model OpenRouter transcribes with, which that provider needs chosen. */
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
