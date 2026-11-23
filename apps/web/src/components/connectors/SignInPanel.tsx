// SPDX-License-Identifier: AGPL-3.0-or-later
import { clockTime } from "@j3-bots/client-runtime/presentation";
import type { ConnectorSignIn } from "@j3-bots/client-runtime/react";
import { signInProblemText } from "@j3-bots/client-runtime/wording";
import { ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { usePresentation } from "../../app/context";
import { Button } from "../ui/button";
import { LineField } from "./parts";

/**
 * A connector's sign-in as it goes: the page it opened in the browser, and
 * a way to open it again, since a browser can block it or the operator close
 * it; then, where the browser comes back to no one (`paste`), the address it
 * lands on, pasted here, with a word on the apps that need none. A sign-in
 * that ended badly says why, and starts again from `onRetry`; one the vault
 * stops, from `onUnlock`.
 */
export function SignInPanel({
  signIn,
  onRetry,
  onUnlock,
}: {
  signIn: ConnectorSignIn;
  onRetry: () => void;
  onUnlock: () => void;
}) {
  const ctx = usePresentation();
  const { t } = ctx.i18n;
  const [address, setAddress] = useState("");
  const { phase } = signIn;

  switch (phase._tag) {
    case "idle":
    case "done":
      return null;
    case "starting":
      return (
        <Panel>
          <p role="status" className="text-sm">
            {t("signIn.starting")}
          </p>
        </Panel>
      );
    case "finishing":
      return (
        <Panel>
          <p role="status" className="text-sm">
            {t("signIn.finishing")}
          </p>
        </Panel>
      );
    case "failed": {
      const vault = phase.problem === "vault-locked" || phase.problem === "vault-not-set-up";
      return (
        <Panel>
          <p role="alert" className="text-sm text-blocked">
            {signInProblemText(phase.problem, ctx.i18n)}
          </p>
          <div className="flex flex-wrap gap-2">
            {vault ? (
              <Button size="sm" variant="primary" onClick={onUnlock}>
                {t("connect.openVault")}
              </Button>
            ) : (
              phase.problem !== "not-paired" && (
                <Button size="sm" variant="primary" onClick={onRetry}>
                  {t("signIn.retry")}
                </Button>
              )
            )}
            <Button size="sm" variant="ghost-muted" onClick={signIn.cancel}>
              {t("signIn.cancel")}
            </Button>
          </div>
        </Panel>
      );
    }
    case "waiting":
      return (
        <Panel>
          <p role="status" className="text-sm font-medium">
            {phase.route === "relay" ? t("signIn.waiting.relay") : t("signIn.waiting")}
          </p>
          {phase.route === "paste" && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                signIn.paste(address);
              }}
            >
              <p className="text-sm text-muted-foreground">{t("signIn.paste.steps")}</p>
              <LineField
                label={t("signIn.paste.label")}
                type="url"
                mono
                value={address}
                onChange={setAddress}
                problem={phase.pasteRefused ? t("signIn.paste.refused") : null}
              />
              <Button
                type="submit"
                size="sm"
                variant="primary"
                className="self-start"
                aria-disabled={address.trim() === ""}
              >
                {t("signIn.paste.submit")}
              </Button>
              <p className="text-xs text-muted-foreground">{t("signIn.paste.apps")}</p>
            </form>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={signIn.openAgain}>
              {t("signIn.openAgain")}
              <ExternalLinkIcon aria-hidden />
            </Button>
            <Button size="sm" variant="ghost-muted" onClick={signIn.cancel}>
              {t("signIn.cancel")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("signIn.until", { time: clockTime(phase.expiresAt, ctx) })}
          </p>
        </Panel>
      );
  }
}

function Panel({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 rounded-lg border border-border p-3">{children}</div>;
}
