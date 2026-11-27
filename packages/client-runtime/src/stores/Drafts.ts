// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Attachment,
  BotId,
  type ConversationMention,
  DeviceId,
  type EntryTarget,
  type LookingAt,
  type Mentions,
  MessageQuote,
  NonNegativeInt,
  RECORDING_MEDIA_TYPE,
  RoomId,
} from "@j3-bots/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Base64Url from "effect/encoding/Base64Url";
import { backoffDelay, Connection, NotPaired, ReconnectPolicy } from "../connection/Connection.ts";
import { transferDeadline } from "../connection/http.ts";
import { Files, type RecordingSource, type UploadRefused, uploadProblem } from "../files/Files.ts";
import {
  admitFiles,
  type FileProblem,
  type LocalFile,
  type MessageProblem,
  normalizeMediaType,
} from "../files/limits.ts";
import { fittedMarks, insertMarks, placedMessage, withoutMarks } from "../files/placed.ts";
import { ClientStorage, type LocalRecord, type LocalStorageError } from "../ports.ts";
import { Cell, type Readable, waitFor } from "../Store.ts";
import { sameQuotes, withQuote } from "../presentation/quotes.ts";
import { Conversations, keyTarget, type MentionLabel, targetKey } from "./Conversations.ts";
import { UsageData } from "./UsageData.ts";

/**
 * A file in the composer, from the moment the operator picks it. A screen
 * recording whose voice is being written down first is `uploading` with
 * `transcribing`, the share of it done, from 0 to 1; its upload starts once
 * that is over.
 */
export type DraftFile =
  | ({
      readonly _tag: "uploading";
      readonly key: string;
      readonly sent: number;
      readonly transcribing?: number;
    } & LocalFile)
  | {
      readonly _tag: "ready";
      readonly key: string;
      readonly attachment: Attachment;
      /** A screen recording, whose cap is `MAX_RECORDING_SIZE` (`LocalFile.recording`). */
      readonly recording?: true;
    }
  | ({ readonly _tag: "failed"; readonly key: string; readonly problem: FileProblem } & LocalFile);

/**
 * A screen recording the operator adds to a draft (decision 0098): a zip on
 * the device, which it uploads a piece at a time.
 */
export interface DraftRecording extends RecordingSource {
  /**
   * Called once the runtime no longer needs the file: when the server holds
   * it, or when it leaves the draft, removed or dropped. Called at most once;
   * not when the upload fails, since a failed file stays in the draft until
   * the operator removes it, nor when a draft did not take it or the client
   * closed with it uploading, since the device can offer it again.
   */
  readonly release: () => void;
  /**
   * Writes down the recording's voice before it uploads, telling `progress`
   * the share done (`transcript.ts`): answers the zip's size once it holds
   * its transcript, or once it is settled that it goes without. Absent when
   * there is nothing to write down.
   */
  readonly transcribe?: (progress: (done: number) => void) => Effect.Effect<number, UploadRefused>;
}

/**
 * A mention the operator picked in a draft: what it names, and where its
 * token (`@` and the label) starts in the text. Only a pick makes one; text
 * that merely reads like a mention is none. Whether it still stands when the
 * draft is sent is the client's to judge from the text.
 */
export const DraftMention = Schema.Union([
  /** One bot, by id, written as `@` and the name it had when picked. */
  Schema.TaggedStruct("bot", { botId: BotId, label: Schema.String, position: NonNegativeInt }),
  /** In a room, every member, written `@everyone`. */
  Schema.TaggedStruct("everyone", { position: NonNegativeInt }),
  /** In a bot's conversation, a room, by id, written as `@` and the name it had when picked. */
  Schema.TaggedStruct("room", { roomId: RoomId, label: Schema.String, position: NonNegativeInt }),
]);
export type DraftMention = typeof DraftMention.Type;

/** What the operator is writing to one conversation or room, and has not sent. */
export interface Draft {
  /**
   * The text, with a `FILE_MARK` where each file stands, one for each of
   * `files`, in their order.
   */
  readonly text: string;
  /** The mentions picked in `text`, in no particular order. */
  readonly mentions: ReadonlyArray<DraftMention>;
  /**
   * The messages it quotes, as the sent message will (decision 0094): a
   * reply first, when there is one, then passages in the order added.
   */
  readonly quotes: ReadonlyArray<MessageQuote>;
  readonly files: ReadonlyArray<DraftFile>;
  /**
   * The operator pressed Send and `send` is moving it to the outbox, which
   * takes a few milliseconds. It takes no change meanwhile: what it holds is
   * what goes.
   */
  readonly sending: boolean;
}

const empty: Draft = { text: "", mentions: [], quotes: [], files: [], sending: false };

/**
 * Whom a message is for, as the client judged it from the mentions standing
 * in the draft: in a room, whom `message.send` asks; in a bot's conversation,
 * the bots and rooms it mentions. With it, the names they were picked by
 * where those picks stand, the first for each being the pick that named it.
 */
export type Addressing =
  | { readonly mentions: Mentions; readonly labels: ReadonlyArray<MentionLabel> }
  | {
      readonly conversationMentions: ReadonlyArray<ConversationMention>;
      readonly labels: ReadonlyArray<MentionLabel>;
    };

/**
 * What quick access sends beside a draft, as its chips showed it at Send:
 * the window the operator was looking at, and a picture of that window,
 * which uploads only then and goes after the draft's files.
 */
export interface WindowContext {
  readonly lookingAt?: LookingAt;
  readonly picture?: { readonly name: string; readonly body: Blob };
}

/** What `send` did with the draft. */
export type DraftSendResult =
  /** It is on its way, through the outbox. */
  | "sent"
  /** There was nothing to send, or it is already on its way. */
  | "empty"
  /** A file is still uploading or could not be attached, or the drafts could not be read. */
  | "not-ready"
  /** The message breaks a limit of `message.send`, which says which; the draft stays as it is. */
  | MessageProblem
  /**
   * The picture of `WindowContext` could not go with the message: it would
   * break a limit of the message, or did not upload. Nothing was sent.
   */
  | "picture-failed"
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
   * This change displaced text this window held that the device never kept,
   * which `restore` now puts back. Text the device kept, the other window had
   * in front of it when it sent or changed the draft, so there is nothing to
   * put back. Without new text, an earlier offer stays as it was.
   */
  readonly displaced: boolean;
}

