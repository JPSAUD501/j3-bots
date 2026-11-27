// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type ConnectorTone,
  connectorTone,
  grantsBot,
  withBot,
} from "@j3-bots/client-runtime/presentation";
import { connectorStatusText } from "@j3-bots/client-runtime/wording";
import type {
  Bot,
  Connector,
  ConnectorField,
  ConnectorGlyph,
  ConnectorGrant,
  ConnectorSkill,
  ConnectorTool,
} from "@j3-bots/contracts";
import { CONNECTOR_GLYPHS, isConnectorGlyphName } from "@j3-bots/design-tokens";
import { ChevronRight } from "lucide-react-native";
import { type ReactNode, useState } from "react";
import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { BotAvatar } from "../components/avatar/BotAvatar.tsx";
import { ChoiceRow, Problem, SwitchRow, TextField } from "../components/form.tsx";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { usePresentation } from "../presentation.tsx";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { useColor } from "../theme.ts";
import { Button } from "../ui.tsx";
import { SecretField } from "../secrets/SecretsForms.tsx";

/** The lines of a glyph this client has, or null for one it does not. */
const glyphPaths = (glyph: ConnectorGlyph): ReadonlyArray<string> | null => {
  // As a plain name: the set is keyed by names, not by the contract's branded ones.
  const name: string = glyph;
  return isConnectorGlyphName(name) ? CONNECTOR_GLYPHS[name] : null;
};

const tileLook = {
  sm: { box: "size-6", text: "text-xs", glyph: 14 },
  md: { box: "size-9", text: "text-base", glyph: 18 },
  lg: { box: "size-12", text: "text-xl", glyph: 24 },
} as const;

/**
 * A connector's tile, on a quiet fill: the glyph it names, drawn as a line
 * like the app's other icons, or its first letter in the display face when it
 * names none or one this client does not have.
 */
