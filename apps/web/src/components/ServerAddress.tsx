// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectRefusal, ConnectResult } from "@j3-bots/desktop-bridge";
import { useId, useState, type ReactElement } from "react";
import { useI18n } from "../app/context";
import { Centered, Ensemble, Heading } from "./EmptyStates";
import { Button } from "./ui/button";

const fieldClass =
  "h-10 w-full rounded-md border border-input bg-surface px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:h-11";

interface ServerAddressProps {
  /** Resolves with the app's answer; once connected, the page loads again on that server. */
  readonly onConnect: (address: string) => Promise<ConnectResult | null>;
}

/**
 * The desktop app's first screen: where the server runs. A browser never
 * shows it, since the server serves the page. Pairing comes next.
 */
export function ServerAddress({ onConnect }: ServerAddressProps) {
  const { t, parts } = useI18n();
  const fieldId = useId();
  const errorId = useId();
  const [address, setAddress] = useState("");
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
      <form
        className="flex w-full max-w-xs flex-col gap-3 text-start"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setState({ _tag: "checking" });
          onConnect(address).then((result) => {
            if (result === null) return setState({ _tag: "failed", reason: "no-answer" });
            if (result._tag === "refused")
              return setState({ _tag: "failed", reason: result.reason });
            // The server is kept: the page starts again on it, at pairing.
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