/**
 * A draft as the device keeps it: the text, the mentions picked in it, the
 * files already on the server, each placed in the text by its mark, and the
 * pairing that wrote it. Each write gives it a new
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
      mentions: Schema.Array(DraftMention),
      /** Left out by a version that predates quotes, which kept none. */
      quotes: Schema.optionalKey(Schema.Array(MessageQuote)),
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
        ...(file.recording === true ? { recording: true } : {}),
      }
    : file;

/**
 * The files `draft` holds toward its message, uploaded or uploading: those a
 * file added to it is admitted against (`admitFiles`). A failed file holds
 * no place.
 */
const heldFiles = (draft: Draft | undefined): ReadonlyArray<LocalFile> =>
  (draft?.files ?? []).filter((file) => file._tag !== "failed").map(localFileOf);

const isEmpty = (draft: Draft) =>
  draft.text === "" && draft.files.length === 0 && draft.quotes.length === 0;

/**
 * What the device keeps of a draft: its text, its mentions, its quotes and
 * the files already on the server.
 */
interface Kept {
  readonly text: string;
  readonly mentions: ReadonlyArray<DraftMention>;
  readonly quotes: ReadonlyArray<MessageQuote>;
  readonly files: ReadonlyArray<Attachment>;
}

/** What the device keeps of a draft: only the uploaded files, and the marks that place them. */
const keptOf = (draft: Draft): Kept => ({
  ...withoutMarks(draft, (index) => draft.files[index]?._tag !== "ready"),
  quotes: draft.quotes,
  files: draft.files.flatMap((file) => (file._tag === "ready" ? [file.attachment] : [])),
});

const sameMention = (one: DraftMention, other: DraftMention) => {
  if (one.position !== other.position) return false;
  switch (one._tag) {
    case "bot":
      return other._tag === "bot" && one.botId === other.botId && one.label === other.label;
    case "room":
      return other._tag === "room" && one.roomId === other.roomId && one.label === other.label;
    case "everyone":
      return other._tag === "everyone";
  }
};

/** Whether two drafts hold the same writing: the same text, with the same mentions picked in it. */
const sameWriting = (
  one: Pick<Kept, "text" | "mentions">,
  other: Pick<Kept, "text" | "mentions">,
) =>
  one.text === other.text &&
  one.mentions.length === other.mentions.length &&
  one.mentions.every((mention) => other.mentions.some((picked) => sameMention(mention, picked)));

/**
 * The writing of `draft` without its files' marks: what another window can
 * displace. Its files are never displaced, as this window's own files stay on
 * top of what another window kept.
 */
const writingOf = (draft: Pick<Kept, "text" | "mentions">) => withoutMarks(draft, () => true);

const sameKept = (one: Kept, other: Kept) =>
  sameWriting(one, other) &&
  sameQuotes(one.quotes, other.quotes) &&
  one.files.length === other.files.length &&
  one.files.every((file, index) => file.id === other.files[index]?.id);

/**
 * The draft of `pairing` a stored record holds: an empty one for none, or for
 * another pairing's record, which no window following `pairing` shows, keeps
 * or sends; `undefined` for one it cannot read.
 */
const keptIn = (record: string | undefined, pairing: DeviceId): Kept | undefined => {
  if (record === undefined) return keptOf(empty);
  const decoded = Option.getOrUndefined(decodeStored(record));
  if (decoded === undefined) return undefined;
  if (decoded.pairing !== pairing) return keptOf(empty);
  return {
    text: decoded.text,
    mentions: decoded.mentions,
    quotes: decoded.quotes ?? [],
    files: decoded.files,
  };
};

/** A draft as the device keeps it, as this window shows it, its text placing each of its files. */
const shown = (kept: Kept): Draft => ({
  ...fittedMarks(kept, kept.files.length),
  quotes: kept.quotes,
  files: kept.files.map((attachment) => ({ _tag: "ready", key: attachment.id, attachment })),
  sending: false,
});

/**
 * Every conversation's draft, kept on the device so a reload loses nothing:
 * its text, and the files already uploaded for it. Files upload as soon as
 * they are attached, each for the pairing that took it and with its
 * credential, and stop when that pairing ends; the draft can be sent once
 * they all have.
 *
 * A draft the device could not keep, or that another window changed and the
 * device could not be read for, is `notSaved`: this window holds it in memory
 * only, as it is, and tries again, after a pause that grows with each
 * failure, under the same checks as every write, until the device keeps it or
 * shows what another window kept instead.
 *
 * Every window of the device holds the same drafts: a window shows what
 * another kept as soon as the device says it changed.
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
 * Every draft belongs to the pairing that wrote it, and a window only ever
 * shows, keeps or sends the drafts of the pairing it follows. The drafts hold
 * that pairing of their own, which changes only under the lock, after the
 * window dropped every draft it held: every read shows only that pairing's
 * records, every write is that pairing's, and the storage transaction that
 * writes it checks that the device's credential is still that pairing's. A
 * window that learns late that its pairing ended therefore writes nothing,
 * and another pairing's record, which no erasing removed, is never shown.
 *
 * When the pairing a window follows changes, from none, to none or to
 * another, the window drops its drafts, erases the device's records of the
 * pairing that ended, and only those, then reads those of the pairing it
 * follows now; until it has, the drafts take no change. Nothing of the
 * pairing that ended shows from the moment the pairing changes, though a
 * write of it may still hold the lock. Erasing is cleanup: when it fails,
 * nothing of that pairing shows anyway. Reading is not: drafts that could not
 * be read take no change until they are. At launch, the drafts of every
 * pairing the device no longer holds go: a window can close before it erased
 * them.
 */
