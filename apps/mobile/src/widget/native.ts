// SPDX-License-Identifier: AGPL-3.0-or-later
import { BotId, RoutineId } from "@j3-bots/contracts";
import { requireOptionalNativeModule } from "expo";
import * as Schema from "effect/Schema";
import type { WidgetSnapshot } from "./snapshot.ts";

// The home-screen widget's module (modules/home-widget), on Android only.
// What it answers crosses from Kotlin, so each answer is decoded before the
// app trusts it.

/** What one widget on a home screen was set up to show. */
const WidgetTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("bot"), botId: BotId }),
  Schema.Struct({ kind: Schema.Literal("routine"), botId: BotId, routineId: RoutineId }),
]);
export type WidgetTarget = typeof WidgetTarget.Type;

interface HomeWidgetModule {
  targets(): Promise<unknown>;
  write(snapshot: string, faces: string): Promise<void>;
  choose(setup: string, target: string): Promise<void>;
  close(setup: string): void;
  openApp(setup: string, link: string | null): void;
}

const module = requireOptionalNativeModule<HomeWidgetModule>("HomeWidget");

/** A bot's faces as a widget draws them, each a PNG in base64, by name (`now-light`, `quiet-dark`…). */
export type WidgetFaceImages = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * What the app asks of Android for its widgets; null where the module is
 * absent (iOS). `setup` is the key Android gave a setup's root
 * (`WidgetSetupRoot`'s `setup` property): each call is about that setup alone.
 */
export interface HomeWidgetNative {
  /** What the widgets on home screens show: none when there are none. */
  readonly targets: () => Promise<ReadonlyArray<WidgetTarget>>;
  /** Keeps what the widgets show and draws them again. */
  readonly write: (snapshot: WidgetSnapshot, faces: WidgetFaceImages) => Promise<void>;
  /** Gives the widget being set up `target`; its setup stays open until `close`. */
  readonly choose: (setup: string, target: WidgetTarget) => Promise<void>;
  /** Closes the setup: without a choice, a widget being added is not placed. */
  readonly close: (setup: string) => void;
  /** Opens the app, on `link` when one is given, and closes the setup. */
  readonly openApp: (setup: string, link: string | null) => void;
}

const decodeTargets = Schema.decodeUnknownSync(Schema.Array(WidgetTarget));

export const homeWidget: HomeWidgetNative | null =
  module === null
    ? null
    : {
        targets: async () => decodeTargets(await module.targets()),
        write: (snapshot, faces) => module.write(JSON.stringify(snapshot), JSON.stringify(faces)),
        choose: (setup, target) => module.choose(setup, JSON.stringify(target)),
        close: (setup) => module.close(setup),
        openApp: (setup, link) => module.openApp(setup, link),
      };
