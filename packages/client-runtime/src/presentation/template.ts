// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BotTemplate,
  BotTemplateFile,
  defaultPermissionMode,
  type EngineStatus,
  MAX_TEMPLATE_FILE_SIZE,
  type ModelChoice,
  type PermissionMode,
  TEMPLATE_FILE_EXTENSION,
  TEMPLATE_FORMAT,
  TEMPLATE_MEDIA_TYPE,
  TEMPLATE_VERSION,
  templatePermissionMode,
} from "@j3-bots/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Shared, SharedFile } from "./share.ts";

/** What reading a file as a template found. */
export type TemplateRead =
  | { readonly _tag: "template"; readonly template: BotTemplate }
  /** Over `MAX_TEMPLATE_FILE_SIZE`. */
  | { readonly _tag: "too-large" }
  /** A template of a version after this build's, which may hold what it cannot show. */
  | { readonly _tag: "newer" }
  /** Not a template, or one that breaks the schema or its limits. */
  | { readonly _tag: "invalid" }
  /** The platform could not read the file at all. */
  | { readonly _tag: "unreadable" };

const decodeFile = Schema.decodeUnknownOption(BotTemplateFile);

/** Just enough of a file to tell a later template from something else. */
const Envelope = Schema.fromJsonString(
  Schema.Struct({ format: Schema.Literal(TEMPLATE_FORMAT), version: Schema.Int }),
);
const decodeEnvelope = Schema.decodeUnknownOption(Envelope);

/**
 * Whether a file is over the template size limit, by the size the platform
 * gives it, in bytes: such a file is refused before it is read.
 */
export const templateFileTooLarge = (size: number): boolean => size > MAX_TEMPLATE_FILE_SIZE;

/**
 * Reads a file the operator picked, dropped or was sent as a template. It is
 * untrusted: text over the size limit is refused, and the rest must decode
 * whole with the template's schema. Nothing is created from it here.
 */
export const readTemplateFile = (text: string): TemplateRead => {
  if (templateFileTooLarge(new TextEncoder().encode(text).length)) return { _tag: "too-large" };
  const decoded = decodeFile(text);
  if (Option.isSome(decoded)) return { _tag: "template", template: decoded.value };
  const envelope = decodeEnvelope(text);
  return Option.isSome(envelope) && envelope.value.version > TEMPLATE_VERSION
    ? { _tag: "newer" }
    : { _tag: "invalid" };
};

/**
 * Opens a file on the device as a template: one whose `size` is over the
 * limit is refused before `text` reads it, and one that cannot be read says so.
 */
export const openTemplateFile = (
  size: number,
  text: () => Promise<string>,
): Promise<TemplateRead> =>
  templateFileTooLarge(size)
    ? Promise.resolve({ _tag: "too-large" })
    : text().then(readTemplateFile, (): TemplateRead => ({ _tag: "unreadable" }));

const encodeTemplate = Schema.encodeSync(BotTemplate);

/** The template as its file holds it: indented JSON, readable in any editor. */
export const templateFileText = (template: BotTemplate): string =>
  `${JSON.stringify(encodeTemplate(template), null, 2)}\n`;

/** The file's name: the bot's name in plain lowercase letters and digits, "ana-inbox.j3bot". */
export const templateFileName = (botName: string): string => {
  const stem = botName
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${stem === "" ? "bot" : stem}${TEMPLATE_FILE_EXTENSION}`;
};

/** Whether a file's name says it is a template. */
export const isTemplateFileName = (name: string): boolean =>
  name.toLowerCase().endsWith(TEMPLATE_FILE_EXTENSION);

/**
 * The template file a share is, when it is one and nothing else: a single
 * file named as a template or of its media type, with no text or link. A
 * share that holds anything more goes to a conversation's draft as it is.
 */
export const sharedTemplate = ({ text, url, files }: Shared): SharedFile | null => {
  const [file, ...more] = files;
  if (file === undefined || more.length > 0 || text !== null || url !== null) return null;
  return isTemplateFileName(file.name) || file.mediaType === TEMPLATE_MEDIA_TYPE ? file : null;
};

/** The model a bot made from a template runs on here, as the preview shows it. */
export type TemplateModel =
  /** The template's own, which the engine offers. */
  | { readonly _tag: "template"; readonly choice: ModelChoice; readonly name: string }
  /** The template's is not offered here: the first one the engine can run takes its place. */
  | {
      readonly _tag: "replaced";
      readonly choice: ModelChoice;
      readonly name: string;
      /** The template's model, as it names it. */
      readonly asked: string;
    }
  /** The engine offers no model yet: no bot can be made until a provider lists one. */
  | { readonly _tag: "none" };

/** A model the preview found for the bot. */
type ChosenModel = Exclude<TemplateModel, { readonly _tag: "none" }>;

/** What a bot made from `template` starts with on this server, before the operator changes any of it. */
export interface TemplateStart {
  readonly model: TemplateModel;
  /**
   * The template's permission mode unless the model's default lets the bot do
   * less (`templatePermissionMode`); supervised while there is no model.
   */
  readonly permissionMode: PermissionMode;
  /** The mode the template asks for, when the bot starts with less; null otherwise. */
  readonly asked: PermissionMode | null;
}

/** `Provider · Model`, as the engine names them. */
const modelName = (engine: EngineStatus, choice: ModelChoice): string | null => {
  const provider = engine.providers.find((each) => each.id === choice.providerId);
  const model = provider?.models.find((each) => each.id === choice.modelId);
  return provider && model ? `${provider.name} · ${model.name}` : null;
};

/**
 * The model and permission mode the preview shows for `template`, which the
 * client then sends as chosen, so the server creates what was shown. The
 * template's model when the engine offers it; otherwise the first model of
 * the first provider that is ready, or with none ready, of one that lists
 * models.
 */
export const templateStart = (
  template: BotTemplate,
  engine: EngineStatus | null,
): TemplateStart => {
  const none = startWith({ _tag: "none" }, "supervised", template);
  if (engine === null) return none;
  const own = modelName(engine, template.model);
  const model: ChosenModel | null =
    own !== null
      ? { _tag: "template", choice: template.model, name: own }
      : replacement(engine, template.model);
  if (model === null) return none;
  return startWith(
    model,
    templatePermissionMode(template.permissionMode, defaultPermissionMode(engine, model.choice)),
    template,
  );
};

const startWith = (
  model: TemplateModel,
  permissionMode: PermissionMode,
  template: BotTemplate,
): TemplateStart => {
  const asked = template.permissionMode;
  return {
    model,
    permissionMode,
    asked: asked === "unknown" || asked === permissionMode ? null : asked,
  };
};

const replacement = (engine: EngineStatus, asked: ModelChoice): ChosenModel | null => {
  const listing = engine.providers.filter((provider) => provider.models.length > 0);
  const provider = listing.find((each) => each.status._tag === "ready") ?? listing[0];
  const model = provider?.models[0];
  if (provider === undefined || model === undefined) return null;
  return {
    _tag: "replaced",
    choice: { providerId: provider.id, modelId: model.id },
    name: `${provider.name} · ${model.name}`,
    asked: asked.modelId,
  };
};
