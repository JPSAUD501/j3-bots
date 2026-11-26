// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Bot,
  Connector,
  ConnectorField,
  ConnectorGlyph,
  ConnectorGrant,
  ConnectorTool,
} from "@j3-bots/contracts";
import {
  type ConnectorTone,
  connectorTone,
  grantsBot,
  type PairInput,
  withBot,
} from "@j3-bots/client-runtime/presentation";
import { connectorStatusText, serverText } from "@j3-bots/client-runtime/wording";
import { CONNECTOR_GLYPHS, isConnectorGlyphName } from "@j3-bots/design-tokens";
import { PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useI18n, usePresentation } from "../../app/context";
import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { lineField } from "../ui/field";
import { Switch } from "../ui/switch";

/** The lines of a glyph this client has, or null for one it does not. */
const glyphPaths = (glyph: ConnectorGlyph): ReadonlyArray<string> | null => {
  // As a plain name: the set is keyed by names, not by the contract's branded ones.
  const name: string = glyph;
  return isConnectorGlyphName(name) ? CONNECTOR_GLYPHS[name] : null;
};

/**
 * A connector's tile, on a quiet fill: the glyph it names, drawn as a line
 * like the interface's other icons, or its first letter in the display face
 * when it names none or one this client does not have.
 */
export function ConnectorTile({
  name,
  glyph,
  size = "md",
}: {
  name: string;
  glyph: ConnectorGlyph | null;
  size?: "md" | "lg";
}) {
  const paths = glyph === null ? null : glyphPaths(glyph);
  return (
    <span
      aria-hidden
      className={cn(
        "display-type flex shrink-0 items-center justify-center rounded-md bg-muted font-semibold text-foreground",
        size === "lg" ? "size-12 text-xl" : "size-9 text-base",
      )}
    >
      {paths === null ? (
        (Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?")
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={size === "lg" ? "size-6" : "size-[1.125rem]"}
        >
          {paths.map((d) => (
            <path key={d} d={d} />
          ))}
        </svg>
      )}
    </span>
  );
}

const toneDot: Record<ConnectorTone, string> = {
  connected: "bg-success",
  "needs-you": "bg-waiting",
  failing: "bg-blocked",
};

const toneText: Record<ConnectorTone, string> = {
  connected: "text-muted-foreground",
  "needs-you": "text-waiting",
  failing: "text-blocked",
};

/** A connector's status in a word, after a light in its color: for a row in a list. */
export function StatusWord({ connector }: { connector: Connector }) {
  const ctx = usePresentation();
  const tone = connectorTone(connector);
  const { label } = connectorStatusText(connector.status, ctx);
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", toneText[tone])}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", toneDot[tone])} />
      {label}
    </span>
  );
}

/** A connector's status, then what its server speaks and offers once it was reached: for its row in the list. */
export function ServerLine({ connector }: { connector: Connector }) {
  const { i18n } = usePresentation();
  const server = serverText(connector, i18n);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <StatusWord connector={connector} />
      {server !== null && (
        <span className="truncate text-xs text-muted-foreground">· {server}</span>
      )}
    </span>
  );
}

/**
 * A connector's status on its page: the word and its light, why bots cannot
 * use it and since when, and the one thing that fixes it, when the operator
 * can: sign in again (`onReconnect`), or open Settings → Secrets (`onOpenSecrets`).
 */
