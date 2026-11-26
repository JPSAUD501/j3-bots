// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ServerUpdateHandle } from "../client.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Cell, type Readable } from "../Store.ts";
import {
  type ClientSide,
  initial,
  type Prompt,
  type PromptAction,
  type PromptEvent,
  serverRelease,
  type Snooze,
  step,
} from "./prompt.ts";

// The update prompt's runner, the same on every client: it holds the model's
// state, feeds it what the server's update and this client report and what
// the operator chooses, and does what each step returns. Each platform
// supplies how its own app updates (`PromptClient`) and where "Later" is
// kept; the server's part goes through the update routes every client shares.

/** How this client updates itself, as its platform does it. */
export interface PromptClient {
  /** What this client brings to the prompt now, as it changes. */
  readonly side: Readable<ClientSide>;
  /**
   * Updates this client: installs what is newer (finding it first if need
   * be) or reloads. Settles `current` when there is nothing newer to
   * install, `failed` when the update did not go through; while it installs
   * or reloads, the app is going away, and it does not settle.
   */
  readonly update: (how: "install" | "reload") => Promise<"current" | "failed">;
  /** Opens the page the app's new version is downloaded from. */
  readonly openDownload: (url: string) => void;
}

/** Where "Later" is kept between launches; a store that fails keeps it for this launch only. */
export interface SnoozeStore {
  readonly read: () => Snooze | null;
  readonly write: (snooze: Snooze | null) => void;
}

/** "Later" as it is kept: JSON, read back through its schema. */
const SnoozeJson = Schema.fromJsonString(
  Schema.Struct({
    until: Schema.Finite,
    server: Schema.NullOr(Schema.String),
    app: Schema.NullOr(Schema.String),
  }),
);
const decodeSnooze = Schema.decodeUnknownOption(SnoozeJson);
const encodeSnooze = Schema.encodeSync(SnoozeJson);

/**
 * A `SnoozeStore` over a platform's string storage: `get` and `set` may
 * throw, as a browser's storage does when it is refused, and what they keep
 * may be anything; either reads as no "Later".
 */
export const snoozeStore = (storage: {
  readonly get: () => string | null;
  readonly set: (value: string | null) => void;
}): SnoozeStore => ({
  read: () => {
    try {
      return Option.getOrNull(decodeSnooze(storage.get()));
    } catch {
      return null;
    }
  },
  write: (snooze) => {
    try {
      storage.set(snooze === null ? null : encodeSnooze(snooze));
    } catch {
      // Kept for this launch only, in the runner's state.
    }
  },
});

export interface UpdatePrompt {
  readonly state: Readable<Prompt>;
  readonly updateNow: () => void;
  readonly stopWork: () => void;
  readonly retry: () => void;
  readonly later: () => void;
  readonly hide: () => void;
  readonly reopen: () => void;
}

export interface UpdatePromptDeps {
  readonly server: Pick<ServerUpdateHandle, "view" | "ended" | "dismissEnded" | "start">;
  readonly client: PromptClient;
  readonly snooze: SnoozeStore;
  readonly now: () => number;
}

export const makeUpdatePrompt = (deps: UpdatePromptDeps): UpdatePrompt => {
  const { server, client } = deps;
  const state = new Cell<Prompt>(initial(deps.snooze.read()));

  const dispatch = (event: PromptEvent): void => {
    const before = state.get();
    const { next, action } = step(before, event);
    if (next !== before) state.set(next);
    if (next.snooze !== before.snooze) deps.snooze.write(next.snooze);
    if (action !== null) perform(action);
  };

  const perform = (action: PromptAction): void => {
    switch (action._tag) {
      case "start-server":
        // What a run before this one ended with is not this one's.
        server.dismissEnded();
        void server.start(action.version, action.stopWork).then((outcome) => {
          switch (outcome._tag) {
            case "started":
              return;
            case "refused":
              return dispatch({
                _tag: "server-refused",
                reason: outcome.reason,
                runningBots: outcome.runningBots,
              });
            case "unsupported":
            case "unreachable":
            case "not-paired":
              return dispatch({ _tag: "server-unreachable" });
          }
        });
        return;
      case "update-client":
        void client.update(action.how).then(
          (outcome) =>
            dispatch({ _tag: outcome === "current" ? "client-current" : "client-failed" }),
          () => dispatch({ _tag: "client-failed" }),
        );
        return;
      case "open-download":
        client.openDownload(action.url);
        return;
    }
  };

  // The server's part ends when the update this client follows has ended
  // and the server answered how: `ended` is set only then.
  server.ended.subscribe(() => {
    const result = server.ended.get();
    if (result !== null && state.get().run._tag === "server") {
      dispatch({ _tag: "server-ended", result });
      // The prompt says how it ended, or goes on to the client: nothing else repeats it.
      server.dismissEnded();
    }
  });
  server.view.subscribe(() => {
    if (server.view.get()._tag === "lost") dispatch({ _tag: "server-lost" });
  });

  const offers = () => ({
    server: serverRelease(server.view.get()),
    client: client.side.get(),
    now: deps.now(),
  });

  return {
    state,
    updateNow: () => dispatch({ _tag: "update-now", ...offers() }),
    stopWork: () => dispatch({ _tag: "stop-work" }),
    retry: () => dispatch({ _tag: "retry", ...offers() }),
    later: () => {
      const { server: release, client: side, now } = offers();
      dispatch({
        _tag: "later",
        now,
        server: release?.version ?? null,
        app: side.app?.version ?? null,
      });
    },
    hide: () => dispatch({ _tag: "hide" }),
    reopen: () => dispatch({ _tag: "reopen" }),
  };
};
