// SPDX-License-Identifier: AGPL-3.0-or-later
import { Attachment, DeviceId, type EntryTarget, type Mentions } from "@j3-bots/contracts";
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
  type MessageProblem,
  normalizeMediaType,
} from "../files/limits.ts";
import { ClientStorage, type LocalRecord, type LocalStorageError } from "../ports.ts";
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
   * The operator pressed Send and `send` is moving it to the outbox, which
   * takes a few milliseconds. It takes no change meanwhile: what it holds is
   * what goes.
   */
  readonly sending: boolean;
}

const empty: Draft = { text: "", files: [], sending: false };

/** What `send` did with the draft. */
export type DraftSendResult =
  /** It is on its way, through the outbox. */
  | "sent"
  /** There was nothing to send, or it is already on its way. */
  | "empty"
  /** A file is still uploading or could not be attached. */
  | "not-ready"
  /** The message breaks a limit of `message.send`, which says which; the draft stays as it is. */
  | MessageProblem
  /** The device could not keep the message, so it stays in the draft. */
  | "not-kept"
  /**
   * Another window sent or changed the draft since this one read it. Nothing
   * was sent, and the draft now shows what the device keeps.
   */
  | "changed-elsewhere";

/** A draft another window sent or changed under this one. */
export interface DraftChangedElsewhere {
  readonly target: EntryTarget;
  /** This window was sending the draft, and sent nothing. */
  readonly whileSending: boolean;
  /**
   * This window holds text the device never kept, which `restore` puts back:
   * from this change, or from an earlier one the operator has not restored
   * or dismissed. Text the device kept, the other window had in front of it
   * when it sent or changed the draft, so there is nothing to put back.
   */
  readonly restorable: boolean;
}

/**
 * A draft as the device keeps it: the text and the files already on the
 * server, and the pairing that wrote it. Each write gives it a new
 * `revision`, so a window can tell whether the draft is still the one it
 * read. The text is kept whatever its length: the limit of a message applies
 * when it is sent. A draft emptied or sent is kept too, empty, with a
 * revision of its own, so a window that read it before still finds it
 * changed; it reads as no draft, and there is at most one record per
 * conversation.
 */