export function StatusBlock({
  connector,
  onReconnect,
  onOpenSecrets,
}: {
  connector: Connector;
  onReconnect: (() => void) | null;
  onOpenSecrets: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const tone = connectorTone(connector);
  const text = connectorStatusText(connector.status, ctx);
  const action =
    connector.status._tag === "secrets-unavailable"
      ? { label: t("connector.openSecrets"), run: onOpenSecrets }
      : connector.status._tag === "needs-sign-in" && onReconnect !== null
        ? { label: t("connector.reconnect"), run: onReconnect }
        : null;
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg px-3 py-2.5",
        tone === "connected"
          ? "bg-muted"
          : tone === "needs-you"
            ? "bg-waiting-surface"
            : "bg-blocked-surface",
      )}
    >
      <p
        className={cn(
          "flex items-center gap-2 text-sm font-medium",
          tone !== "connected" && toneText[tone],
        )}
      >
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", toneDot[tone])} />
        {text.label}
      </p>
      {(text.detail !== null || text.since !== null) && (
        <p className="text-sm text-foreground">
          {[text.detail, text.since].filter((part) => part !== null).join(" ")}
        </p>
      )}
      {text.next !== null && <p className="text-sm text-foreground">{text.next}</p>}
      {action !== null && (
        <Button size="sm" variant="primary" className="self-start" onClick={action.run}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

/** A heading inside a connector's page, with what it heads. */
export function PageSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Which bots may use a connector: "All bots", which takes bots made later
 * too, or each bot by name. Turning "All bots" off leaves every bot ticked,
 * for the operator to take some out.
 */
export function BotsPicker({
  bots,
  grant,
  onChange,
  disabled = false,
}: {
  bots: ReadonlyArray<Bot>;
  grant: ConnectorGrant;
  onChange: (grant: ConnectorGrant) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const allId = useId();
  const all = grant._tag === "all-bots";
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={allId} className="flex min-h-9 items-center gap-3 text-sm">
        <span className="flex-1">{t("connector.bots.all")}</span>
        <Switch
          id={allId}
          checked={all}
          disabled={disabled}
          onCheckedChange={(checked) =>
            onChange(
              checked ? { _tag: "all-bots" } : { _tag: "bots", ids: bots.map((bot) => bot.id) },
            )
          }
        />
      </label>
      {!all && (
        <ul className="flex flex-col">
          {bots.map((bot) => (
            <li key={bot.id}>
              <label className="flex min-h-9 items-center gap-3 text-sm pointer-coarse:min-h-11">
                <Checkbox
                  checked={grantsBot(grant, bot.id)}
                  disabled={disabled}
                  onCheckedChange={(checked) => onChange(withBot(grant, bot.id, checked, bots))}
                />
                <span className="min-w-0 flex-1 truncate">{bot.profile.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const FEW_TOOLS = 5;

/** What a connector lets bots do: each tool's title and what it says it does, the first few at first. */
export function ToolList({ tools }: { tools: ReadonlyArray<ConnectorTool> }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  if (tools.length === 0)
    return <p className="text-sm text-muted-foreground">{t("connector.tools.none")}</p>;
  const shown = all ? tools : tools.slice(0, FEW_TOOLS);
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {shown.map((tool) => (
          <li key={tool.name} className="flex flex-col">
            <span className="text-sm font-medium">{tool.title ?? tool.name}</span>
            {tool.description !== "" && (
              <span className="line-clamp-2 text-sm text-muted-foreground">{tool.description}</span>
            )}
          </li>
        ))}
      </ul>
      {tools.length > FEW_TOOLS && (
        <Button size="sm" variant="ghost-muted" className="self-start" onClick={() => setAll(!all)}>
          {all
            ? t("connector.tools.showFewer")
            : t("connector.tools.showAll", { count: tools.length })}
        </Button>
      )}
    </div>
  );
}

/** One labelled one-line field, with a hint under it and what is wrong with it, if anything. */
export function LineField({
  label,
  hint,
  problem,
  ...input
}: {
  label: string;
  hint?: string | null | undefined;
  problem?: string | null | undefined;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password" | "url";
  placeholder?: string | undefined;
  readOnly?: boolean;
  autoFocus?: boolean;
  mono?: boolean;
}) {
  return (
    <FieldFrame label={label} hint={hint} problem={problem}>
      {(control) => (
        <input
          {...control}
          type={input.type ?? "text"}
          value={input.value}
          onChange={(event) => input.onChange(event.currentTarget.value)}
          placeholder={input.placeholder}
          readOnly={input.readOnly}
          autoFocus={input.autoFocus}
          autoComplete="off"
          spellCheck={false}
          className={cn(
            lineField,
            (input.mono || input.type === "password") && "font-mono placeholder:font-sans",
          )}
        />
      )}
    </FieldFrame>
  );
}

/**
 * A field that takes one of `choices` and nothing else, as a list to pick
 * from. Its first row is empty: "Choose one" while the field is required,
 * "None" when it may be left out.
 */
function ChoiceField({
  label,
  hint,
  problem,
  choices,
  required,
  value,
  onChange,
  readOnly,
  autoFocus,
}: {
  label: string;
  hint: string | null;
  problem: string | null;
  choices: ReadonlyArray<string>;
  required: boolean;
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
  autoFocus: boolean;
}) {
  const { t } = useI18n();
  return (
    <FieldFrame label={label} hint={hint} problem={problem}>
      {(control) => (
        <select
          {...control}
          value={value}
          aria-readonly={readOnly}
          autoFocus={autoFocus}
          onChange={(event) => {
            if (!readOnly) onChange(event.currentTarget.value);
          }}
          className={lineField}
        >
          <option value="">{required ? t("connect.choose") : t("connect.choice.none")}</option>
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      )}
    </FieldFrame>
  );
}

/** What a field's control takes from its frame: its id, and what describes it. */
export interface FieldControl {
  readonly id: string;
  readonly "aria-invalid": true | undefined;
  readonly "aria-describedby": string | undefined;
}

/** A field's label above its control, and its hint and problem below it. */
export function FieldFrame({
  label,
  hint,
  problem,
  children,
}: {
  label: string;
  hint?: string | null | undefined;
  problem?: string | null | undefined;
  children: (control: FieldControl) => ReactNode;
}) {
  const id = useId();
  const hintId = useId();
  const problemId = useId();
  const describedBy = [hint ? hintId : null, problem ? problemId : null]
    .filter((part) => part !== null)
    .join(" ");
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs">
        {label}
      </label>
      {children({
        id,
        "aria-invalid": problem ? true : undefined,
        "aria-describedby": describedBy === "" ? undefined : describedBy,
      })}
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {problem && (
        <p id={problemId} className="text-xs text-blocked">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * The fields a gallery entry's form asks for, each by its label: a secret one
 * masked, one with choices a list to pick from, an optional one said so, with
 * the entry's own description under it.
 */
export function ListingFields({
  fields,
  values,
  missing,
  readOnly,
  onChange,
}: {
  fields: ReadonlyArray<ConnectorField>;
  values: ReadonlyMap<ConnectorField["key"], string>;
  missing: ReadonlyArray<ConnectorField["key"]>;
  readOnly: boolean;
  onChange: (key: ConnectorField["key"], value: string) => void;
}) {
  const { t } = useI18n();
  return fields.map((field, index) => {
    const label = field.required ? field.label : `${field.label} (${t("connect.optional")})`;
    const problem = missing.includes(field.key)
      ? t("connect.required", { field: field.label })
      : null;
    const value = values.get(field.key) ?? "";
    const change = (next: string) => onChange(field.key, next);
    return field.choices.length > 0 ? (
      <ChoiceField
        key={field.key}
        label={label}
        hint={field.description}
        problem={problem}
        choices={field.choices}
        required={field.required}
        value={value}
        onChange={change}
        readOnly={readOnly}
        autoFocus={index === 0}
      />
    ) : (
      <LineField
        key={field.key}
        label={label}
        hint={[field.description, field.secret ? t("connect.secretHint") : null]
          .filter((part) => part !== null)
          .join(" ")}
        problem={problem}
        type={field.secret ? "password" : "text"}
        placeholder={field.placeholder ?? undefined}
        value={value}
        onChange={change}
        readOnly={readOnly}
        autoFocus={index === 0}
      />
    );
  });
}

/** A row of `PairRows`, under a key of its own while the form lives. */
export interface KeyedPair extends PairInput {
  readonly key: number;
}

/** The row `PairRows` adds after `rows`. */
const nextRow = (rows: ReadonlyArray<KeyedPair>): KeyedPair => ({
  key: rows.reduce((top, row) => Math.max(top, row.key + 1), 0),
  name: "",
  value: "",
});

/**
 * Rows of names and values, such as headers or environment variables, each
 * value masked as it is typed. `problems` says, under a row, why the server
 * would refuse it; `valuePlaceholder` what an empty value means for a row.
 */
export function PairRows({
  rows,
  problems,
  labels,
  readOnly,
  valuePlaceholder,
  onChange,
}: {
  rows: ReadonlyArray<KeyedPair>;
  /** Why a row would be refused, by its place. */
  problems: ReadonlyArray<{ readonly index: number; readonly text: string }>;
  labels: {
    readonly name: string;
    readonly value: string;
    readonly add: string;
    readonly remove: string;
  };
  readOnly: boolean;
  valuePlaceholder?: (row: KeyedPair) => string;
  onChange: (rows: ReadonlyArray<KeyedPair>) => void;
}) {
  const id = useId();
  const set = (index: number, row: KeyedPair) =>
    onChange(rows.map((current, at) => (at === index ? row : current)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => {
        const problem = problems.find((candidate) => candidate.index === index) ?? null;
        const problemId = `${id}-${row.key}`;
        return (
          <div key={row.key} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <input
                aria-label={labels.name}
                value={row.name}
                placeholder={labels.name}
                readOnly={readOnly}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={problem !== null ? true : undefined}
                aria-describedby={problem !== null ? problemId : undefined}
                onChange={(event) => set(index, { ...row, name: event.currentTarget.value })}
                className={cn(lineField, "min-w-0 flex-1 font-mono placeholder:font-sans")}
              />
              <input
                aria-label={labels.value}
                type="password"
                value={row.value}
                placeholder={valuePlaceholder?.(row) ?? labels.value}
                readOnly={readOnly}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={problem !== null ? problemId : undefined}
                onChange={(event) => set(index, { ...row, value: event.currentTarget.value })}
                className={cn(lineField, "min-w-0 flex-1 font-mono placeholder:font-sans")}
              />
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={labels.remove}
                disabled={readOnly}
                onClick={() => onChange(rows.filter((_, at) => at !== index))}
              >
                <XIcon />
              </Button>
            </div>
            {problem !== null && (
              <p id={problemId} className="text-xs text-blocked">
                {problem.text}
              </p>
            )}
          </div>
        );
      })}
      <Button
        size="sm"
        variant="ghost-muted"
        className="self-start"
        disabled={readOnly}
        onClick={() => onChange([...rows, nextRow(rows)])}
      >
        <PlusIcon aria-hidden />
        {labels.add}
      </Button>
    </div>
  );
}
