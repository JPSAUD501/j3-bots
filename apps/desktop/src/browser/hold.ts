// SPDX-License-Identifier: AGPL-3.0-or-later
import * as Effect from "effect/Effect";

/** One of the view's own input events, which a listener may stop before the page gets it. */
export interface StoppableInput {
  readonly preventDefault: () => void;
}

/**
 * A hold on the person's input to a page: while any effect `holding` runs
 * lasts, every event the view hands its dropper is stopped before the page
 * sees it. `listen` hands the dropper to the view's own input events.
 */
export const makeInputHold = (
  listen: (drop: (event: StoppableInput) => void) => void,
): (<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) => {
  let holds = 0;
  listen((event) => {
    if (holds > 0) event.preventDefault();
  });
  return (effect) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        holds += 1;
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          holds -= 1;
        }),
    );
};
