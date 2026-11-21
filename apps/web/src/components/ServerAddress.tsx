// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectRefusal, ConnectResult } from "@j3-bots/desktop-bridge";
import { useId, useState, type ReactElement } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { Centered, Ensemble, Heading } from "./EmptyStates";
import { Button } from "./ui/button";
import { Confirm } from "./ui/confirm";

const fieldClass =
  "h-10 w-full rounded-md border border-input bg-surface px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11";

interface ServerAddressProps {
  /** Resolves with the app's answer; once connected, the page loads again on that server. */
  readonly onConnect: (address: string) => Promise<ConnectResult | null>;
  /** The address the field starts with, as from a pairing link; the operator still continues. */
  readonly initialAddress?: string;
  /** A sentence about a link that led here, said above the form. */
  readonly notice?: string | null;
}

/**
 * The desktop app's first screen: where the server runs. A browser never
 * shows it, since the server serves the page. Pairing comes next.
 */
export function ServerAddress({
  onConnect,
  initialAddress = "",
  notice = null,
}: ServerAddressProps) {
  const { t, parts } = useI18n();
  const fieldId = useId();
  const errorId = useId();
  const [address, setAddress] = useState(initialAddress);
  const [state, setState] = useState<
    | { readonly _tag: "editing" }
    | { readonly _tag: "checking" }
    | { readonly _tag: "failed"; readonly reason: ConnectRefusal | "no-answer" }
  >({ _tag: "editing" });
  const ready = address.trim() !== "" && state._tag !== "checking";
  const command = (
    <code key="command" className="font-mono text-foreground">
      j3-bots pair
    </code>
  );

  function failureText(
    reason: ConnectRefusal | "no-answer",
  ): string | ReadonlyArray<string | ReactElement> {
    switch (reason) {
      case "invalid":
        return parts<"server.invalid", ReactElement>("server.invalid", { command });
      case "needs-https":
        return t("server.needsHttps");
      case "unreachable":
        return t("server.unreachable");
      case "not-j3-bots":
        return t("server.notJ3Bots");
      case "not-saved":
        return t("server.notSaved");
      // Never shown: the page answers `server-kept` by loading again.
      case "server-kept":
      case "no-answer":
        return t("server.failed");
    }
  }

  return (
    <Centered>
      <Ensemble />
      <Heading
        title={t("server.title")}
        body={parts<"server.body", ReactElement>("server.body", { command })}
      />
      {notice !== null && (
        <p role="status" className="max-w-sm rounded-md bg-muted px-3 py-2 text-sm break-words">
          {notice}
        </p>
      )}
      <form
        className="flex w-full max-w-xs flex-col gap-3 text-start"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setState({ _tag: "checking" });
          onConnect(address).then((result) => {
            if (result === null) return setState({ _tag: "failed", reason: "no-answer" });
            if (result._tag === "refused" && result.reason !== "server-kept")
              return setState({ _tag: "failed", reason: result.reason });
            // A server is kept, this one or one named since this page loaded:
            // the page starts again on it.
            window.location.reload();
          });
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId} className="text-xs">
            {t("server.address")}
          </label>
          <input
            id={fieldId}
            value={address}
            onChange={(event) => setAddress(event.currentTarget.value)}
            autoComplete="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={2048}
            placeholder="192.168.1.20:3737"
            aria-invalid={state._tag === "failed"}
            aria-describedby={state._tag === "failed" ? errorId : undefined}
            className={`${fieldClass} font-mono`}
          />
        </div>
        <Button type="submit" variant="primary" aria-disabled={!ready}>
          {state._tag === "checking" ? t("server.checking") : t("server.submit")}
        </Button>
        <p id={errorId} role="alert" className="text-xs text-blocked empty:hidden">
          {state._tag === "failed" ? failureText(state.reason) : null}
        </p>
      </form>
    </Centered>
  );
}

interface ChangeServerProps {
  /** The server this app talks to. */
  readonly address: string;
  /** Resolves `false` when the server is still kept; otherwise the app opens the server address screen. */
  readonly onChange: () => Promise<boolean>;
  /** This device is signed in on the server: ask first, since that sign-in goes. */
  readonly paired: boolean;
  /** Something else is under way that changing server would undo. */
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * Leaves the server for another, in the desktop app: the app forgets it,
 * with this device's sign-in there and everything kept for it, and returns
 * to the server address screen.
 */
export function ChangeServer({
  address,
  onChange,
  paired,
  disabled = false,
  className,
}: ChangeServerProps) {
  const { t } = useI18n();
  // Success loads the page again, so only a failure is ever shown here.
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const pending = state === "pending";
  const unavailable = pending || disabled;
  const change = () => {
    if (unavailable) return;
    setState("pending");
    onChange().then((forgotten) => setState(forgotten ? "pending" : "failed"));
  };
  const label = pending ? t("server.change.pending") : t("server.change");
  const trigger = <Button size="sm" variant="ghost-muted" aria-disabled={unavailable} />;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {paired ? (
        <Confirm
          trigger={trigger}
          busy={unavailable}
          title={t("server.change.title")}
          body={t("server.change.body", { address })}
          cancel={t("server.change.cancel")}
          confirm={t("server.change")}
          onConfirm={change}
        >
          {label}
        </Confirm>
      ) : (
        <Button size="sm" variant="ghost-muted" aria-disabled={unavailable} onClick={change}>
          {label}
        </Button>
      )}
      <p role="alert" className="text-xs text-blocked empty:hidden">
        {state === "failed" && t("server.change.failed")}
      </p>
    </div>
  );
}