export function ConnectorTile({
  name,
  glyph,
  size = "md",
}: {
  readonly name: string;
  readonly glyph: ConnectorGlyph | null;
  /** `sm` heads a connector's app in a reply. */
  readonly size?: "sm" | "md" | "lg";
}) {
  const stroke = useColor("accent-foreground");
  const paths = glyph === null ? null : glyphPaths(glyph);
  const look = tileLook[size];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={`shrink-0 items-center justify-center rounded-md bg-muted ${look.box}`}
    >
      {paths === null ? (
        <Text face="display" className={`font-semibold text-foreground ${look.text}`}>
          {Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?"}
        </Text>
      ) : (
        <Svg
          width={look.glyph}
          height={look.glyph}
          viewBox="0 0 24 24"
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {paths.map((d) => (
            <Path key={d} d={d} />
          ))}
        </Svg>
      )}
    </View>
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
export function StatusWord({ connector }: { readonly connector: Connector }) {
  const ctx = usePresentation();
  const tone = connectorTone(connector);
  const { label } = connectorStatusText(connector.status, ctx);
  return (
    <View className="flex-row items-center gap-1.5">
      <View className={`size-1.5 rounded-pill ${toneDot[tone]}`} />
      <Text className={`text-xs ${toneText[tone]}`}>{label}</Text>
    </View>
  );
}

/**
 * A connector's status on its page: the word and its light, why bots cannot
 * use it and since when, and the one thing that fixes it, when the operator
 * can: sign in again (`onReconnect`), or open the secrets (`onOpenSecrets`),
 * where they are unlocked, or the one its settings name is saved or shared.
 */
export function StatusBlock({
  connector,
  onReconnect,
  onOpenSecrets,
}: {
  readonly connector: Connector;
  readonly onReconnect: (() => void) | null;
  readonly onOpenSecrets: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const tone = connectorTone(connector);
  const text = connectorStatusText(connector.status, ctx);
  const action =
    connector.status._tag === "secrets-unavailable" || connector.status._tag === "needs-secret"
      ? { label: t("connector.openSecrets"), run: onOpenSecrets }
      : connector.status._tag === "needs-sign-in" && onReconnect !== null
        ? { label: t("connector.reconnect"), run: onReconnect }
        : null;
  const detail = [text.detail, text.since].filter((part) => part !== null).join(" ");
  return (
    <View
      className={`gap-2 rounded-lg px-3 py-2.5 ${
        tone === "connected"
          ? "bg-muted"
          : tone === "needs-you"
            ? "bg-waiting-surface"
            : "bg-blocked-surface"
      }`}
    >
      <View className="flex-row items-center gap-2">
        <View className={`size-2 rounded-pill ${toneDot[tone]}`} />
        <Text
          accessibilityRole="header"
          className={`text-sm font-medium ${tone === "connected" ? "text-foreground" : toneText[tone]}`}
        >
          {text.label}
        </Text>
      </View>
      {detail !== "" && <Text className="text-sm text-foreground">{detail}</Text>}
      {text.next !== null && <Text className="text-sm text-foreground">{text.next}</Text>}
      {action !== null && (
        <View className="items-start">
          <Button variant="primary" label={action.label} onPress={action.run} />
        </View>
      )}
    </View>
  );
}

/** A connector's name and who offers it, under its tile, at the top of its page. */
export function ConnectorHeading({
  name,
  glyph,
  publisher,
}: {
  readonly name: string;
  readonly glyph: ConnectorGlyph | null;
  readonly publisher: string | null;
}) {
  return (
    <View className="flex-row items-center gap-3">
      <ConnectorTile name={name} glyph={glyph} size="lg" />
      <View className="min-w-0 flex-1">
        <Text
          accessibilityRole="header"
          face="display"
          numberOfLines={2}
          className="text-xl text-foreground"
        >
          {name}
        </Text>
        {publisher !== null && <Text className="text-sm text-muted-foreground">{publisher}</Text>}
      </View>
    </View>
  );
}

/** A heading inside a connector's page, with what it heads. */
export function PageSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <View className="gap-2">
      <Text accessibilityRole="header" className="text-xs font-medium text-muted-foreground">
        {title}
      </Text>
      {children}
    </View>
  );
}

/** A row that opens a page: what it shows, then a chevron. */
export function OpenRow({
  label,
  hint,
  onPress,
  children,
}: {
  /** What a screen reader says for the row. */
  readonly label: string;
  readonly hint?: string;
  readonly onPress: () => void;
  readonly children: ReactNode;
}) {
  return (
    <PressScale
      depth="row"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      className="-mx-2 min-h-11 flex-row items-center gap-3 rounded-md px-2 py-2 active:bg-muted"
    >
      {children}
      <Icon icon={ChevronRight} size={14} color="accent-muted-foreground" />
    </PressScale>
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
  readonly bots: ReadonlyArray<Bot>;
  readonly grant: ConnectorGrant;
  readonly onChange: (grant: ConnectorGrant) => void;
  readonly disabled?: boolean;
}) {
  const { t } = useI18n();
  const all = grant._tag === "all-bots";
  return (
    <View className="gap-2">
      <SwitchRow
        label={t("connector.bots.all")}
        value={all}
        readOnly={disabled}
        onChange={(checked) =>
          onChange(
            checked ? { _tag: "all-bots" } : { _tag: "bots", ids: bots.map((bot) => bot.id) },
          )
        }
      />
      {!all &&
        bots.map((bot) => (
          <ChoiceRow
            key={bot.id}
            kind="any"
            label={bot.profile.name}
            selected={grantsBot(grant, bot.id)}
            unavailable={disabled}
            leading={
              <BotAvatar avatar={bot.profile.avatar} seed={bot.id} state="idle" size={24} still />
            }
            onPress={() => onChange(withBot(grant, bot.id, !grantsBot(grant, bot.id), bots))}
          />
        ))}
    </View>
  );
}

const FEW_SERVED = 5;

/** One thing a connector's server offers bots: its title and what it says it is for. */
export interface ServedItem {
  /** What tells it apart from the others its server offers: a tool's name, a skill's address. */
  readonly key: string;
  readonly title: string;
  readonly description: string;
}

/** A connector's tools as the list shows them. */
export const toolItems = (tools: ReadonlyArray<ConnectorTool>): ReadonlyArray<ServedItem> =>
  tools.map((tool) => ({
    key: tool.name,
    title: tool.title ?? tool.name,
    description: tool.description,
  }));

/** A connector's skills as the list shows them. */
export const skillItems = (skills: ReadonlyArray<ConnectorSkill>): ReadonlyArray<ServedItem> =>
  skills.map((skill) => ({ key: skill.uri, title: skill.name, description: skill.description }));

/**
 * What a connector's server offers bots, its tools or its skills: each one's
 * title and what it says it is for, the first few at first.
 */
export function ServedList({ items }: { readonly items: ReadonlyArray<ServedItem> }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, FEW_SERVED);
  return (
    <View className="gap-2">
      {shown.map((item) => (
        <View key={item.key}>
          <Text className="text-sm font-medium text-foreground">{item.title}</Text>
          {item.description !== "" && (
            <Text numberOfLines={2} className="text-sm text-muted-foreground">
              {item.description}
            </Text>
          )}
        </View>
      ))}
      {items.length > FEW_SERVED && (
        <View className="items-start">
          <Button
            variant="quiet"
            label={
              all
                ? t("connector.list.showFewer")
                : t("connector.list.showAll", { count: items.length })
            }
            onPress={() => setAll(!all)}
          />
        </View>
      )}
    </View>
  );
}

