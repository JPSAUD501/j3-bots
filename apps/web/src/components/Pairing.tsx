// SPDX-License-Identifier: AGPL-3.0-or-later
import { useId, useRef, useState, type ReactElement } from "react";
import type { PairingFailure, PairResult, UnpairedReason } from "@j3-bots/client-runtime";
import type { PairingCode } from "@j3-bots/contracts";
import { clockTime } from "@j3-bots/client-runtime/presentation";
import type { I18n } from "@j3-bots/i18n";
import { useI18n, usePresentation } from "../app/context";
import type { DesktopServer, DesktopUpdate } from "../shell/data";
import { AppUpdate } from "./AppUpdate";
import { bigFieldClass, BigButton, FirstScreen, FormProblem } from "../onboarding/parts";
import { Centered, Heading } from "./EmptyStates";
import { ChangeServer } from "./ServerAddress";
import { Button } from "./ui/button";

/**
 * A name for this device that the operator recognises in their list: browser
 * and system, in the operator's language.
 */
export function guessDeviceName(userAgent: string, t: I18n["t"]): string {
  const browser = /Electron\//.test(userAgent)
    ? t("pairing.deviceGuess.app")
    : /Edg\//.test(userAgent)
      ? "Edge"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : t("pairing.deviceGuess.browser");
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
  return system === null ? browser : t("pairing.deviceGuess", { browser, system });
}

interface PairingProps {
  /** Why this device has no credential, said above the form unless it never had one. */
  readonly reason: UnpairedReason;
  readonly onPair: (input: {
    readonly code: string;
    readonly deviceName: string;
  }) => Promise<PairResult>;
  /** The name the device field starts with. */
  readonly defaultName: string;
  /** The code the field starts with, from a pairing link; the operator still presses Pair. */
  readonly initialCode?: PairingCode | null | undefined;
  /** The origin of the server this device pairs with, shown above the form. */
  readonly address: string;
  /**
   * In the desktop app, the server the operator named, and a way back to the
   * screen that names it. A browser's server is the page's own, so it has none.
   */
  readonly server?: DesktopServer | undefined;
  /** In the desktop app, restarts it, as once the system's keyring is unlocked. */
  readonly restart?: (() => void) | undefined;
  /** In the desktop app, updating it, when it can: offered when the server speaks another protocol. */
  readonly update?: DesktopUpdate | undefined;
}

/**
 * The first screen on a new device: the server it pairs with, the code from
 * `j3-bots pair` and a name for the device. Once paired, the app opens by
 * itself.
 */
