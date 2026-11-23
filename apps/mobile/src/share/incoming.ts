// SPDX-License-Identifier: AGPL-3.0-or-later
import { Cell, targetKey } from "@j3-bots/client-runtime";
import {
  type Shared,
  type SharedDraft,
  sharedDraft,
  sharedTemplate,
} from "@j3-bots/client-runtime/presentation";
import { useJ3Client, useReadable } from "@j3-bots/client-runtime/react";
import type { EntryTarget } from "@j3-bots/contracts";
import { File } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useMemo } from "react";
import { AppState, Platform } from "react-native";
import { DeviceBlob } from "../platform/pick.ts";
import { openTemplateAt } from "../template/opened.ts";
import { carriesFiles, sharedOf } from "./shared.ts";

/** A share received and not yet put in a draft. */
type Received =
  | { readonly _tag: "shared"; readonly shared: Shared }
  | { readonly _tag: "unreadable" };

const UNREADABLE: Received = { _tag: "unreadable" };

/**
 * The share waiting for the operator to pick where it goes. Only the latest
 * waits: sharing again replaces it. It is kept in memory, never sent, and
 * lost if the system ends the app first.
 */
const waiting = new Cell<Received | null>(null);

/** A file the system could not copy reads as empty, and the draft leaves it out as one. */
const sizeOf = (uri: string) => new File(uri).size;

const sameShare = (
  a: ReadonlyArray<Sharing.SharePayload>,
  b: ReadonlyArray<Sharing.SharePayload>,
) =>
  a.length === b.length &&
  a.every(
    (payload, index) =>
      payload.value === b[index]?.value &&
      payload.shareType === b[index]?.shareType &&
      payload.mimeType === b[index]?.mimeType,
  );

/**
 * Takes the share the system holds for the app, if any. Only a share that
 * carries files is resolved: resolving a shared link would fetch it.
 */
const receive = async () => {
  const payloads = Sharing.getSharedPayloads();
  if (payloads.length === 0) return;
  const resolved = carriesFiles(payloads) ? await Sharing.getResolvedSharedPayloadsAsync() : [];
  const shared = sharedOf(payloads, resolved, sizeOf);
  // A template file shared on its own opens as one, to make a bot from.
  const template = shared === null ? null : sharedTemplate(shared);
  if (template !== null) await openTemplateAt(template.uri, template.size);
  else waiting.set(shared === null ? UNREADABLE : { _tag: "shared", shared });
  // A share that arrived while this one was read stays, for the next read.
  if (sameShare(Sharing.getSharedPayloads(), payloads)) Sharing.clearSharedPayloads();
};

let receiving = Promise.resolve();

/** Reads one share after another, so a read never overlaps the one before it. */
const receiveNext = () => {
  receiving = receiving.then(receive).catch(() => {
    waiting.set(UNREADABLE);
    Sharing.clearSharedPayloads();
  });
};

/**
 * Receives what other apps share with J3 Bots, for as long as the app runs:
 * the share that started it, then one each time it comes back to the
 * foreground, which is how a share reaches an app already running. Android
 * only: iOS has no share extension (see `app.config.ts`).
 */
export const receiveShares = (): void => {
  if (Platform.OS !== "android") return;
  receiveNext();
  AppState.addEventListener("change", (state) => {
    if (state === "active") receiveNext();
  });
};

/** How putting the share in a draft went. */
export type Put =
  /** In the draft, but for the files it left out, each with why. */
  | { readonly _tag: "put"; readonly leftOut: SharedDraft["leftOut"] }
  /** The draft takes no change now: it is being sent, or the drafts are loading. The share keeps waiting. */
  | { readonly _tag: "busy" }
  /** The drafts could not be read, again. The share keeps waiting. */
  | { readonly _tag: "unread" }
  /** The share no longer waits: an earlier pick put it in a draft, or it was let go. */
  | { readonly _tag: "gone" };

const BUSY: Put = { _tag: "busy" };
const UNREAD: Put = { _tag: "unread" };
const GONE: Put = { _tag: "gone" };

/** What the operator can do with the share waiting for them. */
export type WaitingShare =
  | {
      readonly _tag: "shared";
      readonly shared: Shared;
      /**
       * Puts the share in the draft of `target`, the bot or room the operator
       * picked, by the runtime's rule (`sharedDraft`), and stops waiting.
       * Drafts that could not be read are read again first, as the composer's
       * Try again does, since nothing else reads them again. Each file is read
       * from its copy as it uploads, with the media type and size it was
       * admitted with. Nothing is sent: the composer shows the draft with its
       * files uploading.
       */
      readonly putInDraft: (target: EntryTarget) => Promise<Put>;
      readonly dismiss: () => void;
    }
  | { readonly _tag: "unreadable"; readonly dismiss: () => void };

/** The share waiting for the operator to pick the bot or room whose draft it goes in, or null. */
export function useWaitingShare(): WaitingShare | null {
  const client = useJ3Client();
  const received = useReadable(waiting);
  return useMemo((): WaitingShare | null => {
    if (received === null) return null;
    // A newer share that arrived meanwhile keeps waiting.
    const stillWaiting = () => waiting.get() === received;
    const done = () => {
      if (stillWaiting()) waiting.set(null);
    };
    if (received._tag === "unreadable") return { _tag: "unreadable", dismiss: done };
    return {
      _tag: "shared",
      shared: received.shared,
      putInDraft: async (target) => {
        // A second tap on the list must not put the share in twice.
        if (!stillWaiting()) return GONE;
        if (client.draftsReadFailed.get() && !(await client.retryDrafts())) return UNREAD;
        if (!stillWaiting()) return GONE;
        if (client.draftsReadFailed.get()) return UNREAD;
        const current = client.drafts.get().get(targetKey(target));
        if (current?.sending === true || client.draftsSwitching.get()) return BUSY;
        const draft = sharedDraft(current, received.shared);
        client.setDraftText(target, draft.text, draft.mentions);
        if (draft.uploads.length > 0) {
          client.attachFiles(
            target,
            draft.uploads.map((file) => ({
              name: file.name,
              body: new DeviceBlob(file.uri, file.mediaType, file.size),
            })),
          );
        }
        done();
        return { _tag: "put", leftOut: draft.leftOut };
      },
      dismiss: done,
    };
  }, [client, received]);
}
