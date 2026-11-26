// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AppRelease,
  type ClientSide,
  type J3Client,
  makeUpdatePrompt,
  type Readable,
  snoozeStore,
  type UpdatePrompt,
} from "@j3-bots/client-runtime";
import { Storage } from "expo-sqlite/kv-store";
import { Linking } from "react-native";
import { type AppUpdate, type AppUpdateState, appUpdate, updateInHand } from "./appUpdate.ts";

// The update prompt on the phone: what the app brings to it, and one runner
// per client, which outlives the screens it is shown over, so an update
// under way carries on from the roster to the screen for a server this app
// no longer speaks with.

/** The newer version of the app the operator can install now: one a check found, not yet taken. */
const appRelease = (state: AppUpdateState | null): AppRelease | null =>
  state?._tag === "available"
    ? {
        version: state.release.version,
        notesUrl: state.release.notesUrl,
        highlights: state.release.highlights,
        how: "install",
      }
    : null;

/**
 * What the phone brings to the prompt: an app that updates itself installs
 * its own update after the server's; one Google Play updates, or a build
 * that does not update itself, does nothing. The phone runs no bots.
 */
export const clientSideOf = (state: AppUpdateState | null): ClientSide => ({
  follow: appUpdate === null || state === null || state._tag === "play" ? "none" : "install",
  app: appRelease(state),
  workItStops: 0,
});

/**
 * Installs the app's update for the prompt: checks the feed first, as the
 * server may have just moved to a release the phone's last check did not
 * see, then downloads, verifies and hands it to Android. Settles `current`
 * when there is nothing newer, `failed` when a step fails or the operator
 * declines Android's confirmation; an install that goes through replaces
 * the app, which takes this with it.
 */
const installPhone = async (app: AppUpdate): Promise<"current" | "failed"> => {
  if (!updateInHand(app.state.get())) await app.check();
  return new Promise((resolve) => {
    // A release found, by this check or one already under way, is taken once.
    let taken = false;
    const look = () => {
      const state = app.state.get();
      switch (state._tag) {
        case "available":
        case "cancelled":
          // A confirmation declined before keeps its verified file, which
          // Try again hands to Android again; declined during this one, it
          // ends it.
          if (!taken) {
            taken = true;
            void app.update();
            return;
          }
          return state._tag === "cancelled" ? settle("failed") : undefined;
        case "current":
        case "play":
        case "unchecked":
          return settle("current");
        case "failed":
          return settle("failed");
        case "checking":
        case "downloading":
        case "verifying":
        case "permission":
        case "installing":
          return;
      }
    };
    const settle = (outcome: "current" | "failed") => {
      stop();
      resolve(outcome);
    };
    const stop = app.state.subscribe(look);
    look();
  });
};

const SNOOZE_KEY = "j3:updatePromptSnooze";
const NO_STATE: Readable<AppUpdateState | null> = {
  get: () => null,
  subscribe: () => () => undefined,
};

const prompts = new WeakMap<J3Client, UpdatePrompt>();

/** The update prompt's runner for `client`, made on first use. */
export const updatePromptOf = (client: J3Client): UpdatePrompt => {
  const made = prompts.get(client);
  if (made !== undefined) return made;
  const state = appUpdate?.state ?? NO_STATE;
  const prompt = makeUpdatePrompt({
    server: client.serverUpdate,
    client: {
      side: { get: () => clientSideOf(state.get()), subscribe: state.subscribe },
      // The phone never reloads: it does not come with the server.
      update: () => (appUpdate === null ? Promise.resolve("current") : installPhone(appUpdate)),
      openDownload: (url) => void Linking.openURL(url),
    },
    snooze: snoozeStore({
      get: () => Storage.getItemSync(SNOOZE_KEY),
      set: (value) =>
        value === null
          ? Storage.removeItemSync(SNOOZE_KEY)
          : Storage.setItemSync(SNOOZE_KEY, value),
    }),
    now: Date.now,
  });
  // The app's own checks as it opens wait while the server updates first.
  prompt.state.subscribe(() => appUpdate?.waitForServer(prompt.state.get().run._tag === "server"));
  prompts.set(client, prompt);
  return prompt;
};
