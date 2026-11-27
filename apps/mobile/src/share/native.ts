// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS_PER_MESSAGE } from "@j3-bots/contracts";
import { type NativeModule, requireOptionalNativeModule } from "expo";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The share sheet's module (modules/share-sheet), on Android only. What it
// answers crosses from Kotlin, so each answer is decoded before the app
// trusts it.

/** One shared file, as the module copied it into the app's own storage. */
const IncomingFile = Schema.Struct({
  /** The copy: a `file:` URI in a folder of the app's cache for this share alone. */
  uri: Schema.String,
  /** The name the sending app gave it, without any path. */
  name: Schema.String,
  /** As the sending app gave it; empty when it gave none. */
  mediaType: Schema.String,
  /** The bytes copied: one past the largest attachment for a file that is larger. */
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});

/** A share, as another app sent it to the share sheet. */
const Incoming = Schema.Struct({
  text: Schema.NullOr(Schema.String),
  /** What the sending app called it (`EXTRA_SUBJECT` or `EXTRA_TITLE`). */
  title: Schema.NullOr(Schema.String),
  /** The bot of the Direct Share shortcut the share came through. */
  botId: Schema.NullOr(Schema.String),
  files: Schema.Array(IncomingFile),
  /** Files the module could not read, or would not: one named by a path, or of the app's own. */
  unreadable: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  /** Files past the most one message carries, which were not read. */
  beyond: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type Incoming = typeof Incoming.Type;

declare class ShareSheetModule extends NativeModule<{ onBack: (event: unknown) => void }> {
  take(sheet: string, limit: number, most: number): Promise<unknown>;
  close(sheet: string): void;
  openApp(sheet: string, link: string | null): void;
  setShortcuts(bots: string): Promise<void>;
  reportShared(botId: string): Promise<void>;
}

const module = requireOptionalNativeModule<ShareSheetModule>("ShareSheet");

/** A bot as a Direct Share shortcut: its face a PNG in base64, drawn full bleed. */
export interface ShortcutBot {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  /** What tapping the shortcut from the launcher opens (`appLink`). */
  readonly link: string;
}

/**
 * What the app asks of Android for sharing; null where the module is absent
 * (iOS, the web gallery). `sheet` is the key Android gave the sheet's root
 * (`ShareRoot`'s `sheet` property): each call is about that sheet alone.
 */
export interface ShareSheetNative {
  /** The share sheet `sheet` was opened with, its files copied; null once it is closed. */
  readonly take: (sheet: string) => Promise<Incoming | null>;
  /** Closes the sheet; the share's copies go with it. */
  readonly close: (sheet: string) => void;
  /** Opens the app, on `link` when one is given, and closes the sheet. */
  readonly openApp: (sheet: string, link: string | null) => void;
  /** Makes `bots` Direct Share's targets, in order. */
  readonly setShortcuts: (bots: ReadonlyArray<ShortcutBot>) => Promise<void>;
  /** Tells Android a share went to `botId`. */
  readonly reportShared: (botId: string) => Promise<void>;
  /** Calls `listener` each time Back is pressed in sheet `sheet`, until the returned function is called. */
  readonly onBack: (sheet: string, listener: () => void) => () => void;
}

const decodeIncoming = Schema.decodeUnknownSync(Schema.NullOr(Incoming));
const decodeBack = Schema.decodeUnknownOption(Schema.Struct({ sheet: Schema.String }));

export const shareSheet: ShareSheetNative | null =
  module === null
    ? null
    : {
        take: async (sheet) =>
          decodeIncoming(
            await module.take(sheet, MAX_ATTACHMENT_SIZE, MAX_ATTACHMENTS_PER_MESSAGE),
          ),
        close: (sheet) => module.close(sheet),
        openApp: (sheet, link) => module.openApp(sheet, link),
        setShortcuts: (bots) => module.setShortcuts(JSON.stringify(bots)),
        reportShared: (botId) => module.reportShared(botId),
        onBack: (sheet, listener) => {
          const subscription = module.addListener("onBack", (event) => {
            if (Option.exists(decodeBack(event), (back) => back.sheet === sheet)) listener();
          });
          return () => subscription.remove();
        },
      };
