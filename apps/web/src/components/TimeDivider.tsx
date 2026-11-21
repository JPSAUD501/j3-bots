// SPDX-License-Identifier: AGPL-3.0-or-later
import type * as DateTime from "effect/DateTime";
import { usePresentation } from "../app/context";
import { dividerTime } from "@j3-bots/client-runtime/wording";

export function TimeDivider({ at }: { at: DateTime.Utc }) {
  const ctx = usePresentation();
  return (
    <div role="separator" className="py-3 text-center text-2xs text-muted-foreground">
      {dividerTime(at, ctx)}
    </div>
  );
}
