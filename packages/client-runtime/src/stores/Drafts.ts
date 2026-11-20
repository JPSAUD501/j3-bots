// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Attachment,
  type EntryTarget,
  MAX_MESSAGE_LENGTH,
  type Mentions,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import { Connection } from "../connection/Connection.ts";
import { Files, uploadProblem } from "../files/Files.ts";
import {
  admitFiles,
  type FileProblem,
  type LocalFile,
  normalizeMediaType,
} from "../files/limits.ts";
import { ClientStorage, type LocalStorageError } from "../ports.ts";
import { Cell, type Readable, waitFor } from "../Store.ts";
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
  /**
   * `send` is moving it to the outbox, which takes a few milliseconds. It
   * takes no change meanwhile: what it holds is what goes.
   */
  readonly sending: boolean;
}

const empty: Draft = { text: "", files: [], sending: false };

/** What `send` did with the draft. */
export type DraftSendResult =
  /** It is on its way, through the outbox. */
  | "sent"
  /** There was nothing to send. */
  | "empty"
  /** A file is still uploading or could not be attached. */
  | "not-ready"
  /** The text is longer than `MAX_MESSAGE_LENGTH`. */
  | "too-long"
  /** The device could not keep the message, so it stays in the draft. */
  | "not-kept"
  /**
   * Another window sent or changed the draft since this one read it. Nothing
   * was sent, and the draft now shows what the device keeps.
   */
  | "changed-elsewhere";

/**
 * A draft as the device keeps it: the text and the files already on the
 * server. Each write gives it a new `revision`, so a window can tell whether
 * the draft is still the one it read. The text is kept whatever its length:
 * the limit of a message applies when it is sent.
 */
const StoredDraft = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({
      revision: Schema.String,
      text: Schema.String,
      files: Schema.Array(Attachment),
    }),
  ),
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

/** A draft as the device keeps it, as this window shows it. */
const shown = (stored: typeof StoredDraft.Type): Draft => ({
  text: stored.text,
  files: stored.files.map((attachment) => ({ _tag: "ready", key: attachment.id, attachment })),
  sending: false,
});

/**
 * Every conversation's draft, kept on the device so a reload loses nothing:
 * its text, and the files already uploaded for it. A file still uploading is
 * kept only in memory. Files upload as soon as they are attached; the draft
 * can be sent once they all have.
 */
export class Drafts extends Context.Service<
  Drafts,
  {
    /** Drafts by `targetKey`. A target with no entry has an empty draft. */
    readonly state: Readable<ReadonlyMap<string, Draft>>;
    /** Changes the draft's text, unless it is `sending`. */
    readonly setText: (target: EntryTarget, text: string) => Effect.Effect<void>;
    /**
     * Adds files to the draft and uploads each the contract's limits allow.
     * A file that breaks one stays in the draft as `failed`, saying which.
     * A draft that is `sending` takes no files.
     */
    readonly attach: (
      target: EntryTarget,
      files: ReadonlyArray<{ readonly name: string; readonly body: Blob }>,
    ) => Effect.Effect<void>;
    /** Takes a file out of the draft, stopping its upload. */
    readonly detach: (target: EntryTarget, key: string) => Effect.Effect<void>;
    /**
     * Moves the draft to the outbox in one storage transaction, so a crash
     * leaves it in exactly one of them, and sending twice sends once: the
     * second finds the draft empty. The transaction claims the draft as this
     * window last read or wrote it, so two windows never send it twice.
     */
    readonly send: (target: EntryTarget, mentions?: Mentions) => Effect.Effect<DraftSendResult>;
    /**
     * Each draft another window sent or changed while this one was changing
     * or sending it. Nothing this window held was written: it now shows the
     * draft as the device keeps it, and `restore` puts its text back.
     */
    readonly changedElsewhere: Stream.Stream<EntryTarget>;
    /**
     * Puts back the text this window held when another window changed the
     * draft, as a new change to the draft as it is now.
     */
    readonly restore: (target: EntryTarget) => Effect.Effect<void>;
    /**
     * Stops every upload and drops every draft, here and on the device. It
     * happens by itself whenever the device has no credential.
     */
    readonly discardAll: Effect.Effect<void, LocalStorageError>;
  }
>()("@j3-bots/client-runtime/stores/Drafts") {}