const StoredDraft = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({
      revision: Schema.String,
      pairing: DeviceId,
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

/** What the device keeps of a draft: its text and the files already on the server. */
interface Kept {
  readonly text: string;
  readonly files: ReadonlyArray<Attachment>;
}

const keptOf = (draft: Draft): Kept => ({
  text: draft.text,
  files: draft.files.flatMap((file) => (file._tag === "ready" ? [file.attachment] : [])),
});

const sameKept = (one: Kept, other: Kept) =>
  one.text === other.text &&
  one.files.length === other.files.length &&
  one.files.every((file, index) => file.id === other.files[index]?.id);

/** The draft a stored record holds: an empty one for none, `undefined` for one it cannot read. */
const keptIn = (record: string | undefined): Kept | undefined =>
  record === undefined ? keptOf(empty) : Option.getOrUndefined(decodeStored(record));

/** A draft as the device keeps it, as this window shows it. */
const shown = (kept: Kept): Draft => ({
  text: kept.text,
  files: kept.files.map((attachment) => ({ _tag: "ready", key: attachment.id, attachment })),
  sending: false,
});

/**
 * Every conversation's draft, kept on the device so a reload loses nothing:
 * its text, and the files already uploaded for it. Files upload as soon as
 * they are attached; the draft can be sent once they all have.
 *
 * One rule keeps a draft whole when several windows hold it. Every operation
 * on a draft (autosave, deletion, Send, Restore) runs under this window's
 * draft lock (one for all of its drafts) and reads its inputs, both the
 * in-memory draft and the expected stored revision, only after acquiring the
 * lock. Send commits exactly the text and files the operator pressed Send on,
 * captured at the press, or nothing. Only what is persisted is ever written:
 * upload progress and failed files live in memory only. The lock is this
 * window's own; between windows, the stored revision each write claims
 * decides.
 *
 * Text another window's change displaced stays on offer, one text per draft,
 * until the operator restores it, dismisses it or sends the draft, however
 * many changes come after. A later change that displaces no new text keeps
 * the offer. One that displaces new text replaces it: that is the text the
 * operator last saw in this window. When the device never kept the older
 * text either, it is lost, the lesser loss while the offer stays in view.
 *
 * Every draft belongs to the pairing that wrote it. When the pairing a window
 * follows ends, the window drops its drafts and erases the device's records
 * of that pairing, and only those: another window may have paired anew and
 * written its own.
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
     * second finds the draft already on its way. What goes is the draft as it
     * was at the call, or nothing. The transaction claims the draft as this
     * window last read or wrote it, so two windows never send it twice.
     */
    readonly send: (target: EntryTarget, mentions?: Mentions) => Effect.Effect<DraftSendResult>;
    /**
     * Each draft another window sent or changed while this one was changing
     * or sending it. Nothing this window held was written: it now shows the
     * draft as the device keeps it, with its own files still uploading or
     * refused, and `restore` puts back text the device never kept.
     */
    readonly changedElsewhere: Stream.Stream<DraftChangedElsewhere>;
    /**
     * The drafts, by `targetKey`, whose text another window's change displaced
     * and `restore` can put back. An offer stays until it is restored or
     * dismissed, or the draft is sent.
     */
    readonly offers: Readable<ReadonlySet<string>>;
    /**
     * Puts back the text this window held when another window changed the
     * draft, as a new change to the draft as it is now.
     */
    readonly restore: (target: EntryTarget) => Effect.Effect<void>;
    /** Lets go of the text on offer for `restore`. */
    readonly dismiss: (target: EntryTarget) => Effect.Effect<void>;
    /**
     * Stops every upload and drops every draft of this pairing, here and on
     * the device. It happens by itself whenever the pairing ends.
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

    // Each draft's stored record, by key, as this window last read or wrote it.
    const known = new Map<string, string>();
    const state = new Cell<ReadonlyMap<string, Draft>>(new Map());

    /** Shows the drafts the device keeps. Runs under the lock, or before anything else does. */
    const readStored = Effect.gen(function* () {
      const restored = new Map<string, Draft>();
      for (const [key, value] of yield* storage.readAll("drafts")) {
        // Even a record this window cannot read is the one its next write claims.
        known.set(key, value);
        const draft = Option.map(decodeStored(value), shown);
        if (Option.isSome(draft) && !isEmpty(draft.value)) restored.set(key, draft.value);
      }
      state.set(restored);
    });
    yield* readStored.pipe(
      Effect.catchTag("LocalStorageError", (error) =>
        Effect.logWarning("Drafts could not be read", error),
      ),
    );
    const uploads = new Map<string, Fiber.Fiber<void>>();
    // Text on offer for `restore`, by key: text this window held, never kept,
    // when another window changed its draft.
    const displaced = new Map<string, string>();
    const offers = new Cell<ReadonlySet<string>>(new Set());
    const offer = (key: string, text: string | null) => {
      if (text === null) displaced.delete(key);
      else displaced.set(key, text);
      offers.set(new Set(displaced.keys()));
    };
    const changes = yield* PubSub.unbounded<DraftChangedElsewhere>();
    let nextKey = 0;

    // The lock every operation on a draft holds. One guards all of this
    // window's drafts: each operation takes a few milliseconds.
    const lock = yield* Semaphore.make(1);
    const locked = lock.withPermits(1);

    // Autosave goes through one writer that writes the latest draft of each
    // key, so a burst of keystrokes costs a few writes, never a queue of them.
    // Each write claims the draft as this window last read or wrote it, as
    // `send` does: a window never writes over what another window sent or changed.
    const unwritten = new Map<string, EntryTarget>();
    const wake = yield* Queue.sliding<void>(1);
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
     * sent or changed it, with this window's files the device never kept on
     * top (uploading, refused, or uploaded since this window last wrote), as
     * far as one message can carry them: a file that no longer fits is
     * refused, and says why. Has the writer keep the files it adds. Keeps the
     * text this window held for `restore` when the device never kept it. Runs
     * under the lock.
     */
    const reload = (target: EntryTarget) => {
      const key = targetKey(target);
      return Effect.gen(function* () {
        const value = (yield* storage.readAll("drafts")).get(key);
        const held = state.get().get(key) ?? empty;
        const read = keptIn(known.get(key)) ?? keptOf(empty);
        const stored = shown(keptIn(value) ?? keptOf(empty));
        // Text the device never kept, which this window shows no more.
        if (held.text !== "" && held.text !== stored.text && held.text !== read.text) {
          offer(key, held.text);
        }
        const restorable = displaced.has(key);
        if (value === undefined) known.delete(key);
        else known.set(key, value);

        // A file the device kept and no longer keeps, another window took out.
        const keptBefore = new Set([...read.files, ...keptOf(stored).files].map((file) => file.id));
        const own = held.files.filter(
          (file) => file._tag !== "ready" || !keptBefore.has(file.attachment.id),
        );
        const admissible = own.filter((file) => file._tag !== "failed");
        const problems = admitFiles(stored.files.map(localFileOf), admissible.map(localFileOf));
        const refused = new Map<string, FileProblem>();
        for (const [index, file] of admissible.entries()) {
          const problem = problems[index] ?? null;
          if (problem !== null) refused.set(file.key, problem);
        }
        const draft: Draft = {
          ...stored,
          files: [
            ...stored.files,
            ...own.map((file): DraftFile => {
              const problem = refused.get(file.key);
              if (problem === undefined) return file;
              const { name, mediaType, size } = localFileOf(file);
              return { _tag: "failed", key: file.key, problem, name, mediaType, size };
            }),
          ],
        };
        // What is left to write is settled before the draft shows: whoever sees
        // it may change it at once.
        if (sameKept(keptOf(draft), keptOf(stored))) unwritten.delete(key);
        else unwritten.set(key, target);
        show(key, draft);
        if (unwritten.has(key)) Queue.offerUnsafe(wake, void 0);
        const stopped = [...refused.keys()].flatMap((fileKey) => {
          const upload = uploads.get(fileKey);
          uploads.delete(fileKey);
          return upload === undefined ? [] : [upload];
        });
        yield* Fiber.interruptAll(stopped);
        yield* PubSub.publish(changes, { target, whileSending: held.sending, restorable });
      }).pipe(
        Effect.catchTag("LocalStorageError", (error) =>
          Effect.logWarning("A draft another window changed could not be read", error).pipe(
            Effect.andThen(
              Effect.sync(() => show(key, { ...(state.get().get(key) ?? empty), sending: false })),
            ),
          ),
        ),
      );
    };

    /**
     * Writes the draft of `target` as it is now, as `pairing`'s, unless the
     * device keeps it so already. Runs under the lock.
     */
    const writeOne = Effect.fn("Drafts.write")(
      function* (target: EntryTarget, pairing: DeviceId) {
        const key = targetKey(target);
        const record = keptOf(state.get().get(key) ?? empty);
        const expected = known.get(key);
        const stored = keptIn(expected);
        if (stored !== undefined && sameKept(record, stored)) return;
        const value = yield* encodeStored({ revision: yield* revision, pairing, ...record });
        const claimed = yield* storage.commit(
          [{ table: "drafts", key, value }],
          [{ table: "drafts", key, value: expected ?? null }],
        );
        if (!claimed) return yield* reload(target);
        known.set(key, value);
      },
      Effect.catchTags({
        LocalStorageError: (error) => Effect.logWarning("A draft is kept in memory only", error),
        SchemaError: (error) => Effect.logError("A draft could not be encoded", error),
      }),
    );
    yield* Effect.gen(function* () {
      while (true) {
        yield* Queue.take(wake);
        const targets = [...unwritten.values()];
        unwritten.clear();
        // Without a pairing, nothing is kept: no window could send it.
        const pairing = yield* connection.deviceId.pipe(Effect.option);
        if (Option.isNone(pairing)) continue;
        for (const target of targets) yield* locked(writeOne(target, pairing.value));
      }
    }).pipe(Effect.forkIn(scope));

    /**
     * Changes one draft in memory at once, unless it is `sending`, and has the
     * writer keep it when what the device keeps of it changed.
     */
    const changeNow = (target: EntryTarget, update: (draft: Draft) => Draft) => {
      const key = targetKey(target);
      const before = state.get().get(key) ?? empty;
      if (before.sending) return;
      const after = update(before);
      if (after === before) return;
      show(key, after);
      if (sameKept(keptOf(before), keptOf(after))) return;
      unwritten.set(key, target);
      Queue.offerUnsafe(wake, void 0);
    };
    const change = (target: EntryTarget, update: (draft: Draft) => Draft) =>
      Effect.sync(() => changeNow(target, update));

    /** Replaces the file `fileKey` with `file` while it uploads: once it has stopped, the upload has no say. */
    const replaceFileNow = (target: EntryTarget, fileKey: string, file: DraftFile) =>
      changeNow(target, (draft) =>
        draft.files.some((candidate) => candidate.key === fileKey && candidate._tag === "uploading")
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
      locked(
        Effect.sync(() => {
          const key = targetKey(target);
          const text = displaced.get(key);
          if (text === undefined || state.get().get(key)?.sending === true) return;
          offer(key, null);
          changeNow(target, withText(text));
        }),
      );

    const dismiss = (target: EntryTarget) =>
      locked(Effect.sync(() => offer(targetKey(target), null)));

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
      // What the operator pressed Send on, captured at the press.
      const draft = state.get().get(key) ?? empty;
      if (draft.sending) return "empty";
      if (draft.files.some((file) => file._tag !== "ready")) return "not-ready";
      const text = draft.text.trim();
      const { files: attachments } = keptOf(draft);
      if (text === "" && attachments.length === 0) return "empty";
      const pressed: Draft = { ...draft, sending: true };
      show(key, pressed);
      const pairing = yield* connection.deviceId.pipe(Effect.option);
      return yield* locked(
        Effect.gen(function* () {
          // A sending draft takes no change, so only another window's change
          // replaces it, and the notice of that change says why nothing went.
          if (state.get().get(key) !== pressed) return "changed-elsewhere";
          // Without a pairing, the device keeps no message.
          if (Option.isNone(pairing)) {
            show(key, draft);
            return "not-kept";
          }
          // The draft is left empty with a revision of its own; nothing can fail to encode.
          const handedOver = yield* encodeStored({
            revision: yield* revision,
            pairing: pairing.value,
            ...keptOf(empty),
          }).pipe(Effect.orDie);
          // The outbox holds the message from here; its delivery outlives the caller.
          const kept = yield* conversations
            .enqueue(
              { target, text, attachments, ...(mentions === undefined ? {} : { mentions }) },
              [{ table: "drafts", key, value: handedOver }],
              [{ table: "drafts", key, value: known.get(key) ?? null }],
            )
            .pipe(
              Effect.map((claimed) => (claimed ? "sent" : "changed-elsewhere")),
              Effect.catchTags({
                LocalStorageError: (error) =>
                  Effect.logWarning(
                    "A message could not be kept; it stays in the draft",
                    error,
                  ).pipe(Effect.as("not-kept" as const)),
                // The pairing ended while Send ran.
                NotPaired: () => Effect.succeed("not-kept" as const),
                InvalidMessage: (error) => Effect.succeed(error.problem),
              }),
            );
          switch (kept) {
            case "sent":
              unwritten.delete(key);
              offer(key, null);
              known.set(key, handedOver);
              show(key, empty);
              break;
            case "changed-elsewhere":
              yield* reload(target);
              break;
            default:
              // Not kept, or over a limit of a message: it stays as it was.
              show(key, draft);
          }
          return kept;
        }),
      );
    });

    /** Stops every upload and drops every draft this window holds. Runs under the lock. */
    const dropAll = Effect.gen(function* () {
      const running = [...uploads.values()];
      uploads.clear();
      yield* Fiber.interruptAll(running);
      unwritten.clear();
      known.clear();
      displaced.clear();
      offers.set(new Set());
      state.set(new Map());
    });

    /**
     * Erases the device's drafts of `pairing`, each claimed as read, so a
     * record another window wrote meanwhile stays. Runs under the lock.
     */
    const erase = Effect.fn("Drafts.erase")(function* (pairing: DeviceId) {
      while (true) {
        const owned = [...(yield* storage.readAll("drafts"))].flatMap(
          ([key, value]): ReadonlyArray<LocalRecord> =>
            Option.exists(decodeStored(value), (draft) => draft.pairing === pairing)
              ? [{ table: "drafts", key, value }]
              : [],
        );
        if (owned.length === 0) return;
        const erased = yield* storage.commit(
          owned.map((record) => ({ ...record, value: null })),
          owned,
        );
        if (erased) return;
      }
    });

    const discardAll = locked(
      Effect.gen(function* () {
        yield* dropAll;
        const pairing = connection.pairing.get();
        if (pairing !== null) yield* erase(pairing);
      }),
    );

    // When the pairing this window follows ends, its drafts go, here and on
    // the device, and those another window kept since show.
    yield* Effect.gen(function* () {
      let followed = connection.pairing.get();
      while (true) {
        const next = yield* waitFor(connection.pairing, (current) => current !== followed);
        const ended = followed;
        followed = next;
        if (ended === null) continue;
        yield* locked(
          Effect.gen(function* () {
            yield* dropAll;
            yield* erase(ended);
            if (next !== null) yield* readStored;
          }),
        ).pipe(
          Effect.catchTag("LocalStorageError", (error) =>
            Effect.logWarning("Drafts of a pairing that ended stay in local storage", error),
          ),
        );
      }
    }).pipe(Effect.forkIn(scope));

    return Drafts.of({
      state,
      setText,
      attach,
      detach,
      send,
      changedElsewhere: Stream.fromPubSub(changes),
      offers,
      restore,
      dismiss,
      discardAll,
    });
  }),
);