/**
 * A masked field with what it is for under it, and why it is wrong once it
 * is. What is typed is never suggested, kept by the keyboard or autofilled.
 */
function SecretLine({
  label,
  hint,
  problem,
  value,
  onChange,
  readOnly,
}: {
  readonly label: string;
  readonly hint: string | null;
  readonly problem: string | null;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly readOnly: boolean;
}) {
  return (
    <View className="gap-1">
      <SecretField
        label={label}
        value={value}
        onChange={onChange}
        invalid={problem !== null}
        editable={!readOnly}
      />
      {hint !== null && hint !== "" && (
        <Text className="text-xs text-muted-foreground">{hint}</Text>
      )}
      <Problem>{problem}</Problem>
    </View>
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
  readonly fields: ReadonlyArray<ConnectorField>;
  readonly values: ReadonlyMap<ConnectorField["key"], string>;
  readonly missing: ReadonlyArray<ConnectorField["key"]>;
  readonly readOnly: boolean;
  readonly onChange: (key: ConnectorField["key"], value: string) => void;
}) {
  const { t } = useI18n();
  return fields.map((field) => {
    const label = field.required ? field.label : `${field.label} (${t("connect.optional")})`;
    const problem = missing.includes(field.key)
      ? t("connect.required", { field: field.label })
      : null;
    const value = values.get(field.key) ?? "";
    const change = (next: string) => onChange(field.key, next);
    if (field.choices.length > 0) {
      return (
        <View key={field.key} className="gap-2">
          <Text className="text-sm text-foreground">{label}</Text>
          {field.description !== null && (
            <Text className="text-xs text-muted-foreground">{field.description}</Text>
          )}
          {!field.required && (
            <ChoiceRow
              kind="one"
              label={t("connect.choice.none")}
              selected={value === ""}
              unavailable={readOnly}
              onPress={() => change("")}
            />
          )}
          {field.choices.map((choice) => (
            <ChoiceRow
              key={choice}
              kind="one"
              label={choice}
              selected={value === choice}
              unavailable={readOnly}
              onPress={() => change(choice)}
            />
          ))}
          <Problem>{problem}</Problem>
        </View>
      );
    }
    return field.secret ? (
      <SecretLine
        key={field.key}
        label={label}
        hint={[field.description, t("connect.secretHint")]
          .filter((part) => part !== null)
          .join(" ")}
        problem={problem}
        value={value}
        onChange={change}
        readOnly={readOnly}
      />
    ) : (
      <TextField
        key={field.key}
        label={label}
        {...(field.description === null ? {} : { hint: field.description })}
        {...(field.placeholder === null ? {} : { placeholder: field.placeholder })}
        error={problem}
        value={value}
        onChange={change}
        readOnly={readOnly}
        autoCapitalize="none"
      />
    );
  });
}

/** A command line, as the server would run it, in the mono face. */
export function CommandLine({ text }: { readonly text: string }) {
  return (
    <View className="rounded-md bg-muted px-3 py-2">
      <Text face="mono" selectable className="text-sm text-foreground">
        {text}
      </Text>
    </View>
  );
}
