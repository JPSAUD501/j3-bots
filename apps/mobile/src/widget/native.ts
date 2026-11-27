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
  settingUp(): boolean;
  choose(target: string): Promise<void>;
  close(): void;
  openApp(link: string | null): void;
}

const module = requireOptionalNativeModule<HomeWidgetModule>("HomeWidget");

/** A bot's faces as a widget draws them, each a PNG in base64, by name (`now-light`, `quiet-dark`…). */
export type WidgetFaceImages = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** What the app asks of Android for its widgets; null where the module is absent (iOS). */
export interface HomeWidgetNative {
  /** What the widgets on home screens show: none when there are none. */
  readonly targets: () => Promise<ReadonlyArray<WidgetTarget>>;
  /** Keeps what the widgets show and draws them again. */
  readonly write: (snapshot: WidgetSnapshot, faces: WidgetFaceImages) => Promise<void>;
  /** Whether a widget's setup is open now. */
  readonly settingUp: () => boolean;
  /** Gives the widget being set up `target`; its setup stays open until `close`. */
  readonly choose: (target: WidgetTarget) => Promise<void>;
  /** Closes the setup: without a choice, a widget being added is not placed. */
  readonly close: () => void;
  /** Opens the app, on `link` when one is given, and closes the setup. */
  readonly openApp: (link: string | null) => void;
}

const decodeTargets = Schema.decodeUnknownSync(Schema.Array(WidgetTarget));

export const homeWidget: HomeWidgetNative | null =
  module === null
    ? null
    : {
        targets: async () => decodeTargets(await module.targets()),
        write: (snapshot, faces) => module.write(JSON.stringify(snapshot), JSON.stringify(faces)),
        settingUp: () => module.settingUp(),
        choose: (target) => module.choose(JSON.stringify(target)),
        close: () => module.close(),
        openApp: (link) => module.openApp(link),
      };