export const layer = Layer.effect(
  Drafts,
  Effect.gen(function* () {
    const storage = yield* ClientStorage;
    const connection = yield* Connection;
    const files = yield* Files;
    const conversations = yield* Conversations;
    const random = yield* SecureRandom.SecureRandom;
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
    // Each draft as the device keeps it, by key, as this window last read or wrote it.
    const known = new Map<string, string>();
    for (const [key, value] of stored) {
      // Even a record this window cannot read is the one its next write claims.
      known.set(key, value);
      const draft = decodeStored(value);
      if (Option.isSome(draft)) restored.set(key, shown(draft.value));
    }
    const state = new Cell<ReadonlyMap<string, Draft>>(restored);
    const uploads = new Map<string, Fiber.Fiber<void>>();
    // The text this window held when another window changed its draft, by key.
    const displaced = new Map<string, string>();
    const changes = yield* PubSub.unbounded<EntryTarget>();
    let nextKey = 0;

    // Writes go through one writer that always writes the latest draft of each
    // key, so a burst of keystrokes costs a few writes, never a queue of them.
    // Each write claims the draft as this window last read or wrote it, as
    // `send` does, and the two take turns: a window never writes over what
    // another window sent or changed.
    const turn = yield* Semaphore.make(1);
    const unwritten = new Map<string, EntryTarget>();
    const wake = yield* Queue.sliding<void>(1);
    const persisted = (draft: Draft) => ({
      text: draft.text,
      files: draft.files.flatMap((file) => (file._tag === "ready" ? [file.attachment] : [])),
    });
    const revision = random.randomBytes(12).pipe(Effect.map(Base64Url.encode));

    /** Shows `draft` as the draft of `key`. */
    const show = (key: string, draft: Draft) => {
      const next = new Map(state.get());
      if (isEmpty(draft)) next.delete(key);
      else next.set(key, draft);
      state.set(next);
    };

    /**
     * Shows the draft of `target` as the device keeps it, after another window
     * sent or changed it, and keeps the text this window held for `restore`.
     */
    const reload = (target: EntryTarget) => {
      const key = targetKey(target);
      return storage.readAll("drafts").pipe(
        Effect.flatMap((records) => {
          const value = records.get(key);
          displaced.set(key, (state.get().get(key) ?? empty).text);
          unwritten.delete(key);
          if (value === undefined) known.delete(key);
          else known.set(key, value);
          const draft = value === undefined ? Option.none() : decodeStored(value);
          show(key, Option.isSome(draft) ? shown(draft.value) : empty);
          return PubSub.publish(changes, target);
        }),
        Effect.catchTag("LocalStorageError", (error) =>
          Effect.logWarning("A draft another window changed could not be read", error).pipe(
            Effect.andThen(
              Effect.sync(() => show(key, { ...(state.get().get(key) ?? empty), sending: false })),
            ),
          ),
        ),
      );
    };

    const writeOne = (target: EntryTarget) => {
      const key = targetKey(target);
      const record = persisted(state.get().get(key) ?? empty);
      const write = Effect.gen(function* () {
        const value =
          record.text === "" && record.files.length === 0
            ? null
            : yield* encodeStored({ revision: yield* revision, ...record });
        const claimed = yield* storage.commit(
          [{ table: "drafts", key, value }],
          [{ table: "drafts", key, value: known.get(key) ?? null }],
        );
        if (!claimed) return yield* reload(target);
        if (value === null) known.delete(key);
        else known.set(key, value);
      });
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
        const targets = [...unwritten.values()];
        unwritten.clear();
        for (const target of targets) yield* turn.withPermits(1)(writeOne(target));
      }
    }).pipe(Effect.forkIn(scope));

    /** Changes one draft at once, unless it is `sending`, and has the writer keep it. */
    const changeNow = (target: EntryTarget, update: (draft: Draft) => Draft) => {
      const key = targetKey(target);
      const before = state.get().get(key) ?? empty;
      if (before.sending) return;
      const after = update(before);
      if (after === before) return;
      show(key, after);
      unwritten.set(key, target);
      Queue.offerUnsafe(wake, void 0);
    };
    const change = (target: EntryTarget, update: (draft: Draft) => Draft) =>
      Effect.sync(() => changeNow(target, update));

    const replaceFileNow = (target: EntryTarget, fileKey: string, file: DraftFile) =>
      changeNow(target, (draft) =>
        draft.files.some((candidate) => candidate.key === fileKey)
          ? {
              ...draft,
              files: draft.files.map((candidate) => (candidate.key === fileKey ? file : candidate)),
            }
          : draft,
      );
    const replaceFile = (target: EntryTarget, fileKey: string, file: DraftFile) =>
      Effect.sync(() => replaceFileNow(target, fileKey, file));

    const withText = (text: string) => (draft: Draft) =>
      draft.text === text ? draft : { ...draft, text };

    const setText = (target: EntryTarget, text: string) => change(target, withText(text));

    const restore = (target: EntryTarget) =>
      Effect.sync(() => {
        const key = targetKey(target);
        const text = displaced.get(key);
        if (text === undefined || state.get().get(key)?.sending === true) return;
        displaced.delete(key);
        changeNow(target, withText(text));
      });

    const attach = Effect.fn("Drafts.attach")(function* (
      target: EntryTarget,
      added: ReadonlyArray<{ readonly name: string; readonly body: Blob }>,
    ) {
      const key = targetKey(target);
      if (state.get().get(key)?.sending === true) return;
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
      yield* change(target, (draft) => ({ ...draft, files: [...draft.files, ...entries] }));

      for (const [index, file] of picked.entries()) {
        if (problems[index] !== null) continue;
        const fileKey = file.key;
        const progress = (sent: number) => {
          const current = state
            .get()
            .get(key)
            ?.files.find((candidate) => candidate.key === fileKey);
          if (current?._tag !== "uploading" || current.sent === sent) return;
          replaceFileNow(target, fileKey, { ...current, sent });
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
                replaceFile(target, fileKey, { _tag: "ready", key: fileKey, attachment }),
              onFailure: (error) =>
                replaceFile(target, fileKey, {
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
        return change(target, (draft) =>
          draft.files.some((file) => file.key === fileKey)
            ? { ...draft, files: draft.files.filter((file) => file.key !== fileKey) }
            : draft,
        ).pipe(Effect.andThen(upload === undefined ? Effect.void : Fiber.interrupt(upload)));
      });

    const send = Effect.fn("Drafts.send")(function* (target: EntryTarget, mentions?: Mentions) {
      const key = targetKey(target);
      return yield* turn.withPermits(1)(
        Effect.gen(function* () {
          const draft = state.get().get(key) ?? empty;
          if (draft.files.some((file) => file._tag !== "ready")) return "not-ready";
          const text = draft.text.trim();
          const attachments = draft.files.flatMap((file) =>
            file._tag === "ready" ? [file.attachment] : [],
          );
          if (text === "" && attachments.length === 0) return "empty";
          if (text.length > MAX_MESSAGE_LENGTH) return "too-long";
          show(key, { ...draft, sending: true });
          // The outbox holds the message from here; its delivery outlives the caller.
          const kept = yield* conversations
            .enqueue(
              { target, text, attachments, ...(mentions === undefined ? {} : { mentions }) },
              [{ table: "drafts", key, value: null }],
              [{ table: "drafts", key, value: known.get(key) ?? null }],
            )
            .pipe(
              Effect.map((claimed) => (claimed ? "sent" : "changed-elsewhere")),
              Effect.catchTag("LocalStorageError", (error) =>
                Effect.logWarning("A message could not be kept; it stays in the draft", error).pipe(
                  Effect.as("not-kept" as const),
                ),
              ),
            );
          switch (kept) {
            case "sent":
              unwritten.delete(key);
              known.delete(key);
              show(key, empty);
              break;
            case "changed-elsewhere":
              yield* reload(target);
              break;
            case "not-kept":
              show(key, draft);
              break;
          }
          return kept;
        }),
      );
    });

    const discardAll = turn.withPermits(1)(
      Effect.gen(function* () {
        const running = [...uploads.values()];
        uploads.clear();
        yield* Fiber.interruptAll(running);
        unwritten.clear();
        known.clear();
        displaced.clear();
        state.set(new Map());
        yield* storage.clear("drafts");
      }),
    );

    yield* Effect.gen(function* () {
      while (true) {
        yield* waitFor(connection.state, (current) => current._tag === "unpaired");
        yield* discardAll.pipe(
          Effect.catchTag("LocalStorageError", (error) =>
            Effect.logWarning("Drafts stay in local storage", error),
          ),
        );
        yield* waitFor(connection.state, (current) => current._tag !== "unpaired");
      }
    }).pipe(Effect.forkIn(scope));

    return Drafts.of({
      state,
      setText,
      attach,
      detach,
      send,
      changedElsewhere: Stream.fromPubSub(changes),
      restore,
      discardAll,
    });
  }),
);
