// SPDX-License-Identifier: AGPL-3.0-or-later
import { useWorkSteps } from "@j3-bots/client-runtime/react";
import type { EntryId, WorkStep } from "@j3-bots/contracts";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";

/** Reads one open work fold's steps for as long as it stays open. */
function FoldReader({
  foldId,
  onSteps,
}: {
  foldId: EntryId;
  onSteps: (foldId: EntryId, steps: ReadonlyArray<WorkStep>) => void;
}) {
  const state = useWorkSteps(foldId);
  const report = useEffectEvent(onSteps);
  useEffect(() => {
    if (state !== null && state.phase !== "loading") report(foldId, state.steps);
  }, [foldId, state]);
  return null;
}

/** The work folds a conversation has open, and their steps as they are read. */
export interface WorkFolds {
  /** A fold's steps, or null while they load. */
  readonly steps: (entryId: EntryId) => ReadonlyArray<WorkStep> | null;
  readonly open: (entryId: EntryId) => void;
  readonly close: (entryId: EntryId) => void;
  /** What reads the open folds: render it once, anywhere under the client. */
  readonly readers: ReactNode;
}

/** Reads the steps of each work fold the operator opens, for as long as it stays open. */
export function useWorkFolds(): WorkFolds {
  const [openFolds, setOpenFolds] = useState<ReadonlySet<EntryId>>(new Set());
  const [steps, setSteps] = useState<ReadonlyMap<EntryId, ReadonlyArray<WorkStep>>>(new Map());
  return {
    steps: (entryId) => steps.get(entryId) ?? null,
    open: (entryId) => setOpenFolds((open) => new Set(open).add(entryId)),
    close: (entryId) => setOpenFolds((open) => new Set([...open].filter((id) => id !== entryId))),
    readers: [...openFolds].map((foldId) => (
      <FoldReader
        key={foldId}
        foldId={foldId}
        onSteps={(id, list) => setSteps((held) => new Map(held).set(id, list))}
      />
    )),
  };
}
