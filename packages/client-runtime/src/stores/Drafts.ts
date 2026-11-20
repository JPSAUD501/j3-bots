// SPDX-License-Identifier: AGPL-3.0-or-later
import { Attachment, type EntryTarget, type Mentions, MessageText } from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { Files, uploadProblem } from "../files/Files.ts";
import {
  admitFiles,
  type FileProblem,
  type LocalFile,
  normalizeMediaType,
} from "../files/limits.ts";
import { ClientStorage } from "../ports.ts";
import { Cell, type Readable } from "../Store.ts";
import { Conversations, targetKey } from "./Conversations.ts";

/** A file in the composer, from the moment the operator picks it. */
export type DraftFile =
  | ({ readonly _tag: "uploading"; readonly key: string; readonly sent: number } & LocalFile)
  | { readonly _tag: "ready"; readonly key: string; readonly attachment: Attachment }
  | ({ readonly _tag: "failed"; readonly key: string; readonly problem: FileProblem } & LocalFile);

/** What the operator is writing to one conversation or room, and has not sent. */
export interface Draft {
  readonly text: string;
  readonly files: ReadonlyArray<DraftFile>;
}

const empty: Draft = { text: "", files: [] };

/** What `send` did with the draft. */
export type DraftSendResult =
  /** It is on its way, through the outbox. */
  | "sent"
  /** There was nothing to send. */
  | "empty"
  /** A file is still uploading or could not be attached. */
  | "not-ready";

/** A draft as the device keeps it: the text and the files already on the server. */
const StoredDraft = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Struct({ text: MessageText, files: Schema.Array(Attachment) })),
);
const encodeStored = Schema.encodeEffect(StoredDraft);
const decodeStored = Schema.decodeUnknownOption(StoredDraft);

const localFileOf = (file: DraftFile): LocalFile =>
  file._tag === "ready"
    ? {
        name: file.attachment.name,
        mediaType: file.attachment.mediaType,
        size: file.attachment.size,
      }
    : file;

const isEmpty = (draft: Draft) => draft.text === "" && draft.files.length === 0;

/**
 * Every conversation's draft, kept on the device so a reload loses nothing:
 * its text, and the files already uploaded for it. A file still uploading is
 * kept only in memory. Files upload as soon as they are attached, and the
 * draft is sent once they all have.
 */
export class Drafts extends Context.Service<
  Drafts,
  {
    /** Drafts by `targetKey`. A target with no entry has an empty draft. */
    readonly state: Readable<ReadonlyMap<string, Draft>>;
    readonly setText: (target: EntryTarget, text: string) => Effect.Effect<void>;
    /**
     * Adds files to the draft and uploads each the contract's limits allow.
     * A file that breaks one stays in the draft as `failed`, saying which.
     */
    readonly attach: (
      target: EntryTarget,
      files: ReadonlyArray<{ readonly name: string; readonly body: Blob }>,
    ) => Effect.Effect<void>;
    /** Takes a file out of the draft, stopping its upload. */
    readonly detach: (target: EntryTarget, key: string) => Effect.Effect<void>;
    /**
     * Sends the draft and clears it in one step, so sending twice sends once:
     * the second finds the draft empty.
     */
    readonly send: (target: EntryTarget, mentions?: Mentions) => Effect.Effect<DraftSendResult>;
  }
>()("@j3-bots/client-runtime/stores/Drafts") {}

