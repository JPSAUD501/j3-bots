// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SettingsSaves } from "@j3-bots/client-runtime";
import {
  type ModelPicker as Picker,
  type ModelSetting,
  modelPicker,
  type PickerAccount,
  type PickerAccountState,
  type PickerModel,
  pickedModel,
  sameModel,
  searchModels,
  shownFavorites,
  starChange,
  withModel,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable, useSettings } from "@j3-bots/client-runtime/react";
import { effortText } from "@j3-bots/client-runtime/wording";
import type { EffortChoice, EngineStatus, ModelChoice, ProviderId } from "@j3-bots/contracts";
import { ChevronRight, Search, Star, Zap } from "lucide-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useI18n } from "../i18n.ts";
import { PressScale } from "../press.tsx";
import { Text, TextInput } from "../text.tsx";
import { useColor } from "../theme.ts";
import { Button } from "../ui.tsx";
import { ChoiceRow, Segmented } from "./form.tsx";
import { Icon } from "./Icon.tsx";
import { Sheet } from "./Sheet.tsx";

// Choosing the AI a bot runs on, as a sheet (decision 0108): the search, a
// rail of the starred models and of each account, the models, and for the
// one picked, its effort and its speed. The web draws the same as a popover.

/** The operator's stars, as shown, and starring a model: null `shown` where the server keeps none. */
function useStars(): {
  readonly shown: ReadonlyArray<ModelChoice> | null;
  readonly star: (choice: ModelChoice, starred: boolean) => void;
} {
  const client = useJ3Client();
  const settings = useSettings();
  const save: SettingsSaves["favorites"] = useReadable(client.settingsSaves.favorites);
  const shown =
    settings._tag === "ready" ? shownFavorites(settings.value.favoriteModels, save) : null;
  return {
    shown,
    star: (choice, starred) => {
      if (shown !== null) void client.updateSettings(starChange(shown, choice, starred));
    },
  };
}

/** Where the rail stands: the starred models, or an account's. */
type Rail = { readonly _tag: "starred" } | { readonly _tag: "account"; readonly id: ProviderId };

const accountLines = {
  limited: "picker.account.limited",
  "signed-out": "picker.account.signedOut",
  off: "picker.account.off",
  checking: "picker.account.checking",
  unavailable: "picker.account.unavailable",
} as const satisfies Record<Exclude<PickerAccountState, "ready">, string>;

/** The color of an account's dot in the rail. */
const stateDot = {
  ready: "bg-success",
  limited: "bg-waiting",
  "signed-out": "bg-muted-foreground",
  off: "bg-muted-foreground",
  checking: "bg-muted-foreground",
  unavailable: "bg-blocked",
} as const satisfies Record<PickerAccountState, string>;

/**
 * The row that shows what a bot runs on, account · model, with its effort and
 * a Fast mark, and opens the sheet that changes it. `open` is the caller's,
 * so a notice elsewhere on the screen can open the sheet too. `offerEffort`
 * is false where the server would not take an effort, as an older one
 * creating a bot: the sheet then offers none.
 */
export function ModelPicker(props: {
  readonly engine: EngineStatus | null;
  readonly value: ModelSetting;
  readonly onChange: (setting: ModelSetting) => void;
  /** The row's label, as Model or Runs on. */
  readonly label: string;
  /** The sheet's title. */
  readonly title: string;
  readonly offerEffort: boolean;
  readonly readOnly?: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const stars = useStars();
  const picker = modelPicker(props.engine, stars.shown ?? []);
  const { value } = props;
  const picked = pickedModel(picker, value.model);
  const level =
    value.effort === null
      ? null
      : (picked?.efforts.find((choice) => choice.id === value.effort) ?? {
          id: value.effort,
          name: value.effort,
        });
  const summary =
    picked === undefined
      ? t("editBot.model.notOffered", { model: value.model.modelId })
      : `${picked.accountName} · ${picked.name}`;
  const details = [
    ...(props.offerEffort && level !== null ? [effortText(level, i18n)] : []),
    ...(value.fast ? [t("picker.speed.fast")] : []),
  ].join(" · ");
  const readOnly = props.readOnly === true;
  // Each opening starts afresh, with no search, at the account the bot runs on.
  const [openings, setOpenings] = useState({ count: 0, open: props.open });
  if (openings.open !== props.open) {
    setOpenings({ count: openings.count + (props.open ? 1 : 0), open: props.open });
  }
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground">{props.label}</Text>
      <PressScale
        depth="row"
        accessibilityRole="button"
        accessibilityLabel={props.title}
        accessibilityHint={details === "" ? summary : `${summary}, ${details}`}
        accessibilityState={{ disabled: readOnly, expanded: props.open }}
        onPress={() => {
          if (!readOnly) props.onOpenChange(true);
        }}
        className="min-h-11 flex-row items-center gap-3 rounded-md border border-border px-3 py-2"
      >
        <View className="min-w-0 flex-1">
          <Text
            numberOfLines={1}
            className={`text-base ${readOnly ? "text-muted-foreground" : "text-foreground"}`}
          >
            {summary}
          </Text>
          {details !== "" && (
            <View className="flex-row items-center gap-1">
              {value.fast && <Icon icon={Zap} size={12} color="accent-muted-foreground" />}
              <Text className="text-xs text-muted-foreground">{details}</Text>
            </View>
          )}
        </View>
        {!readOnly && <Icon icon={ChevronRight} color="accent-muted-foreground" />}
      </PressScale>
      <PickerSheet
        key={openings.count}
        open={props.open}
        title={props.title}
        engine={props.engine}
        picker={picker}
        value={value}
        offerEffort={props.offerEffort}
        starsKept={stars.shown !== null}
        onStar={stars.star}
        onChange={props.onChange}
        onClose={() => props.onOpenChange(false)}
      />
    </View>
  );
}

