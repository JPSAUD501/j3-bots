// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorsClient, IntentResult } from "@j3-bots/client-runtime";
import type { SignInRoute } from "@j3-bots/client-runtime/react";
import type { BotId, ConnectorGlyph, ConnectorId, EntryId, ListingRef } from "@j3-bots/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { useI18n } from "../../app/context";
import { Button } from "../ui/button";

/**
 * What the connectors screen asks of the client runtime, and of the device:
 * how a sign-in's browser comes back here (`signInRoute`), opening a page in
 * the system browser, and opening where the vault is unlocked or set up.
 */
export interface ConnectorsIntents extends Omit<ConnectorsClient, "state"> {
  readonly signInRoute: SignInRoute;
  readonly openPage: (url: string) => void;
  readonly openVault: () => void;
}

/** A page of the connectors screen. */
export type ConnectorsPlace =
  | { readonly _tag: "home" }
  | {
      readonly _tag: "listing";
      readonly ref: ListingRef;
      readonly name: string;
      readonly glyph: ConnectorGlyph | null;
    }
  | {
      readonly _tag: "connector";
      readonly connectorId: ConnectorId;
      /** Start its sign-in as the page opens, as a card's Sign in asks. */
      readonly signIn: boolean;
      /** It was just added here: the page says who can use it from now. */
      readonly added: boolean;
    }
  | { readonly _tag: "add-own" };

/**
 * What opened the connectors screen: where it opens, the bot a new
 * connector is for at first (the one whose details or card opened it; null
 * for the primary bot), and the card that suggested it, which the server
 * closes once it is added.
 */
export interface ConnectorsOpening {
  readonly at: ConnectorsPlace;
  readonly forBot: BotId | null;
  readonly suggestion: EntryId | null;
}

/** What a read the screen waits on answered: its value, or that it did not. */
export type Answer<A> =
  | { readonly _tag: "loading" }
  | { readonly _tag: "ready"; readonly value: A }
  | { readonly _tag: "failed" };

const loading = { _tag: "loading" } as const;

/**
 * The answer to `load`, read once for each `key` and each retry; null `key`
 * reads nothing. An answer that comes for a key or a retry since replaced is
 * dropped.
 */
export function useAnswer<A>(
  key: string | null,
  load: () => Promise<IntentResult<A>>,
): { readonly answer: Answer<A>; readonly retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [held, setHeld] = useState<{
    readonly key: string;
    readonly attempt: number;
    readonly answer: Answer<A>;
  } | null>(null);
  const read = useEffectEvent(load);
  useEffect(() => {
    if (key === null) return;
    let live = true;
    void read().then((result) => {
      if (!live) return;
      setHeld({
        key,
        attempt,
        answer:
          result._tag === "done" ? { _tag: "ready", value: result.value } : { _tag: "failed" },
      });
    });
    return () => {
      live = false;
    };
  }, [key, attempt]);
  const answer =
    held !== null && held.key === key && held.attempt === attempt ? held.answer : loading;
  return { answer, retry: () => setAttempt(attempt + 1) };
}

/** A read that did not answer, and a way to read it again. */
export function Failed({ text, onRetry }: { text: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-muted-foreground">{text}</p>
      <Button size="sm" onClick={onRetry}>
        {t("connectors.retry")}
      </Button>
    </div>
  );
}
