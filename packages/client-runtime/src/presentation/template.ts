// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type BotTemplate,
  BotTemplateFile,
  defaultPermissionMode,
  type EngineStatus,
  fileBytes,
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

/**
 * A field this build does not know refuses the file: the preview would not
 * show it, so the operator could not see all that the file holds.
 */
const decodeFile = Schema.decodeUnknownOption(BotTemplateFile, { onExcessProperty: "error" });

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
  if (templateFileTooLarge(fileBytes(text))) return { _tag: "too-large" };
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

/** How much of a file is read at once. */
const CHUNK = 65_536;

/**
 * Reads a file in chunks, `read` giving up to the bytes asked for and none
 * at its end, and stops once it holds more than `limit`: never more than
 * `limit + 1` bytes are asked for, whatever size the file was said to have.
 * The bytes read, or null when the file holds more than `limit`.
 */
const readWithin = async (
  read: (length: number) => Promise<Uint8Array>,
  limit: number,
): Promise<Uint8Array | null> => {
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for (;;) {
    const chunk = await read(Math.min(CHUNK, limit + 1 - total));
    if (chunk.length === 0) break;
    chunks.push(chunk);
    total += chunk.length;
    if (total > limit) return null;
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
};

/**
 * Opens a file as a template by reading it in chunks (`readWithin`): one the
 * system says is over the limit is refused unread, and one that turns out
 * longer than it said is refused once the read passes the limit, so a file
 * of any size is never held whole. One that cannot be read says so.
 */
export const openTemplateChunks = async (
  size: number | null,
  read: (length: number) => Promise<Uint8Array>,
): Promise<TemplateRead> => {
  if (size !== null && templateFileTooLarge(size)) return { _tag: "too-large" };
  try {
    const bytes = await readWithin(read, MAX_TEMPLATE_FILE_SIZE);
    return bytes === null
      ? { _tag: "too-large" }
      : readTemplateFile(new TextDecoder().decode(bytes));
  } catch {
    return { _tag: "unreadable" };
  }
};

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
 * The model and permission mode the preview shows for `template`. The client
 * sends the model as chosen, so the server creates the bot on what was shown,
 * and the mode only if the operator changes it (`templateSubmission`). The
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

/** What creating a bot from a template sends. */
export interface TemplateSubmission {
  readonly template: BotTemplate;
  readonly model: ModelChoice;
  readonly permissionMode?: PermissionMode;
}

/**
 * What Create sends from the preview: the model it showed, and the permission
 * mode only when the operator picked one. Left untouched, the mode is the
 * server's to decide as the preview did (`templatePermissionMode`), from the
 * model's default when the bot is made, never a copy of what the preview
 * worked out before. Null while there is no model to make the bot on.
 */
export const templateSubmission = (
  template: BotTemplate,
  start: TemplateStart,
  picked: PermissionMode | null,
): TemplateSubmission | null =>
  start.model._tag === "none"
    ? null
    : {
        template,
        model: start.model.choice,
        ...(picked === null ? {} : { permissionMode: picked }),
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