export function Pairing({
  reason,
  onPair,
  defaultName,
  initialCode,
  address,
  server,
  restart,
  update,
}: PairingProps) {
  const ctx = usePresentation();
  const { t, parts } = ctx.i18n;
  const codeId = useId();
  const nameId = useId();
  const errorId = useId();
  const codeRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState<string>(initialCode ?? "");
  const [name, setName] = useState(defaultName);
  const [state, setState] = useState<
    | { readonly _tag: "editing" }
    | { readonly _tag: "pairing" }
    | { readonly _tag: "failed"; readonly reason: PairingFailure }
  >({ _tag: "editing" });
  // Pairing and changing server never run together: one would undo the other.
  const [changingServer, setChangingServer] = useState(false);
  // A lockout only shows its time: the server enforces it, and the operator
  // can lift it on the host before then, so Pair stays available.
  const busy = state._tag === "pairing" || changingServer;
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
        // The desktop app carries its page: reloading it changes nothing.
        return server === undefined
          ? t("pairing.incompatible")
          : t("gate.incompatible.appBody", { address: server.address });
      case "storage-failed":
        // The code is spent and the device listed by now: in the desktop
        // app, only a new process sees a keyring unlocked since it started.
        return restart === undefined
          ? t("pairing.storageFailed")
          : t("pairing.storageFailed.desktop");
    }
  }

  return (
    <FirstScreen
      title={t("pairing.title")}
      body={parts<"pairing.body", ReactElement>("pairing.body", {
        command: (
          <code key="command" className="font-mono text-foreground">
            j3-bots pair
          </code>
        ),
      })}
    >
      {reason !== "new" && (
        <p className="w-full rounded-lg bg-muted px-4 py-3 text-sm">
          {reason === "signed-out" ? t("pairing.signedOut") : t("pairing.stillListed")}
        </p>
      )}
      <div className="flex w-full flex-col items-center gap-1 text-sm text-muted-foreground">
        <span className="font-mono break-all text-foreground">
          {t("pairing.server", { address })}
        </span>
        {server !== undefined && (
          <ChangeServer
            address={server.address}
            onChange={() => {
              setChangingServer(true);
              return server.forget().then((forgotten) => {
                if (!forgotten) setChangingServer(false);
                return forgotten;
              });
            }}
            paired={false}
            disabled={state._tag === "pairing"}
            className="items-center"
          />
        )}
      </div>
      <form
        className="flex w-full flex-col gap-4 text-start"
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
        <div className="flex flex-col gap-1.5">
          <label htmlFor={codeId} className="text-sm font-medium">
            {t("pairing.code")}
          </label>
          <input
            id={codeId}
            ref={codeRef}
            value={code}
            onChange={(event) => {
              setCode(event.currentTarget.value);
              // A new code is a new attempt: the last answer, a lockout's time
              // included, no longer describes it.
              if (state._tag === "failed") setState({ _tag: "editing" });
            }}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={24}
            placeholder="ABCDE-12345"
            aria-invalid={state._tag === "failed" && state.reason._tag === "invalid-code"}
            aria-describedby={error === null ? undefined : errorId}
            className={`${bigFieldClass} text-center font-mono tracking-widest uppercase placeholder:normal-case`}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-sm font-medium">
            {t("pairing.deviceName")}
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            maxLength={200}
            className={bigFieldClass}
          />
        </div>
        <BigButton type="submit" disabled={!ready}>
          {state._tag === "pairing" ? t("pairing.pairing") : t("pairing.submit")}
        </BigButton>
        <FormProblem id={errorId}>{error}</FormProblem>
        {server === undefined &&
          state._tag === "failed" &&
          state.reason._tag === "incompatible-server" && (
            <Button onClick={() => window.location.reload()}>{t("gate.reload")}</Button>
          )}
        {update !== undefined &&
          state._tag === "failed" &&
          state.reason._tag === "incompatible-server" && (
            <AppUpdate update={update} className="items-center text-center" />
          )}
        {restart !== undefined &&
          state._tag === "failed" &&
          state.reason._tag === "storage-failed" && (
            <Button onClick={restart}>{t("gate.restart")}</Button>
          )}
      </form>
    </FirstScreen>
  );
}

/**
 * The server speaks another version of the protocol: this page is older or
 * newer than it. A browser reloads to get the server's own page; the desktop
 * app carries its page, so the app or the server needs updating, or the app
 * another server; its `update`, when it can update itself, shows beneath.
 */
export function Incompatible({
  server,
  update,
}: {
  server?: DesktopServer | undefined;
  update?: DesktopUpdate | undefined;
}) {
  const { t } = useI18n();
  if (server !== undefined) {
    return (
      <Centered>
        <Heading
          title={t("gate.incompatible.appTitle")}
          body={t("gate.incompatible.appBody", { address: server.address })}
        />
        <div className="flex flex-wrap items-start justify-center gap-2">
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t("gate.retry")}
          </Button>
          <ChangeServer address={server.address} onChange={server.forget} paired />
        </div>
        {update !== undefined && <AppUpdate update={update} className="items-center text-center" />}
      </Centered>
    );
  }
  return (
    <Centered>
      <Heading title={t("gate.incompatible.title")} body={t("gate.incompatible.body")} />
      <Button variant="primary" onClick={() => window.location.reload()}>
        {t("gate.reload")}
      </Button>
    </Centered>
  );
}

/**
 * The browser would not let the page keep this device's sign-in. In the
 * desktop app, whose server is `server`, the app could not read it, as while
 * a keyring is locked: the app sees a keyring unlocked since only once it
 * starts again, so the way on is to `restart` it. If it stays unreadable, changing servers
 * leaves the sign-in behind.
 */
export function StorageFailed({
  onRetry,
  desktop,
}: {
  onRetry: () => void;
  desktop?: { readonly server: DesktopServer; readonly restart: () => void } | undefined;
}) {
  const { t } = useI18n();
  if (desktop !== undefined) {
    const { server, restart } = desktop;
    return (
      <Centered>
        <Heading
          title={t("gate.storage.desktopTitle")}
          body={t("gate.storage.desktopBody", { address: server.address })}
        />
        <div className="flex flex-wrap items-start justify-center gap-2">
          <Button variant="primary" onClick={restart}>
            {t("gate.restart")}
          </Button>
          <ChangeServer address={server.address} onChange={server.forget} paired />
        </div>
      </Centered>
    );
  }
  return (
    <Centered>
      <Heading title={t("gate.storage.title")} body={t("gate.storage.body")} />
      <Button variant="primary" onClick={onRetry}>
        {t("gate.retry")}
      </Button>
    </Centered>
  );
}