export const layer = Layer.effect(
  Drafts,
  Effect.gen(function* () {
    const storage = yield* ClientStorage;
    const files = yield* Files;
    const conversations = yield* Conversations;
    const scope = yield* Scope.Scope;

    const stored = yield* storage
      .readAll("drafts")
      .pipe(
        Effect.catchTag("LocalStorageError", (error) =>
          Effect.logWarning("Drafts could not be read", error).pipe(
            Effect.as(new Map<string, string>()),
          ),
        ),
      );
    const restored = new Map<string, Draft>();
    for (const [key, value] of stored) {
      const draft = decodeStored(value);
      if (Option.isNone(draft)) continue;
      restored.set(key, {
        text: draft.value.text,
        files: draft.value.files.map((attachment) => ({
          _tag: "ready",
          key: attachment.id,
          attachment,
        })),
      });
    }
    const state = new Cell<ReadonlyMap<string, Draft>>(restored);
    const uploads = new Map<string, Fiber.Fiber<void>>();
    let nextKey = 0;

    // Writes go through one writer that always writes the latest draft of each
    // key, so a burst of keystrokes costs a few writes, never a queue of them.
    const unwritten = new Set<string>();
    const wake = yield* Queue.sliding<void>(1);
    const persisted = (draft: Draft) => ({
      text: draft.text,
      files: draft.files.flatMap((file) => (file._tag === "ready" ? [file.attachment] : [])),
    });
    const writeOne = (key: string) => {
      const draft = state.get().get(key) ?? empty;
      const record = persisted(draft);
      const write =
        record.text === "" && record.files.length === 0
          ? storage.remove("drafts", key)
          : encodeStored(record).pipe(
              Effect.flatMap((value) => storage.write("drafts", key, value)),
            );
      return write.pipe(
        Effect.catchTags({
          LocalStorageError: (error) => Effect.logWarning("A draft is kept in memory only", error),
          SchemaError: (error) => Effect.logError("A draft could not be encoded", error),
        }),
      );
    };
    yield* Effect.gen(function* () {
      while (true) {
        yield* Queue.take(wake);
        const keys = [...unwritten];
        unwritten.clear();
        for (const key of keys) yield* writeOne(key);
      }
    }).pipe(Effect.forkIn(scope));

    /** Changes one draft at once, and has the writer keep it. */
    const changeNow = (key: string, update: (draft: Draft) => Draft) => {
      const current = state.get();
      const before = current.get(key) ?? empty;
      const after = update(before);
      if (after === before) return;
      const next = new Map(current);
      if (isEmpty(after)) next.delete(key);
      else next.set(key, after);
      state.set(next);
      unwritten.add(key);
      Queue.offerUnsafe(wake, void 0);
    };
    const change = (key: string, update: (draft: Draft) => Draft) =>
      Effect.sync(() => changeNow(key, update));

    const replaceFileNow = (key: string, fileKey: string, file: DraftFile) =>
      changeNow(key, (draft) =>
        draft.files.some((candidate) => candidate.key === fileKey)
          ? {
              ...draft,
              files: draft.files.map((candidate) => (candidate.key === fileKey ? file : candidate)),
            }
          : draft,
      );
    const replaceFile = (key: string, fileKey: string, file: DraftFile) =>
      Effect.sync(() => replaceFileNow(key, fileKey, file));

    const setText = (target: EntryTarget, text: string) =>
      change(targetKey(target), (draft) => (draft.text === text ? draft : { ...draft, text }));

    const attach = Effect.fn("Drafts.attach")(function* (
      target: EntryTarget,
      added: ReadonlyArray<{ readonly name: string; readonly body: Blob }>,
    ) {
      const key = targetKey(target);
      const held = (state.get().get(key)?.files ?? [])
        .filter((file) => file._tag !== "failed")
        .map(localFileOf);
      const picked = added.map((file) => ({
        local: {
          name: file.name,
          mediaType: normalizeMediaType(file.body.type),
          size: file.body.size,
        },
        body: file.body,
        key: `local-${++nextKey}`,
      }));
      const problems = admitFiles(
        held,
        picked.map((file) => file.local),
      );
      const entries: Array<DraftFile> = picked.map((file, index) => {
        const problem = problems[index] ?? null;
        return problem === null
          ? { _tag: "uploading", key: file.key, sent: 0, ...file.local }
          : { _tag: "failed", key: file.key, problem, ...file.local };
      });
      yield* change(key, (draft) => ({ ...draft, files: [...draft.files, ...entries] }));

      for (const [index, file] of picked.entries()) {
        if (problems[index] !== null) continue;
        const fileKey = file.key;
        const progress = (sent: number) => {
          const current = state
            .get()
            .get(key)
            ?.files.find((candidate) => candidate.key === fileKey);
          if (current?._tag !== "uploading" || current.sent === sent) return;
          replaceFileNow(key, fileKey, { ...current, sent });
        };
        const fiber = yield* files
          .upload({
            name: file.local.name,
            mediaType: file.local.mediaType,
            body: file.body,
            onProgress: progress,
          })
          .pipe(
            Effect.matchEffect({
              onSuccess: (attachment) =>
                replaceFile(key, fileKey, { _tag: "ready", key: fileKey, attachment }),
              onFailure: (error) =>
                replaceFile(key, fileKey, {
                  _tag: "failed",
                  key: fileKey,
                  problem: uploadProblem(error),
                  ...file.local,
                }),
            }),
            Effect.ensuring(Effect.sync(() => uploads.delete(fileKey))),
            Effect.forkIn(scope),
          );
        uploads.set(fileKey, fiber);
      }
    });

    const detach = (target: EntryTarget, fileKey: string) =>
      Effect.suspend(() => {
        const upload = uploads.get(fileKey);
        uploads.delete(fileKey);
        return change(targetKey(target), (draft) =>
          draft.files.some((file) => file.key === fileKey)
            ? { ...draft, files: draft.files.filter((file) => file.key !== fileKey) }
            : draft,
        ).pipe(Effect.andThen(upload === undefined ? Effect.void : Fiber.interrupt(upload)));
      });

    /** Takes the draft for sending, clearing it in the same step, or says why not. */
    const take = (key: string) =>
      Effect.sync(() => {
        const draft = state.get().get(key) ?? empty;
        if (draft.files.some((file) => file._tag !== "ready")) return "not-ready" as const;
        const text = draft.text.trim();
        const attachments = draft.files.flatMap((file) =>
          file._tag === "ready" ? [file.attachment] : [],
        );
        if (text === "" && attachments.length === 0) return "empty" as const;
        changeNow(key, () => empty);
        return { text, attachments };
      });

    const send = Effect.fn("Drafts.send")(function* (target: EntryTarget, mentions?: Mentions) {
      const taken = yield* take(targetKey(target));
      if (typeof taken === "string") return taken;
      // The outbox holds the message from here; its delivery outlives the caller.
      yield* conversations.enqueue({
        target,
        ...taken,
        ...(mentions === undefined ? {} : { mentions }),
      });
      return "sent" as const;
    });

    return Drafts.of({ state, setText, attach, detach, send });
  }),
);
