// SPDX-License-Identifier: AGPL-3.0-or-later
// @effect-diagnostics nodeBuiltinImport:off -- reads this package's own templates once at load: they are part of the code, not runtime data.
import { readFileSync } from "node:fs";
import { defuseTags } from "./text.ts";

/**
 * A bot's standing instructions: layers 1 to 3 of
 * `docs/prompts/architecture.md#layers` (base prompt, profile, pinned memory).
 *
 * The text lives in `templates/`: `base.md` is the base prompt every bot shares,
 * `bot.md` is the profile and pinned memory of one bot; `browser.md` holds
 * the rules for a bot that has the browser, and `connectors.md` those for a
 * bot that can use a connector, and each goes in that bot's profile layer.
 * `{{name}}` marks a value filled at render time. The base prompt's only
 * placeholder is `{{user.name}}`, the same for every bot of an installation,
 * because on Codex it is set once per provider instance and shared by all
 * bots: so whatever differs between bots, the browser and connector rules
 * included, lives in the profile layer.
 */

const readTemplate = (name: string): string =>
  readFileSync(new URL(`./templates/${name}`, import.meta.url), "utf8");

/** The base prompt template, as edited. */
export const BASE_TEMPLATE = readTemplate("base.md");
/** The profile and pinned memory template, as edited. */
export const BOT_TEMPLATE = readTemplate("bot.md");
/** The rules for a bot that has the browser, as edited. */
export const BROWSER_TEMPLATE = readTemplate("browser.md");
/** The rules for a bot that can use a connector, as edited. */
export const CONNECTORS_TEMPLATE = readTemplate("connectors.md");

/** Placed between the base prompt and the profile when both share one file. */
const LAYER_SEPARATOR = "\n---\n\n";

const PLACEHOLDER = /\{\{([a-z_.]+)\}\}/g;

/** The placeholders each template may use. */
export const PLACEHOLDERS = {
  base: ["user.name"],
  bot: [
    "user.name",
    "user.timezone",
    "bot.name",
    "bot.title",
    "bot.is_primary",
    "bot.job",
    "bot.browser",
    "bot.connectors",
    "model.label",
    "harness.label",
    "shared.pinned",
    "bot.pinned",
  ],
} as const;

type BasePlaceholder = (typeof PLACEHOLDERS.base)[number];
type BotPlaceholder = (typeof PLACEHOLDERS.bot)[number];

/**
 * Fills every placeholder in one pass, so a value that itself contains
 * `{{…}}` is left as written. Values have envelope tags defused: a job or a
 * remembered fact cannot pose as a wake block in the system prompt. A
 * placeholder without a value is left in place; the structure tests keep the
 * templates to the known ones.
 */
const fill = <K extends string>(
  template: string,
  values: { readonly [P in K]: string },
): string => {
  const byKey = new Map<string, string>(Object.entries(values));
  return template.replace(PLACEHOLDER, (match, key: string) => {
    const value = byKey.get(key);
    return value === undefined ? match : defuseTags(value);
  });
};

/** What the instructions call the operator until they say what they want to be called. */
const UNNAMED_OPERATOR = "your user";

/** The operator, as every bot's instructions name them. */
export interface OperatorInfo {
  /** What they want to be called; null until they say, and the instructions then say "your user". */
  readonly name: string | null;
  /** An IANA time zone name, such as `America/Sao_Paulo`. */
  readonly timeZone: string;
}

/** Everything one bot's instructions are rendered from. */
export interface BotInstructionsInput {
  readonly operator: OperatorInfo;
  readonly profile: {
    readonly name: string;
    /** Empty when the operator gave none. */
    readonly title: string;
    /** Empty until the operator or the bot sets one. */
    readonly job: string;
    readonly primary: boolean;
  };
  /** Display labels: `Claude Opus 5.5`, `Claude Code`. */
  readonly runtime: { readonly model: string; readonly harness: string };
  /** The pinned memory files, as Markdown. Empty when there is nothing pinned. */
  readonly pinned: { readonly shared: string; readonly bot: string };
  /** Whether the bot has the engine's browser: its rules are rendered only then. */
  readonly browser: boolean;
  /**
   * Whether the operator gave the bot a connector, connected or not: its
   * rules are rendered only then.
   */
  readonly connectors: boolean;
}

const orElse = (value: string, fallback: string): string =>
  value.trim() === "" ? fallback : value.trim();

/**
 * The base prompt, the same for every bot of an installation. On Codex this is
 * the provider instance's `developer_instructions`.
 */
export const renderBaseInstructions = (operator: Pick<OperatorInfo, "name">): string =>
  fill<BasePlaceholder>(BASE_TEMPLATE, { "user.name": operator.name ?? UNNAMED_OPERATOR });

/**
 * One bot's profile and pinned memory. On Codex this is the workspace's
 * `AGENTS.md`.
 */
export const renderBotInstructions = (input: BotInstructionsInput): string =>
  fill<BotPlaceholder>(BOT_TEMPLATE, {
    "user.name": input.operator.name ?? UNNAMED_OPERATOR,
    "user.timezone": input.operator.timeZone,
    "bot.name": input.profile.name,
    "bot.title": orElse(input.profile.title, "none"),
    "bot.is_primary": input.profile.primary ? "yes" : "no",
    "bot.job": orElse(input.profile.job, "Not set yet."),
    // Its own section between the job and pinned memory, or nothing.
    "bot.browser": input.browser ? `\n${BROWSER_TEMPLATE}` : "",
    "bot.connectors": input.connectors ? `\n${CONNECTORS_TEMPLATE}` : "",
    "model.label": input.runtime.model,
    "harness.label": input.runtime.harness,
    "shared.pinned": orElse(input.pinned.shared, "Nothing yet."),
    "bot.pinned": orElse(input.pinned.bot, "Nothing yet."),
  });

/**
 * A bot's `.j3/system.md` for Claude Code: the base prompt, then the profile
 * and pinned memory, in one file the launch argument appends to the system
 * prompt.
 */
export const renderSystemFile = (input: BotInstructionsInput): string =>
  renderBaseInstructions(input.operator) + LAYER_SEPARATOR + renderBotInstructions(input);