export class Drafts extends Context.Service<
  Drafts,
  {
    /** Drafts by `targetKey`. A target with no entry has an empty draft. */
    readonly state: Readable<ReadonlyMap<string, Draft>>;
    /**
     * Changes the draft's text, with the mentions picked in it (none when left
     * out), unless it is `sending`. `order` names, by key, the files the
     * text's marks place, in order, as a field that draws them tells it: a
     * file it leaves out is taken out, its upload stopped. Without it the
     * files stay, and the text is made to place them all.
     */
    readonly setText: (
      target: EntryTarget,
      text: string,
      mentions?: ReadonlyArray<DraftMention>,
      order?: ReadonlyArray<string>,
    ) => Effect.Effect<void>;
    /**
     * Adds files to the draft, placed together at `at` in its text, or after
     * it, and uploads each the contract's limits allow. A file that breaks
     * one stays in the draft as `failed`, saying which. A draft that is
     * `sending` takes no files.
     */
    readonly attach: (
      target: EntryTarget,
      files: ReadonlyArray<{ readonly name: string; readonly body: Blob }>,
      at?: number,
    ) => Effect.Effect<void>;
    /**
     * Adds a screen recording to the draft, placed at `at` in its text or
     * after it, and uploads it in resumable pieces (`Files.uploadRecording`),
     * admitted against `MAX_RECORDING_SIZE`. Only a server that carries
     * `screenRecordings` takes one. It shows as `failed` when it breaks a
     * limit or its upload fails for good. It waits until the draft can take
     * a file: its drafts read, and no send under way. `false` when the
     * draft did not take it, as once this window follows another pairing:
     * the recording is left as it was.
     */
    readonly attachRecording: (
      target: EntryTarget,
      recording: DraftRecording,
      at?: number,
    ) => Effect.Effect<boolean>;
    /** Takes a file out of the draft, stopping its upload. */
    readonly detach: (target: EntryTarget, key: string) => Effect.Effect<void>;
    /**
     * Adds a quote to the draft (decision 0094): a reply takes the place of
     * the draft's reply, first; a passage goes last, once. Succeeds with
     * `full` and changes nothing when the draft quotes all a message can,
     * and with `not-now` while it is `sending`.
     */
    readonly quote: (
      target: EntryTarget,
      quote: MessageQuote,
    ) => Effect.Effect<"added" | "full" | "not-now">;
    /** Takes the quote at `index` out of the draft. */
    readonly unquote: (target: EntryTarget, index: number) => Effect.Effect<void>;
    /**
     * Moves the draft to the outbox in one storage transaction, so a crash
     * leaves it in exactly one of them, and sending twice sends once: the
     * second finds the draft already on its way. What goes is the draft as it
     * was at the call, or nothing. The transaction claims the draft as this
     * window last read or wrote it, so two windows never send it twice.
     * Without `addressing` the message mentions nobody. `context` is what
     * goes beside the draft: it is waited for once the draft is held as on
     * its way, so nothing typed meanwhile goes with it, and it is never kept
     * with the draft.
     */
    readonly send: (
      target: EntryTarget,
      addressing?: Addressing,
      context?: Effect.Effect<WindowContext | undefined>,
    ) => Effect.Effect<DraftSendResult>;
    /**
     * Each draft another window sent or changed while this one was changing
     * or sending it. Nothing this window held was written: it now shows the
     * draft as the device keeps it, with its own files still uploading or
     * refused, and `restore` puts back text the device never kept.
     */
    readonly changedElsewhere: Stream.Stream<DraftChangedElsewhere>;
    /**
     * The drafts, by `targetKey`, whose text another window's change displaced
     * and `restore` can put back, each with the revision of its offer, which
     * grows whenever new text is displaced. An offer stays until it is
     * restored or dismissed, or the draft is sent.
     */
    readonly offers: Readable<ReadonlyMap<string, number>>;
    /**
     * This window does not hold the drafts of the pairing it follows yet: it
     * is dropping those of a pairing that ended, or reading those of the
     * pairing it follows now. The drafts take no change meanwhile.
     */
    readonly switching: Readable<boolean>;
    /**
     * The drafts of the pairing this window follows could not be read, so
     * none shows. They take no change until `retryRead` reads them: an empty
     * draft that takes text would hide one the device keeps.
     */
    readonly readFailed: Readable<boolean>;
    /** Reads the drafts again after `readFailed`: succeeds with whether they are read now. */
    readonly retryRead: Effect.Effect<boolean>;
    /**
     * The drafts, by `targetKey`, the device could not keep as they show
     * here: they are in memory only until a later attempt keeps them.
     */
    readonly notSaved: Readable<ReadonlySet<string>>;
    /**
     * Whether a change made here is not kept on the device yet: waiting for
     * the writer, being written, or to be tried again. A file shows uploaded
     * before the device keeps it in its draft.
     */
    readonly saving: Readable<boolean>;
    /**
     * Puts back the text this window held when another window changed the
     * draft, as a new change to the draft as it is now. The draft's files
     * stay, placed after the text put back.
     */
    readonly restore: (target: EntryTarget) => Effect.Effect<void>;
    /** Lets go of the text on offer for `restore`. */
    readonly dismiss: (target: EntryTarget) => Effect.Effect<void>;
    /**
     * Erases every draft of `pairing` on the device, and, while this window
     * still follows it, stops every upload and drops every draft here. It
     * happens by itself whenever the pairing ends.
     */
    readonly discardAll: (pairing: DeviceId | null) => Effect.Effect<void, LocalStorageError>;
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
    const policy = yield* ReconnectPolicy;
    const usageData = yield* UsageData;
    const scope = yield* Scope.Scope;

    // Each draft's stored record, by key, as this window last read or wrote it.
    const known = new Map<string, string>();
    const state = new Cell<ReadonlyMap<string, Draft>>(new Map());

    /**
     * Erases the device's drafts of the pairings `ended` names, each claimed
     * as read, so a record another window wrote meanwhile stays. `ended` is
     * asked after each read of the drafts. Runs under the lock, or before
     * anything else does.
     */
    const eraseWhere = Effect.fn("Drafts.eraseWhere")(function* <E>(
      ended: Effect.Effect<(pairing: DeviceId) => boolean, E>,
    ) {
      while (true) {
        const records = yield* storage.readAll("drafts");
        const isEnded = yield* ended;
        const owned = [...records].flatMap(([key, value]): ReadonlyArray<LocalRecord> =>
          Option.exists(decodeStored(value), (draft) => isEnded(draft.pairing))
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
    const erase = (pairing: DeviceId) =>
      eraseWhere(Effect.succeed((owner: DeviceId) => owner === pairing));

    // A window can close after its pairing ended and before it erased that
    // pairing's drafts. They go before anything shows them. The credential is
    // read after the drafts: a draft was written after its pairing was saved,
    // so one whose pairing the device no longer holds belongs to a pairing
    // that ended.
    yield* eraseWhere(
      Effect.map(connection.storedPairing, (stored) => (owner: DeviceId) => owner !== stored),
    ).pipe(
      Effect.catchTags({
        LocalStorageError: (error) =>
          Effect.logWarning("Drafts of a pairing that ended stay in local storage", error),
        CredentialStorageError: (error) =>
          Effect.logWarning("Drafts are kept: the device's pairing could not be read", error),
      }),
    );

    /**
     * The pairing whose drafts this window holds, or null for none. It
     * changes only under the lock, once every draft this window held is dropped.
     */
    const followed = new Cell<DeviceId | null>(connection.pairing.get());
    /**
     * `source` as the operator sees it: while the pairing this window follows
     * is not the one whose drafts it holds, it reads as `none`, from the
     * moment the pairing changes. Dropping the drafts waits for the lock,
     * which a write of the pairing that ended may hold; nothing of that
     * pairing shows meanwhile.
     */
    const visible = <A>(source: Readable<A>, none: A): Readable<A> => ({
      get: () => (connection.pairing.get() === followed.get() ? source.get() : none),
      subscribe: (listener) => {
        const stops = [source, connection.pairing, followed].map((readable) =>
          readable.subscribe(listener),
        );
        return () => {
          for (const stop of stops) stop();
        };
      },
    });
    const noDrafts: ReadonlyMap<string, Draft> = new Map();
    const noOffers: ReadonlyMap<string, number> = new Map();
    const noKeys: ReadonlySet<string> = new Set();

    /**
     * Shows the drafts of `pairing` the device keeps. Runs under the lock, or
     * before anything else does.
     */
    const readStored = Effect.fn("Drafts.readStored")(function* (pairing: DeviceId) {
      const restored = new Map<string, Draft>();
      for (const [key, value] of yield* storage.readAll("drafts")) {
        // Even a record this window does not show is the one its next write claims.
        known.set(key, value);
        const kept = keptIn(value, pairing);
        const draft = kept === undefined ? empty : shown(kept);
        if (!isEmpty(draft)) restored.set(key, draft);
      }
      state.set(restored);
    });
    // The drafts of the pairing followed could not be read.
    const unread = new Cell(false);
    /**
     * Shows the drafts of `pairing`, or notes that they could not be read.
     * Runs under the lock, or before anything else does.
     */
    const load = (pairing: DeviceId) =>
      readStored(pairing).pipe(
        Effect.andThen(Effect.sync(() => unread.set(false))),
        Effect.catchTag("LocalStorageError", (error) =>
          Effect.logWarning("Drafts could not be read", error).pipe(
            Effect.andThen(Effect.sync(() => unread.set(true))),
          ),
        ),
      );
    // The drafts of the pairing this window starts with show before anything else runs.
    const first = followed.get();
    if (first !== null) yield* load(first);

    const uploads = new Map<string, Fiber.Fiber<void>>();
    // What each recording in a draft lets go of once it is no longer needed, by file key.
    const releases = new Map<string, () => void>();
    const release = (fileKey: string) => {
      const letGo = releases.get(fileKey);
      if (letGo === undefined) return;
      releases.delete(fileKey);
      letGo();
    };
    /** Lets go of each recording no draft holds any more, however it left. */
    const releaseDropped = () => {
      if (releases.size === 0) return;
      const held = new Set(
        [...state.get().values()].flatMap((draft) => draft.files.map((file) => file.key)),
      );
      for (const fileKey of releases.keys()) if (!held.has(fileKey)) release(fileKey);
    };
    const unsubscribeReleases = state.subscribe(releaseDropped);
    // Closing lets go of nothing: a recording still uploading is the
    // device's to offer again.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribeReleases();
        releases.clear();
      }),
    );
    // Text on offer for `restore`, by key: text this window held, never kept,
    // when another window changed its draft, with the revision of the offer.
    const displaced = new Map<
      string,
      {
        readonly text: string;
        readonly mentions: ReadonlyArray<DraftMention>;
        readonly revision: number;
      }
    >();
    let offerRevision = 0;
    const offers = new Cell<ReadonlyMap<string, number>>(new Map());
    const offer = (key: string, held: Pick<Draft, "text" | "mentions"> | null) => {
      if (held === null) displaced.delete(key);
      else
        displaced.set(key, { text: held.text, mentions: held.mentions, revision: ++offerRevision });
      offers.set(new Map([...displaced].map(([offered, { revision }]) => [offered, revision])));
    };
    // Reading the drafts of the pairing this window follows now.
    let loading = false;
    const switching = new Cell(false);
    // Set as soon as the pairing changes, so no change slips in before the
    // drafts are dropped.
    const settle = () => switching.set(loading || connection.pairing.get() !== followed.get());
    const unsubscribe = connection.pairing.subscribe(settle);
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
    const changes = yield* PubSub.unbounded<DraftChangedElsewhere>();
    let nextKey = 0;

    // The lock every operation on a draft holds. One guards all of this
    // window's drafts: each operation takes a few milliseconds.
    const lock = yield* Semaphore.make(1);
    const locked = lock.withPermits(1);

    /** The drafts take no change: those of the pairing followed are not read yet, or could not be. */
    const closed = () => switching.get() || unread.get();

    // Autosave goes through one writer that writes the latest draft of each
    // key, so a burst of keystrokes costs a few writes, never a queue of them.
    // Each write claims the draft as this window last read or wrote it, as
    // `send` does: a window never writes over what another window sent or changed.
    const queued = new Map<string, EntryTarget>();
    // The writer is writing the drafts it last took.
    let writing = false;
    // A change made here is not kept yet: queued, being written, or to be tried again.
    const saving = new Cell(false);
    const settleSaving = () => saving.set(writing || queued.size > 0);
    /** The drafts the writer has yet to write, by key. Every change to them settles `saving`. */
    const unwritten = {
      has: (key: string) => queued.has(key),
      set: (key: string, target: EntryTarget) => {
        queued.set(key, target);
        settleSaving();
      },
      delete: (key: string) => {
        queued.delete(key);
        settleSaving();
      },
      clear: () => {
        queued.clear();
        settleSaving();
      },
      /** Hands the writer every draft to write; it is writing them until `written`. */
      take: (): ReadonlyArray<EntryTarget> => {
        const targets = [...queued.values()];
        queued.clear();
        writing = true;
        settleSaving();
        return targets;
      },
      written: () => {
        writing = false;
        settleSaving();
      },
    };
    const wake = yield* Queue.sliding<void>(1);
    // The drafts the device could not keep as they show here.
    const unsaved = new Cell<ReadonlySet<string>>(new Set());
    const markSaved = (key: string, saved: boolean) => {
      if (unsaved.get().has(key) !== saved) return;
      const next = new Set(unsaved.get());
      if (saved) next.delete(key);
      else next.add(key);
      unsaved.set(next);
    };
    // The drafts another window changed whose stored record could not be
    // read: the writer reads it again before it writes anything of them.
    const stale = new Set<string>();
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
     * text this window held for `restore` when the device never kept it. Only
     * a record of `pairing`, the pairing this window follows, is shown or
     * offered. Succeeds with whether it could read the draft: when it could
     * not, the draft stays as this window holds it, not saved, and the writer
     * reads it again. Runs under the lock.
     */
    const reload = (target: EntryTarget, pairing: DeviceId) => {
      const key = targetKey(target);
      return Effect.gen(function* () {
        const value = (yield* storage.readAll("drafts")).get(key);
        const held = state.get().get(key) ?? empty;
        const read = keptIn(known.get(key), pairing) ?? keptOf(empty);
        const stored = shown(keptIn(value, pairing) ?? keptOf(empty));
        // Writing the device never kept, which this window shows no more: the
        // same text with other mentions picked in it is other writing.
        const heldWriting = writingOf(held);
        const offered =
          heldWriting.text !== "" &&
          !sameWriting(heldWriting, writingOf(stored)) &&
          !sameWriting(heldWriting, writingOf(read));
        if (offered) offer(key, heldWriting);
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
        const merged = [
          ...stored.files,
          ...own.map((file): DraftFile => {
            const problem = refused.get(file.key);
            if (problem === undefined) return file;
            const { name, mediaType, size } = localFileOf(file);
            return { _tag: "failed", key: file.key, problem, name, mediaType, size };
          }),
        ];
        // This window's own files follow the text another window kept.
        const draft: Draft = { ...stored, ...fittedMarks(stored, merged.length), files: merged };
        // What is left to write is settled before the draft shows: whoever sees
        // it may change it at once.
        stale.delete(key);
        if (sameKept(keptOf(draft), keptOf(stored))) {
          unwritten.delete(key);
          markSaved(key, true);
        } else unwritten.set(key, target);
        show(key, draft);
        if (unwritten.has(key)) Queue.offerUnsafe(wake, void 0);
        const stopped = [...refused.keys()].flatMap((fileKey) => {
          const upload = uploads.get(fileKey);
          uploads.delete(fileKey);
          return upload === undefined ? [] : [upload];
        });
        yield* Fiber.interruptAll(stopped);
        yield* PubSub.publish(changes, { target, whileSending: held.sending, displaced: offered });
        return true;
      }).pipe(
        Effect.catchTag("LocalStorageError", (error) =>
          Effect.logWarning("A draft another window changed could not be read", error).pipe(
            Effect.andThen(
              Effect.sync(() => {
                show(key, { ...(state.get().get(key) ?? empty), sending: false });
                stale.add(key);
                unwritten.set(key, target);
                markSaved(key, false);
                Queue.offerUnsafe(wake, void 0);
                return false;
              }),
            ),
          ),
        ),
      );
    };

    /**
     * Writes the draft of `target` as it is now, as `pairing`'s, unless the
     * device keeps it so already, and only while the device's credential is
     * `pairing`'s; reads it first when another window changed it and it could
     * not be read. Succeeds with whether the device keeps what this window
     * shows, or shows what another window kept instead. Runs under the lock.
     */
    const writeOne = Effect.fn("Drafts.write")(
      function* (target: EntryTarget, pairing: DeviceId) {
        const key = targetKey(target);
        if (stale.has(key)) return yield* reload(target, pairing);
        const record = keptOf(state.get().get(key) ?? empty);
        const expected = known.get(key);
        const stored = keptIn(expected, pairing);
        if (stored !== undefined && sameKept(record, stored)) return true;
        const value = yield* encodeStored({ revision: yield* revision, pairing, ...record });
        const claimed = yield* storage.commit(
          [{ table: "drafts", key, value }],
          [{ table: "drafts", key, value: expected ?? null }],
          pairing,
        );
        if (claimed) {
          known.set(key, value);
          return true;
        }
        // The pairing ended: the drafts are dropped as this window follows the next.
        // Credential storage that cannot be read counts as ended too: nothing
        // is reloaded, the draft stays as it is here, not saved, and its next
        // attempt claims the record as this window last read it, again.
        return (yield* connection.stillPaired(pairing)) ? yield* reload(target, pairing) : false;
      },
      Effect.catchTags({
        LocalStorageError: (error) =>
          Effect.logWarning("A draft is kept in memory only, until it can be saved", error).pipe(
            Effect.as(false),
          ),
        SchemaError: (error) =>
          Effect.logError("A draft could not be encoded", error).pipe(Effect.as(false)),
      }),
    );
    yield* Effect.gen(function* () {
      // Attempts in a row that left a draft not saved.
      let failures = 0;
      while (true) {
        yield* Queue.take(wake);
        const targets = unwritten.take();
        let failed = false;
        for (const target of targets) {
          yield* locked(
            Effect.gen(function* () {
              // Without a pairing, nothing is kept: no window could send it.
              // A draft of a pairing this window no longer follows goes with it.
              const pairing = followed.get();
              if (pairing === null || closed()) return;
              const key = targetKey(target);
              if (yield* writeOne(target, pairing)) {
                markSaved(key, true);
                return;
              }
              // It stays as this window holds it, and goes again: a change
              // made meanwhile goes in its place.
              failed = true;
              markSaved(key, false);
              if (!unwritten.has(key)) unwritten.set(key, target);
            }),
          );
        }
        unwritten.written();
        if (!failed) {
          failures = 0;
          continue;
        }
        failures += 1;
        yield* Effect.sleep(backoffDelay(failures, policy, yield* Random.next));
        Queue.offerUnsafe(wake, void 0);
      }
    }).pipe(Effect.forkIn(scope));

    // Another window kept, emptied or sent a draft: this one shows it as the
    // device now keeps it, at once, so every window holds the same draft and
    // the next write here claims the record as it is. What this window held
    // and the device never kept is offered back, as when its own write finds
    // the change. A window that hears nothing of the others, or hears late,
    // still finds the change when it writes. It listens from before this
    // window can write anything; a change another window makes between this
    // one's first read of the drafts and here is one it finds as it writes.
    yield* storage.changes.pipe(
      Stream.filter((table) => table === "drafts"),
      Stream.runForEach(() =>
        locked(
          Effect.gen(function* () {
            const pairing = followed.get();
            if (pairing === null || closed()) return;
            const stored = yield* storage.readAll("drafts");
            for (const key of new Set([...stored.keys(), ...known.keys()])) {
              if (stored.get(key) === known.get(key)) continue;
              const target = keyTarget(key);
              if (Option.isSome(target)) yield* reload(target.value, pairing);
            }
          }),
        ).pipe(
          Effect.catchTag("LocalStorageError", (error) =>
            Effect.logWarning("Drafts another window changed could not be read", error),
          ),
        ),
      ),
      Effect.forkIn(scope, { startImmediately: true }),
    );

    /**
     * Changes one draft in memory at once, unless it is `sending`, and has the
     * writer keep it when what the device keeps of it changed.
     */
    const changeNow = (target: EntryTarget, update: (draft: Draft) => Draft) => {
      const key = targetKey(target);
      const before = state.get().get(key) ?? empty;
      if (before.sending || closed()) return;
      const after = update(before);
      if (after === before) return;
      // What is left to write is settled before the draft shows, as in
      // `reload`: a file shown uploaded is a save under way until it is kept.
      const toKeep = !sameKept(keptOf(before), keptOf(after));
      if (toKeep) unwritten.set(key, target);
      show(key, after);
      if (toKeep) Queue.offerUnsafe(wake, void 0);
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

    /**
     * The draft with `text` and its `mentions`, placing the files `order`
     * names, by key, in that order: a file it leaves out is taken out. Without
     * `order` the files stay as they are, and the text is made to place them
     * all (`fittedMarks`).
     */
    const withText =
      (text: string, mentions: ReadonlyArray<DraftMention>, order?: ReadonlyArray<string>) =>
      (draft: Draft): Draft => {
        const files =
          order === undefined
            ? draft.files
            : order.flatMap((key) => draft.files.filter((file) => file.key === key));
        const writing = fittedMarks({ text, mentions }, files.length);
        const next = { ...draft, ...writing, files };
        return draft.text === next.text &&
          sameWriting(draft, next) &&
          draft.files.length === files.length &&
          draft.files.every((file, index) => file === files[index])
          ? draft
          : next;
      };

    /** Stops the uploads of the files `draft` held that `next` no longer does. */
    const stopDropped = (before: Draft | undefined, after: Draft | undefined) => {
      const dropped = (before?.files ?? []).flatMap((file) => {
        if (after?.files.some((kept) => kept.key === file.key) === true) return [];
        const upload = uploads.get(file.key);
        uploads.delete(file.key);
        return upload === undefined ? [] : [upload];
      });
      return Fiber.interruptAll(dropped);
    };

    const setText = (
      target: EntryTarget,
      text: string,
      mentions: ReadonlyArray<DraftMention> = [],
      order?: ReadonlyArray<string>,
    ) =>
      Effect.suspend(() => {
        const key = targetKey(target);
        const before = state.get().get(key);
        changeNow(target, withText(text, mentions, order));
        return stopDropped(before, state.get().get(key));
      });

    const restore = (target: EntryTarget) =>
      locked(
        Effect.sync(() => {
          const key = targetKey(target);
          const held = displaced.get(key);
          if (held === undefined || state.get().get(key)?.sending === true) return;
          offer(key, null);
          changeNow(target, withText(held.text, held.mentions));
        }),
      );

    const dismiss = (target: EntryTarget) =>
      locked(Effect.sync(() => offer(targetKey(target), null)));

    /** The draft with `entries` placed together at `at` in its text, or after it. */
    const withFiles =
      (at: number | undefined, entries: ReadonlyArray<DraftFile>) =>
      (draft: Draft): Draft => {
        const placed = insertMarks(draft, at ?? draft.text.length, entries.length);
        return {
          ...draft,
          text: placed.text,
          mentions: placed.mentions,
          files: draft.files.toSpliced(placed.index, 0, ...entries),
        };
      };

    /**
     * Uploads the draft's file `fileKey` with `upload` for the pairing this
     * window follows, showing how far it has gone, then the file ready or
     * failed. It stops when that pairing ends.
     */
    const startUpload = Effect.fnUntraced(function* (
      target: EntryTarget,
      fileKey: string,
      local: LocalFile,
      upload: (
        pairing: DeviceId,
        onProgress: (sent: number) => void,
      ) => Effect.Effect<Attachment, UploadRefused | NotPaired>,
    ) {
      const key = targetKey(target);
      const pairing = followed.get();
      const progress = (sent: number) => {
        const current = state
          .get()
          .get(key)
          ?.files.find((candidate) => candidate.key === fileKey);
        if (current?._tag !== "uploading" || current.sent === sent) return;
        replaceFileNow(target, fileKey, { ...current, sent });
      };
      const ready: (attachment: Attachment) => DraftFile = (attachment) =>
        local.recording === true
          ? { _tag: "ready", key: fileKey, attachment, recording: true }
          : { _tag: "ready", key: fileKey, attachment };
      const fiber = yield* (
        pairing === null ? Effect.fail(new NotPaired()) : upload(pairing, progress)
      ).pipe(
        Effect.matchEffect({
          // The server holds it, so the device need not keep it: let go
          // before it shows ready, so whoever sees it ready sees it let go.
          onSuccess: (attachment) =>
            Effect.sync(() => release(fileKey)).pipe(
              Effect.andThen(replaceFile(target, fileKey, ready(attachment))),
            ),
          onFailure: (error) =>
            replaceFile(target, fileKey, {
              _tag: "failed",
              key: fileKey,
              problem: uploadProblem(error),
              ...local,
            }),
        }),
        Effect.ensuring(Effect.sync(() => uploads.delete(fileKey))),
        Effect.forkIn(scope),
      );
      uploads.set(fileKey, fiber);
    });

    const attach = Effect.fn("Drafts.attach")(function* (
      target: EntryTarget,
      added: ReadonlyArray<{ readonly name: string; readonly body: Blob }>,
      at?: number,
    ) {
      const key = targetKey(target);
      if (state.get().get(key)?.sending === true || closed()) return;
      const held = heldFiles(state.get().get(key));
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
      // Placed where the operator left the caret, or after the text.
      yield* change(target, withFiles(at, entries));

      for (const [index, file] of picked.entries()) {
        if (problems[index] !== null) continue;
        yield* startUpload(target, file.key, file.local, (pairing, onProgress) =>
          files.upload({
            pairing,
            name: file.local.name,
            mediaType: file.local.mediaType,
            body: file.body,
            onProgress,
          }),
        );
      }
    });

    const attachRecording = Effect.fn("Drafts.attachRecording")(function* (
      target: EntryTarget,
      recording: DraftRecording,
      at?: number,
    ) {
      const key = targetKey(target);
      const fileKey = `local-${++nextKey}`;
      const local: LocalFile = {
        name: recording.name,
        mediaType: RECORDING_MEDIA_TYPE,
        size: recording.size,
        recording: true,
      };
      // The draft takes no file while its drafts are not read, or could not
      // be until Retry reads them, nor while it is being sent: it waits for
      // them, for the pairing it was given under.
      const pairing = followed.get();
      while (closed() || state.get().get(key)?.sending === true) {
        yield* waitFor(unread, (value) => !value);
        yield* waitFor(switching, (value) => !value);
        yield* waitFor(state, (drafts) => drafts.get(key)?.sending !== true);
      }
      if (followed.get() !== pairing) return false;
      const [problem = null] = admitFiles(heldFiles(state.get().get(key)), [local]);
      yield* change(
        target,
        withFiles(at, [
          problem !== null
            ? { _tag: "failed", key: fileKey, problem, ...local }
            : recording.transcribe === undefined
              ? { _tag: "uploading", key: fileKey, sent: 0, ...local }
              : { _tag: "uploading", key: fileKey, sent: 0, transcribing: 0, ...local },
        ]),
      );
      // Not taken after all: the recording is left as it was.
      const taken = (state.get().get(key)?.files ?? []).some((file) => file.key === fileKey);
      if (!taken) return false;
      releases.set(fileKey, recording.release);
      if (problem !== null) return true;
      const { transcribe } = recording;
      /** Shows how far the transcript has come, while the recording still waits for it. */
      const transcribing = (done: number) => {
        const current = state
          .get()
          .get(key)
          ?.files.find((candidate) => candidate.key === fileKey);
        if (current?._tag !== "uploading" || current.transcribing === undefined) return;
        if (current.transcribing === done) return;
        replaceFileNow(target, fileKey, { ...current, transcribing: done });
      };
      /** The zip's size once it is ready to upload, its transcript in it or settled without. */
      const sized =
        transcribe === undefined
          ? Effect.succeed(recording.size)
          : transcribe(transcribing).pipe(
              Effect.tap((size) =>
                Effect.sync(() =>
                  replaceFileNow(target, fileKey, {
                    _tag: "uploading",
                    key: fileKey,
                    sent: 0,
                    ...local,
                    size,
                  }),
                ),
              ),
            );
      yield* startUpload(target, fileKey, local, (pairing, onProgress) =>
        sized.pipe(
          Effect.flatMap((size) =>
            files.uploadRecording({
              pairing,
              name: recording.name,
              size,
              read: recording.read,
              onProgress,
            }),
          ),
        ),
      );
      return true;
    });

    const detach = (target: EntryTarget, fileKey: string) =>
      Effect.suspend(() => {
        const upload = uploads.get(fileKey);
        uploads.delete(fileKey);
        return change(target, (draft) => {
          const index = draft.files.findIndex((file) => file.key === fileKey);
          if (index === -1) return draft;
          return {
            ...draft,
            ...withoutMarks(draft, (mark) => mark === index),
            files: draft.files.toSpliced(index, 1),
          };
        }).pipe(Effect.andThen(upload === undefined ? Effect.void : Fiber.interrupt(upload)));
      });

    const quote = (target: EntryTarget, added: MessageQuote) =>
      Effect.sync((): "added" | "full" | "not-now" => {
        const draft = state.get().get(targetKey(target)) ?? empty;
        if (draft.sending || closed()) return "not-now";
        const quotes = withQuote(draft.quotes, added);
        if (quotes === "full") return "full";
        changeNow(target, (held) => (sameQuotes(held.quotes, quotes) ? held : { ...held, quotes }));
        return "added";
      });

    const unquote = (target: EntryTarget, index: number) =>
      change(target, (draft) =>
        index >= 0 && index < draft.quotes.length
          ? { ...draft, quotes: draft.quotes.toSpliced(index, 1) }
          : draft,
      );

    const send = Effect.fn("Drafts.send")(function* (
      target: EntryTarget,
      addressing?: Addressing,
      context?: Effect.Effect<WindowContext | undefined>,
    ) {
      const key = targetKey(target);
      // What the operator pressed Send on, captured at the press.
      const draft = state.get().get(key) ?? empty;
      if (draft.sending) return "empty";
      // The drafts of another pairing are on their way: this one is no more.
      if (switching.get()) return "changed-elsewhere";
      if (unread.get()) return "not-ready";
      if (draft.files.some((file) => file._tag !== "ready")) return "not-ready";
      // Every file is uploaded: each mark places one of `attachments`, in order.
      const { text, offsets } = placedMessage(draft.text);
      const { files: drafted } = keptOf(draft);
      if (context === undefined && text === "" && drafted.length === 0) return "empty";
      const pressed: Draft = { ...draft, sending: true };
      show(key, pressed);
      // The pairing the draft is sent under, as the draft's files uploaded for it.
      const sentUnder = followed.get();
      // Whether this window still shows the draft as Send held it: an empty
      // one, which goes only with a picture, is shown as no draft at all.
      const held = () => (state.get().get(key) ?? null) === (isEmpty(pressed) ? null : pressed);
      /**
       * Nothing went: the draft is back as it was pressed, unless another
       * window's change replaced it meanwhile, which then stays.
       */
      const giveBack = <R extends DraftSendResult>(result: R): R | "changed-elsewhere" => {
        if (!held()) return "changed-elsewhere";
        show(key, draft);
        return result;
      };
      const beside = context === undefined ? undefined : yield* context;
      if (followed.get() !== sentUnder) return giveBack("changed-elsewhere");
      const picture = beside?.picture;
      // The window alone is no message: it goes with words or files.
      if (text === "" && drafted.length === 0 && picture === undefined) return giveBack("empty");
      const local =
        picture === undefined
          ? null
          : {
              name: picture.name,
              mediaType: normalizeMediaType(picture.body.type),
              size: picture.body.size,
            };
      // Checked before it uploads, so a picture the message cannot take is never stored.
      if (local !== null && admitFiles(drafted, [local])[0] !== null) {
        return giveBack("picture-failed");
      }
      if (picture !== undefined && sentUnder === null) return giveBack("not-kept");
      const uploaded =
        picture === undefined || local === null || sentUnder === null
          ? null
          : yield* files
              .upload({ pairing: sentUnder, ...local, body: picture.body, onProgress: () => {} })
              .pipe(
                // The draft waits on it: offline, or too slow for one
                // transfer of its size, it fails and the draft is back.
                Effect.timeoutOption(transferDeadline(local.size, policy.requestTimeout)),
                Effect.option,
                Effect.map(Option.flatten),
              );
      if (uploaded !== null && Option.isNone(uploaded)) return giveBack("picture-failed");
      // The picture follows the draft's files, after the text.
      const attachments = uploaded === null ? drafted : [...drafted, uploaded.value];
      const placedAt =
        uploaded === null || drafted.length === 0 ? offsets : [...offsets, text.length];
      return yield* locked(
        Effect.gen(function* () {
          // A sending draft takes no change, so only another window's change
          // replaces it, and the notice of that change says why nothing went.
          if (!held()) return "changed-elsewhere";
          const pairing = followed.get();
          // The pairing changed since Send was pressed: this draft goes with
          // the pairing that ended, and nothing of it was kept.
          if (connection.pairing.get() !== pairing) return "changed-elsewhere";
          // Without a pairing, the device keeps no message.
          if (pairing === null) {
            show(key, draft);
            return "not-kept";
          }
          // The draft is left empty with a revision of its own; nothing can fail to encode.
          const handedOver = yield* encodeStored({
            revision: yield* revision,
            pairing,
            ...keptOf(empty),
          }).pipe(Effect.orDie);
          // The outbox holds the message from here; its delivery outlives the caller.
          const kept = yield* conversations
            .enqueue(
              {
                target,
                text,
                attachments,
                ...(drafted.length === 0 ? {} : { attachmentOffsets: placedAt }),
                ...(beside?.lookingAt === undefined ? {} : { lookingAt: beside.lookingAt }),
                ...(draft.quotes.length === 0 ? {} : { quotes: draft.quotes }),
                ...addressing,
              },
              {
                pairing,
                alongside: [{ table: "drafts", key, value: handedOver }],
                expected: [{ table: "drafts", key, value: known.get(key) ?? null }],
              },
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
              stale.delete(key);
              markSaved(key, true);
              offer(key, null);
              known.set(key, handedOver);
              show(key, empty);
              // The server stores a recording as any file, so only Send knows one went.
              if (draft.files.some((file) => file._tag === "ready" && file.recording === true)) {
                yield* usageData
                  .record({ event: "feature.used", properties: { feature: "screen-recording" } })
                  .pipe(Effect.forkIn(scope));
              }
              break;
            case "changed-elsewhere":
              // Unread, the draft stays as this window holds it, not saved, and nothing went.
              if (!(yield* reload(target, pairing))) return "not-kept";
              break;
            default:
              // Not kept, or over a limit of a message: it stays as it was.
              show(key, draft);
              // The pairing ended while Send ran: the draft goes with it.
              if (kept === "not-kept" && connection.pairing.get() !== pairing) {
                return "changed-elsewhere";
              }
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
      stale.clear();
      unsaved.set(new Set());
      known.clear();
      displaced.clear();
      offers.set(new Map());
      state.set(new Map());
    });

    const discardAll = (pairing: DeviceId | null) =>
      locked(
        Effect.gen(function* () {
          // A window that follows a pairing made since already dropped these,
          // and shows that pairing's own.
          if (followed.get() === pairing) yield* dropAll;
          if (pairing !== null) yield* erase(pairing);
        }),
      );

    // Whenever the pairing this window follows changes, from none, to none or
    // to another, the drafts it held go, here and on the device, and those
    // the device keeps for the pairing it follows now show.
    yield* Effect.gen(function* () {
      while (true) {
        yield* waitFor(connection.pairing, (current) => current !== followed.get());
        loading = true;
        settle();
        yield* locked(
          Effect.gen(function* () {
            const ended = followed.get();
            const next = connection.pairing.get();
            yield* dropAll;
            unread.set(false);
            followed.set(next);
            if (ended !== null) {
              yield* erase(ended).pipe(
                Effect.catchTag("LocalStorageError", (error) =>
                  Effect.logWarning("Drafts of a pairing that ended stay in local storage", error),
                ),
              );
            }
            if (next !== null) yield* load(next);
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              loading = false;
              settle();
            }),
          ),
        );
      }
    }).pipe(Effect.forkIn(scope));

    const retryRead = locked(
      Effect.suspend(() => {
        const pairing = followed.get();
        // A change of pairing reads the drafts anew by itself.
        if (!unread.get() || pairing === null || connection.pairing.get() !== pairing) {
          return Effect.void;
        }
        return load(pairing);
      }),
    ).pipe(Effect.map(() => !unread.get()));

    return Drafts.of({
      state: visible(state, noDrafts),
      setText,
      attach,
      attachRecording,
      detach,
      quote,
      unquote,
      send,
      changedElsewhere: Stream.fromPubSub(changes),
      offers: visible(offers, noOffers),
      switching,
      readFailed: visible(unread, false),
      retryRead,
      notSaved: visible(unsaved, noKeys),
      saving: visible(saving, false),
      restore,
      dismiss,
      discardAll,
    });
  }),
);
