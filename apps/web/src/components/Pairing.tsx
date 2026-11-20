// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PairingFailure, PairResult, UnpairedReason } from "@j3-bots/client-runtime";
import * as DateTime from "effect/DateTime";
import { useEffect, useId, useRef, useState } from "react";
import { useI18n, usePresentation } from "../app/context";
import { clockTime } from "../lib/time";
import { Centered, Ensemble, Heading } from "./EmptyStates";
import { Button } from "./ui/button";

/** A name for this device that the operator recognises in their list: browser and system. */
export function guessDeviceName(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const system = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /Mac OS X/.test(userAgent)
          ? "Mac"
          : /Windows/.test(userAgent)
            ? "Windows"
            : /Linux/.test(userAgent)
              ? "Linux"
              : null;
  return system === null ? browser : `${browser} on ${system}`;
}

const fieldClass =
  "h-10 w-full rounded-md border border-input bg-surface px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11";

interface PairingProps {
  /** Why this device has no credential, said above the form unless it never had one. */
  readonly reason: UnpairedReason;
  readonly onPair: (input: {
    readonly code: string;
    readonly deviceName: string;
  }) => Promise<PairResult>;
  /** The name the device field starts with. */
  readonly defaultName: string;
}

/**
 * The first screen on a new device: the code from `j3-bots pair` and a name
 * for the device. Once paired, the app opens by itself.
 */
export function Pairing({ reason, onPair, defaultName }: PairingProps) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const codeId = useId();
  const nameId = useId();
  const errorId = useId();
  const codeRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultName);
  const [state, setState] = useState<
    | { readonly _tag: "editing" }
    | { readonly _tag: "pairing" }
    | { readonly _tag: "failed"; readonly reason: PairingFailure }
  >({ _tag: "editing" });
  const lockedUntil =
    state._tag === "failed" && state.reason._tag === "rate-limited" ? state.reason.retryAt : null;
  // Pairing opens again by itself once the lockout ends.
  useEffect(() => {
    if (lockedUntil === null) return;
    const wait = DateTime.toEpochMillis(lockedUntil) - Date.now();
    const timer = window.setTimeout(() => setState({ _tag: "editing" }), Math.max(0, wait));
    return () => window.clearTimeout(timer);
  }, [lockedUntil]);
  const busy = state._tag === "pairing" || lockedUntil !== null;
  const ready = code.trim() !== "" && name.trim() !== "" && !busy;
  const error = state._tag === "failed" ? failureText(state.reason) : null;

  function failureText(reason: PairingFailure): string {
    switch (reason._tag) {
      case "invalid-code":
        return t("pairing.invalid");
      case "rate-limited":
        return t("pairing.rateLimited", { time: clockTime(reason.retryAt, ctx) });
      case "unreachable":
        return t("pairing.unreachable");
      case "incompatible-server":
        return t("pairing.incompatible");
      case "storage-failed":
        return t("pairing.storageFailed");
    }
  }

  return (
    <Centered>
      <Ensemble />
      <Heading title={t("pairing.title")} body={t("pairing.body")} />
      {reason !== "new" && (
        <p className="max-w-sm rounded-md bg-muted px-3 py-2 text-sm">
          {reason === "signed-out" ? t("pairing.signedOut") : t("pairing.stillListed")}
        </p>
      )}
      <form
        className="flex w-full max-w-xs flex-col gap-3 text-start"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setState({ _tag: "pairing" });
          onPair({ code: code.trim(), deviceName: name.trim() }).then((result) => {
            if (result._tag === "paired") return;
            setState({ _tag: "failed", reason: result.reason });
            if (result.reason._tag === "invalid-code") codeRef.current?.select();
          });
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={codeId} className="text-xs">
            {t("pairing.code")}
          </label>
          <input
            id={codeId}
            ref={codeRef}
            value={code}
            onChange={(event) => setCode(event.currentTarget.value)}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={24}
            placeholder="ABCDE-12345"
            aria-invalid={state._tag === "failed" && state.reason._tag === "invalid-code"}
            aria-describedby={error === null ? undefined : errorId}
            className={`${fieldClass} font-mono tracking-wider uppercase placeholder:normal-case`}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={nameId} className="text-xs">
            {t("pairing.deviceName")}
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={200}
            className={fieldClass}
          />
        </div>
        <Button type="submit" variant="primary" aria-disabled={!ready}>
          {state._tag === "pairing" ? t("pairing.pairing") : t("pairing.submit")}
        </Button>
        <p id={errorId} role="alert" className="text-xs text-blocked empty:hidden">
          {error}
        </p>
        {state._tag === "failed" && state.reason._tag === "incompatible-server" && (
          <Button onClick={() => window.location.reload()}>{t("gate.reload")}</Button>
        )}
      </form>
    </Centered>
  );
}

/** The server speaks another version of the protocol: this page is older or newer than it. */
export function Incompatible() {
  const { t } = useI18n();
  return (
    <Centered>
      <Heading title={t("gate.incompatible.title")} body={t("gate.incompatible.body")} />
      <Button variant="primary" onClick={() => window.location.reload()}>
        {t("gate.reload")}
      </Button>
    </Centered>
  );
}

/** The browser would not let the page keep this device's sign-in. */
export function StorageFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <Centered>
      <Heading title={t("gate.storage.title")} body={t("gate.storage.body")} />
      <Button variant="primary" onClick={onRetry}>
        {t("gate.retry")}
      </Button>
    </Centered>
  );
}
