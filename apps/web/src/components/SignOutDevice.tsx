// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import type { SettingsIntents } from "./SettingsDialog";
import { Button } from "./ui/button";
import { Confirm } from "./ui/confirm";

/**
 * Signs this device out once the operator confirms, after a question that
 * says what goes and what stays. `quiet`: a plain text button, for the
 * screens before the roster, where it is not what the operator came for.
 */
export function SignOutDevice({
  onSignOut,
  quiet = false,
}: {
  onSignOut: SettingsIntents["signOut"];
  quiet?: boolean;
}) {
  const { t } = useI18n();
  // Success leaves the app for pairing, or tells of another tab's new pairing
  // in a notice, so only a failure is ever shown here.
  const [signOut, setSignOut] = useState<"idle" | "pending" | "failed">("idle");
  return (
    <div className={cn("flex flex-col gap-1.5", quiet ? "items-center" : "items-start")}>
      <Confirm
        trigger={
          <Button
            size="sm"
            variant={quiet ? "ghost-muted" : "destructive-outline"}
            aria-disabled={signOut === "pending"}
          />
        }
        busy={signOut === "pending"}
        title={t("settings.signOut.title")}
        body={t("settings.signOut.body")}
        cancel={t("settings.signOut.cancel")}
        confirm={t("settings.signOut")}
        onConfirm={() => {
          setSignOut("pending");
          onSignOut().then((done) => setSignOut(done ? "idle" : "failed"));
        }}
      >
        {signOut === "pending" ? t("settings.signOut.pending") : t("settings.signOut")}
      </Confirm>
      <p role="alert" className="text-xs text-blocked empty:hidden">
        {signOut === "failed" && t("settings.signOut.failed")}
      </p>
    </div>
  );
}