function PickerSheet(props: {
  readonly open: boolean;
  readonly title: string;
  readonly engine: EngineStatus | null;
  readonly picker: Picker;
  readonly value: ModelSetting;
  readonly offerEffort: boolean;
  readonly starsKept: boolean;
  readonly onStar: (choice: ModelChoice, starred: boolean) => void;
  readonly onChange: (setting: ModelSetting) => void;
  readonly onClose: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const { picker, value } = props;
  const [query, setQuery] = useState("");
  // The rail opens at the account the bot runs on, or the first one.
  const [rail, setRail] = useState<Rail>(() => {
    const own = picker.accounts.find((account) => account.providerId === value.model.providerId);
    const first = own ?? picker.accounts[0];
    return first === undefined ? { _tag: "starred" } : { _tag: "account", id: first.providerId };
  });
  const placeholder = useColor("accent-muted-foreground");
  const searching = query.trim() !== "";
  const account =
    rail._tag === "account"
      ? picker.accounts.find((candidate) => candidate.providerId === rail.id)
      : undefined;
  const listed: ReadonlyArray<PickerModel> = searching
    ? searchModels(picker, query)
    : rail._tag === "starred"
      ? picker.starred
      : picker.models.filter((model) => model.choice.providerId === rail.id);
  const picked = pickedModel(picker, value.model);
  const choose = (model: PickerModel) => {
    if (model.choosable) props.onChange(withModel(props.engine, value, model.choice));
  };
  return (
    <Sheet
      open={props.open}
      title={props.title}
      onClose={props.onClose}
      footer={
        <View className="flex-row justify-end border-t border-border px-5 pt-3 pb-2">
          <Button variant="primary" label={t("picker.done")} onPress={props.onClose} />
        </View>
      }
    >
      <View className="gap-4">
        <View className="min-h-11 flex-row items-center gap-2 rounded-md bg-muted px-3">
          <Icon icon={Search} color="accent-muted-foreground" />
          <TextInput
            accessibilityLabel={t("picker.search")}
            value={query}
            onChangeText={setQuery}
            placeholder={t("picker.search")}
            placeholderTextColor={placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            className="min-h-11 flex-1 text-base text-foreground"
          />
        </View>
        {!searching && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-2"
          >
            {props.starsKept && (
              <RailChip
                label={t("picker.starred")}
                selected={rail._tag === "starred"}
                onPress={() => setRail({ _tag: "starred" })}
              />
            )}
            {picker.accounts.map((each) => (
              <RailChip
                key={each.providerId}
                label={each.name}
                account={each}
                selected={rail._tag === "account" && rail.id === each.providerId}
                onPress={() => setRail({ _tag: "account", id: each.providerId })}
              />
            ))}
          </ScrollView>
        )}
        {!searching && account !== undefined && account.state !== "ready" && (
          <Text className="text-sm text-muted-foreground">{t(accountLines[account.state])}</Text>
        )}
        <View accessibilityRole="radiogroup" className="gap-2">
          {listed.map((model) => (
            <ModelRow
              key={`${model.choice.providerId}/${model.choice.modelId}`}
              model={model}
              withAccount={searching || rail._tag === "starred"}
              selected={sameModel(model.choice, value.model)}
              starsKept={props.starsKept}
              onPress={() => choose(model)}
              onStar={() => props.onStar(model.choice, !model.starred)}
            />
          ))}
          {listed.length === 0 && (
            <Text className="text-sm text-muted-foreground">
              {searching
                ? t("picker.noMatch", { query: query.trim() })
                : rail._tag === "starred"
                  ? t("picker.starred.empty")
                  : t("picker.noModels")}
            </Text>
          )}
        </View>
        {picked !== undefined && (
          <ModelOptions
            model={picked}
            value={value}
            offerEffort={props.offerEffort}
            onChange={props.onChange}
          />
        )}
      </View>
    </Sheet>
  );
}

/** An entry of the rail: the starred models, or an account with a dot for where it stands. */
function RailChip(props: {
  readonly label: string;
  readonly account?: PickerAccount;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <PressScale
      accessibilityRole="tab"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className={`min-h-11 flex-row items-center gap-2 rounded-pill border px-4 ${props.selected ? "border-foreground bg-muted" : "border-border"}`}
    >
      {props.account !== undefined && (
        <View className={`size-2 rounded-pill ${stateDot[props.account.state]}`} />
      )}
      <Text numberOfLines={1} className="text-sm text-foreground">
        {props.label}
      </Text>
    </PressScale>
  );
}

/** One model: picked by its row, starred by the star beside it where the server keeps stars. */
function ModelRow(props: {
  readonly model: PickerModel;
  /** Names its account, in a list that mixes accounts. */
  readonly withAccount: boolean;
  readonly selected: boolean;
  readonly starsKept: boolean;
  readonly onPress: () => void;
  readonly onStar: () => void;
}) {
  const { t } = useI18n();
  const { model } = props;
  return (
    <View className="flex-row items-center gap-1">
      <View className="min-w-0 flex-1">
        <ChoiceRow
          kind="one"
          label={model.name}
          {...(props.withAccount ? { description: model.accountName } : {})}
          selected={props.selected}
          unavailable={!model.choosable}
          onPress={props.onPress}
        />
      </View>
      {props.starsKept && (
        <PressScale
          depth="round"
          accessibilityRole="button"
          accessibilityLabel={t(model.starred ? "picker.unstar" : "picker.star", {
            model: model.name,
          })}
          accessibilityState={{ selected: model.starred }}
          onPress={props.onStar}
          className="size-11 items-center justify-center"
        >
          <Icon
            icon={Star}
            filled={model.starred}
            color={model.starred ? "accent-foreground" : "accent-muted-foreground"}
          />
        </PressScale>
      )}
    </View>
  );
}

/** The effort and the speed of the model picked, where it has them. */
function ModelOptions(props: {
  readonly model: PickerModel;
  readonly value: ModelSetting;
  readonly offerEffort: boolean;
  readonly onChange: (setting: ModelSetting) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const { model, value } = props;
  const efforts: ReadonlyArray<EffortChoice | null> = [null, ...model.efforts];
  return (
    <>
      {props.offerEffort && model.efforts.length > 0 && model.choosable && (
        <View accessibilityRole="radiogroup" className="gap-2 border-t border-border pt-4">
          <Text className="text-sm text-foreground">{t("editBot.effort")}</Text>
          <Text className="text-xs text-muted-foreground">{t("editBot.effort.hint")}</Text>
          {efforts.map((level) => (
            <ChoiceRow
              key={level?.id ?? "default"}
              kind="one"
              label={effortText(level, i18n)}
              selected={value.effort === (level?.id ?? null)}
              onPress={() => props.onChange({ ...value, effort: level?.id ?? null })}
            />
          ))}
        </View>
      )}
      {model.fast && model.choosable && (
        <View className="gap-2 border-t border-border pt-4">
          <Text className="text-sm text-foreground">{t("picker.speed")}</Text>
          <Segmented
            label={t("picker.speed")}
            value={value.fast ? "fast" : "standard"}
            options={[
              { value: "standard", label: t("picker.speed.standard") },
              { value: "fast", label: t("picker.speed.fast") },
            ]}
            onChange={(speed) => props.onChange({ ...value, fast: speed === "fast" })}
          />
          <Text className="text-xs text-muted-foreground">{t("picker.speed.hint")}</Text>
        </View>
      )}
    </>
  );
}
