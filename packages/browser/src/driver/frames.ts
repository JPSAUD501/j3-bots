// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from T3 Code v0.1.13, apps/server/src/preview/ServerBrowserPage.ts, `openReaders`
// (MIT License, Copyright (c) 2026 T3 Tools Inc.; see this package's NOTICE).
import * as Schema from "effect/Schema";
import type { CDPSession, Frame, Page } from "playwright-core";
import { RELAY_PAGE_ONLY } from "../cdpRelay.ts";
import { DOTTED_SCRIPT } from "./redact.ts";

/** Thrown inside a read when the frames changed under it; the snapshot starts again. */
export class FramesChanged extends Schema.TaggedError<FramesChanged>()("FramesChanged", {}) {}

const isStrings = Schema.is(Schema.Array(Schema.String));

interface FrameTreeNode {
  readonly frame: { readonly id: string };
  readonly childFrames?: ReadonlyArray<FrameTreeNode>;
}

const frameIds = (node: FrameTreeNode): Array<string> => [
  node.frame.id,
  ...(node.childFrames ?? []).flatMap(frameIds),
];

/** One reader of hidden values, for the frames one CDP session (or the page itself) holds. */
export interface FrameReader {
  readonly frames: ReadonlyArray<Frame>;
  readonly read: () => Promise<ReadonlyArray<string>>;
}

const WORLD = "j3-browser";

/**
 * The readers of every frame on the page. Each frame is read in an
 * isolated world of its own CDP session, which page script cannot see or
 * spoof: the page's session for the frames in its process, and a session of
 * their own for frames in another process. A desktop tab's relay serves the
 * page alone, so such a frame is read in its page world there instead.
 * `sessions` keeps the frames' sessions from one snapshot to the next.
 */
export const openReaders = async (
  page: Page,
  cdp: CDPSession,
  sessions: Map<Frame, Promise<CDPSession>>,
): Promise<{
  readonly frames: ReadonlyArray<Frame>;
  readonly readers: ReadonlyArray<FrameReader>;
}> => {
  const frames = page.frames();
  const owners = new Map<Frame, CDPSession | null | undefined>(
    await Promise.all(
      frames.map(async (frame): Promise<readonly [Frame, CDPSession | null | undefined]> => {
        if (frame === page.mainFrame()) return [frame, cdp];
        const session = sessions.get(frame) ?? page.context().newCDPSession(frame);
        sessions.set(frame, session);
        try {
          return [frame, await session];
        } catch (cause) {
          sessions.delete(frame);
          // The relay serves only the page: such a frame is read in its page world.
          // Any other refusal is a frame in its parent's process, read with the parent.
          return [frame, String(cause).includes(RELAY_PAGE_ONLY) ? null : undefined];
        }
      }),
    ),
  );
  const ownerOf = (frame: Frame): CDPSession | null => {
    const owner = owners.get(frame);
    if (owner !== undefined) return owner;
    const parent = frame.parentFrame();
    return parent === null ? null : ownerOf(parent);
  };
  const sessionReader = (frame: Frame, session: CDPSession): FrameReader => {
    const owned = frames.filter((each) => ownerOf(each) === session);
    const open = async () => {
      const { frameTree } = await session.send("Page.getFrameTree");
      const ids = frameIds(frameTree);
      // A frame Playwright knows and this session does not would go unread.
      if (ids.length !== owned.length) throw new FramesChanged();
      return Promise.all(
        ids.map(async (frameId) => {
          const world = await session.send("Page.createIsolatedWorld", {
            frameId,
            worldName: WORLD,
          });
          return world.executionContextId;
        }),
      );
    };
    let contexts: Promise<ReadonlyArray<number>> | undefined;
    const read = async () => {
      try {
        const values = await Promise.all(
          (await (contexts ??= open())).map(async (contextId) => {
            const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
              contextId,
              expression: DOTTED_SCRIPT,
              returnByValue: true,
            });
            const value: unknown = result.value;
            if (exceptionDetails !== undefined || !isStrings(value)) throw new FramesChanged();
            return value;
          }),
        );
        return values.flat();
      } catch (cause) {
        // The frame may have moved to another process; the next snapshot opens a new session.
        if (session !== cdp) {
          sessions.delete(frame);
          void session.detach().catch(() => undefined);
        }
        throw cause;
      }
    };
    return { frames: owned, read };
  };
  const pageWorld = (frame: Frame): FrameReader => ({
    frames: [frame],
    read: async () => {
      const value: unknown = await frame.evaluate(DOTTED_SCRIPT);
      if (!isStrings(value)) throw new FramesChanged();
      return value;
    },
  });
  const readers = [
    sessionReader(page.mainFrame(), cdp),
    ...frames.flatMap((frame): Array<FrameReader> => {
      const owner = owners.get(frame);
      if (owner) return owner === cdp ? [] : [sessionReader(frame, owner)];
      return ownerOf(frame) === null ? [pageWorld(frame)] : [];
    }),
  ];
  return { frames, readers };
};
