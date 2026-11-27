// SPDX-License-Identifier: AGPL-3.0-or-later
import { Popover } from "@base-ui/react/popover";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import {
  aiAccountNames,
  type ModelSetting,
  modelPicker,
  type PickerAccount,
  type PickerAccountState,
  type PickerModel,
  pickedModel,
  sameModel,
  searchModels,
  withModel,
} from "@j3-bots/client-runtime/presentation";
import { effortText } from "@j3-bots/client-runtime/wording";
import type { EngineStatus, ModelChoice, ProviderId } from "@j3-bots/contracts";
import type { I18n } from "@j3-bots/i18n";
import { CheckIcon, ChevronDownIcon, SearchIcon, StarIcon, ZapIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { touchTarget } from "../lib/touchTarget";
import type { ModelStars } from "./modelStars";
import { Segmented } from "./ui/segmented";
import { lineField } from "./ui/field";
import { Button } from "./ui/button";

// Choosing the AI a bot runs on, as T3 Code's picker lets one choose
// (decision 0108): a search over every model, a rail of the accounts with the
// starred models first, the models of the one picked, and the effort and
// speed of the model chosen below them.

const panel =
  "flex flex-col overflow-hidden rounded-lg border border-border bg-surface text-sm outline-none";
const popup = cn(
  panel,
  "max-h-[min(36rem,var(--available-height))] w-[min(36rem,calc(100vw-2rem))] origin-(--transform-origin) shadow-overlay transition-[opacity,scale] duration-(--duration-pop) ease-pop data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-out motion-reduce:transition-opacity motion-reduce:data-starting-style:scale-100 motion-reduce:data-ending-style:scale-100",
);

/** Where an account's dot stands: it runs, it waits, or it cannot. */
const dotClass: Readonly<Record<PickerAccountState, string>> = {
  ready: "bg-success",
  limited: "bg-waiting",
  checking: "bg-muted-foreground",
  "signed-out": "bg-blocked",
  off: "bg-muted-foreground/50",
  unavailable: "bg-blocked",
};

/** Where an account stands, above its models, when it does not simply run; null when it does. */
const stateLine = (state: PickerAccountState, { t }: I18n): string | null => {
  switch (state) {
    case "ready":
      return null;
    case "limited":
      return t("picker.account.limited");
    case "checking":
      return t("picker.account.checking");
    case "signed-out":
      return t("picker.account.signedOut");
    case "off":
      return t("picker.account.off");
    case "unavailable":
      return t("picker.account.unavailable");
  }
};

/** What the rail shows the models of. */
type Rail = { readonly _tag: "starred" } | { readonly _tag: "account"; readonly id: ProviderId };

export interface ModelPickerProps {
  /** Where the accounts and models come from; null until the server reported it. */
  readonly engine: EngineStatus | null;
  readonly value: ModelSetting;
  readonly onChange: (setting: ModelSetting) => void;
  /**
   * Whether effort is offered. Off where the server would not take it, as
   * creating a bot on a server that predates accounts set up in Settings.
   */
  readonly offerEffort: boolean;
  /** The starred models; null from a server that keeps none, where no star shows. */
  readonly stars: ModelStars | null;
  /** The id of the text that names the picker. */
  readonly labelledBy: string;
  readonly describedBy?: string;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  /** Controls whether it is open; left out, it opens and closes by itself. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

/**
 * The button that says what a bot runs on, account · model, its effort and
 * a mark for fast mode, and opens the picker.
 */
export function ModelPicker({
  engine,
  value,
  onChange,
  offerEffort,
  stars,
  labelledBy,
  describedBy,
  disabled = false,
  invalid = false,
  open,
  onOpenChange,
}: ModelPickerProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const triggerId = useId();
  const picker = modelPicker(engine, stars?.favorites ?? []);
  const shown = pickedModel(picker, value.model);
  const level =
    value.effort === null
      ? null
      : (shown?.efforts.find((each) => each.id === value.effort) ?? null);
  const label =
    shown === undefined
      ? engine === null
        ? value.model.modelId
        : t("editBot.model.notOffered", { model: value.model.modelId })
      : `${shown.accountName} · ${shown.name}`;
  return (
    <Popover.Root
      {...(open === undefined ? {} : { open })}
      onOpenChange={(next) => onOpenChange?.(next)}
    >
      <Popover.Trigger
        id={triggerId}
        disabled={disabled}
        aria-labelledby={`${labelledBy} ${triggerId}`}
        {...(describedBy === undefined ? {} : { "aria-describedby": describedBy })}
        {...(invalid ? { "aria-invalid": true } : {})}
        className={cn(
          lineField,
          "flex cursor-pointer items-center gap-2 text-start disabled:cursor-default disabled:text-muted-foreground data-popup-open:bg-muted-strong",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {offerEffort && level !== null && (
          <span className="shrink-0 text-xs text-muted-foreground">{effortText(level, i18n)}</span>
        )}
        {value.fast && (
          <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
            <ZapIcon aria-hidden className="size-3.5" />
            {t("picker.speed.fast")}
          </span>
        )}
        <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
          <Popover.Popup aria-label={t("picker.open", { name: label })} className={popup}>
            <PickerPanel
              engine={engine}
              value={value}
              onChange={onChange}
              offerEffort={offerEffort}
              stars={stars}
              accounts={picker.accounts}
              starred={picker.starred}
              models={picker.models}
              defaultQuery=""
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * What the picker shows once open, laid in the page rather than over it,
 * with `defaultQuery` already searched: the gallery shows it so, where many
 * open at once would take the focus from each other.
 */
export function ModelPickerPanel({
  engine,
  value,
  onChange,
  offerEffort,
  stars,
  defaultQuery = "",
}: Pick<ModelPickerProps, "engine" | "value" | "onChange" | "offerEffort" | "stars"> & {
  readonly defaultQuery?: string;
}) {
  const picker = modelPicker(engine, stars?.favorites ?? []);
  return (
    <Popover.Root>
      <div className={cn(panel, "h-full")}>
        <PickerPanel
          engine={engine}
          value={value}
          onChange={onChange}
          offerEffort={offerEffort}
          stars={stars}
          accounts={picker.accounts}
          starred={picker.starred}
          models={picker.models}
          defaultQuery={defaultQuery}
        />
      </div>
    </Popover.Root>
  );
}

/** The rail item the picker opens at: the account of the model chosen, else the stars, else the first account. */
const railAt = (
  value: ModelChoice,
  accounts: ReadonlyArray<PickerAccount>,
  hasStars: boolean,
): Rail => {
  const own = accounts.find((account) => account.providerId === value.providerId);
  if (own !== undefined) return { _tag: "account", id: own.providerId };
  if (hasStars) return { _tag: "starred" };
  const first = accounts[0];
  return first === undefined ? { _tag: "starred" } : { _tag: "account", id: first.providerId };
};

function PickerPanel({
  engine,
  value,
  onChange,
  offerEffort,
  stars,
  accounts,
  starred,
  models,
  defaultQuery,
}: Pick<ModelPickerProps, "engine" | "value" | "onChange" | "offerEffort" | "stars"> & {
  readonly accounts: ReadonlyArray<PickerAccount>;
  readonly starred: ReadonlyArray<PickerModel>;
  readonly models: ReadonlyArray<PickerModel>;
  readonly defaultQuery: string;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const ids = { effort: useId(), speed: useId(), speedHint: useId(), list: useId() };
  const [query, setQuery] = useState(defaultQuery);
  const [rail, setRail] = useState<Rail>(() =>
    railAt(value.model, accounts, stars !== null && starred.length > 0),
  );
  const searching = query.trim() !== "";
  const railAccount =
    rail._tag === "account"
      ? accounts.find((account) => account.providerId === rail.id)
      : undefined;
  const listed = searching
    ? searchModels({ accounts, starred, models }, query)
    : rail._tag === "starred"
      ? starred
      : models.filter((model) => model.choice.providerId === rail.id);
  // Beside each model, its account's name wherever the list mixes accounts.
  const mixed = searching || rail._tag === "starred";
  const chosen = models.find((model) => sameModel(model.choice, value.model));
  const accountLine =
    searching || railAccount === undefined ? null : stateLine(railAccount.state, i18n);
  const pick = (model: PickerModel) => onChange(withModel(engine, value, model.choice));

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3">
        <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <input
          type="search"
          value={query}
          autoComplete="off"
          aria-label={t("picker.search")}
          aria-controls={ids.list}
          placeholder={t("picker.search")}
          onChange={(event) => setQuery(event.currentTarget.value)}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="flex min-h-0 flex-1">
        {!searching && (
          <ul className="flex w-40 shrink-0 flex-col gap-0.5 overflow-y-auto border-e border-border p-1.5 max-tablet:w-32">
            {stars !== null && (
              <li>
                <RailButton
                  current={rail._tag === "starred"}
                  onPress={() => setRail({ _tag: "starred" })}
                >
                  <StarIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{t("picker.starred")}</span>
                </RailButton>
              </li>
            )}
            {accounts.map((account) => (
              <li key={account.providerId}>
                <RailButton
                  current={rail._tag === "account" && rail.id === account.providerId}
                  onPress={() => setRail({ _tag: "account", id: account.providerId })}
                >
                  <span
                    aria-hidden
                    className={cn("size-2 shrink-0 rounded-pill", dotClass[account.state])}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{account.name}</span>
                    {account.harness !== "other" && (
                      <span className="truncate text-2xs text-muted-foreground">
                        {aiAccountNames[account.harness].product}
                      </span>
                    )}
                  </span>
                </RailButton>
              </li>
            ))}
          </ul>
        )}
        <div id={ids.list} className="flex min-w-0 flex-1 flex-col overflow-y-auto p-1.5">
          {accountLine !== null && (
            <p role="status" className="px-2.5 py-1.5 text-xs text-pretty text-muted-foreground">
              {accountLine}
            </p>
          )}
          {listed.length === 0 ? (
            <p className="px-2.5 py-3 text-xs text-pretty text-muted-foreground">
              {searching
                ? t("picker.noMatch", { query: query.trim() })
                : rail._tag === "starred"
                  ? t("picker.starred.empty")
                  : t("picker.noModels")}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {listed.map((model) => (
                <ModelRow
                  key={`${model.choice.providerId}/${model.choice.modelId}`}
                  model={model}
                  chosen={sameModel(model.choice, value.model)}
                  withAccount={mixed}
                  stars={stars}
                  onPick={() => pick(model)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      {chosen !== undefined && ((offerEffort && chosen.efforts.length > 0) || chosen.fast) && (
        <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
          {offerEffort && chosen.efforts.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <p id={ids.effort} className="text-xs">
                {t("editBot.effort")}
              </p>
              <RadioGroup
                value={value.effort ?? ""}
                onValueChange={(picked) => {
                  const level = chosen.efforts.find((each) => each.id === picked);
                  onChange({ ...value, effort: level?.id ?? null });
                }}
                aria-labelledby={ids.effort}
                className="flex flex-wrap gap-1"
              >
                {[null, ...chosen.efforts].map((level) => (
                  <Radio.Root
                    key={level?.id ?? ""}
                    value={level?.id ?? ""}
                    className={cn(
                      "pressable flex h-7 cursor-pointer items-center rounded-pill bg-muted px-3 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
                      "data-checked:bg-foreground data-checked:text-background",
                      touchTarget,
                    )}
                  >
                    {effortText(level, i18n)}
                  </Radio.Root>
                ))}
              </RadioGroup>
              <p className="text-2xs text-muted-foreground">{t("editBot.effort.hint")}</p>
            </div>
          )}
          {chosen.fast && (
            <div className="flex flex-col gap-1.5">
              <p id={ids.speed} className="text-xs">
                {t("picker.speed")}
              </p>
              <Segmented
                value={value.fast ? "fast" : "standard"}
                options={[
                  { value: "standard", label: t("picker.speed.standard") },
                  { value: "fast", label: t("picker.speed.fast") },
                ]}
                onChange={(speed) => onChange({ ...value, fast: speed === "fast" })}
                labelledBy={ids.speed}
              />
              <p id={ids.speedHint} className="text-2xs text-muted-foreground">
                {t("picker.speed.hint")}
              </p>
            </div>
          )}
        </div>
      )}
      <div className="flex justify-end border-t border-border px-3 py-2">
        <Popover.Close render={<Button size="sm" variant="primary" />}>
          {t("picker.done")}
        </Popover.Close>
      </div>
    </>
  );
}

function RailButton({
  current,
  onPress,
  children,
}: {
  readonly current: boolean;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={current}
      onClick={onPress}
      className={cn(
        "pressable flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-start text-sm outline-none transition-colors duration-(--duration-fast) hover:bg-muted focus-visible:outline-2 focus-visible:outline-accent",
        current && "bg-muted font-medium",
        touchTarget,
      )}
    >
      {children}
    </button>
  );
}

function ModelRow({
  model,
  chosen,
  withAccount,
  stars,
  onPick,
}: {
  readonly model: PickerModel;
  readonly chosen: boolean;
  readonly withAccount: boolean;
  readonly stars: ModelStars | null;
  readonly onPick: () => void;
}) {
  const { t } = useI18n();
  return (
    <li className="flex items-center gap-0.5">
      <button
        type="button"
        aria-pressed={chosen}
        disabled={!model.choosable}
        onClick={onPick}
        className={cn(
          "pressable flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2.5 py-1 text-start outline-none transition-colors duration-(--duration-fast) hover:bg-muted focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent",
          chosen && "bg-muted",
          touchTarget,
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{model.name}</span>
          {withAccount && (
            <span className="truncate text-2xs text-muted-foreground">{model.accountName}</span>
          )}
        </span>
        {model.fast && <ZapIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
        {chosen && <CheckIcon aria-hidden className="size-4 shrink-0" />}
      </button>
      {stars !== null && (
        <button
          type="button"
          aria-pressed={model.starred}
          aria-label={t(model.starred ? "picker.unstar" : "picker.star", { model: model.name })}
          onClick={() => stars.onStar(model.choice, !model.starred)}
          className={cn(
            "pressable pressable-round flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-pill text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent",
            touchTarget,
          )}
        >
          <StarIcon
            aria-hidden
            className={cn("size-4", model.starred && "fill-current text-waiting")}
          />
        </button>
      )}
    </li>
  );
}
