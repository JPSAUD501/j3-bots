// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SignInsState } from "@j3-bots/client-runtime";
import type { BrowserSignIns, BrowserSite } from "@j3-bots/contracts";
import { useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { Section } from "./SettingsSection";
import { Button } from "./ui/button";
import { Confirm } from "./ui/confirm";
import { SkeletonRows } from "./ui/skeleton";

/**
 * Settings' Browser page: the sites the person is signed in to in J3 Bots'
 * browser, which their bots use too, each with its own Sign out, then
 * signing out of all of them, which asks first since it ends every one at
 * once. A server older than the list shows none, only signing out of all;
 * sign-ins locked with the secrets can be signed out of only once the
 * secrets can be read.
 */
export function BrowserSection({
  signIns,
  connected,
  onSignOutSite,
  onSignOut,
}: {
  signIns: SignInsState | null;
  connected: boolean;
  onSignOutSite: (site: BrowserSite) => Promise<boolean>;
  onSignOut: () => Promise<boolean>;
}) {
  return (
    <>
      {signIns?._tag !== "unsupported" && (
        <SitesSection
          signIns={signIns?._tag === "ready" ? signIns.value : null}
          connected={connected}
          onSignOutSite={onSignOutSite}
        />
      )}
      <SignOutAll
        connected={connected && !(signIns?._tag === "ready" && signIns.value.status === "locked")}
        onSignOut={onSignOut}
      />
    </>
  );
}

function SitesSection({
  signIns,
  connected,
  onSignOutSite,
}: {
  signIns: BrowserSignIns | null;
  connected: boolean;
  onSignOutSite: (site: BrowserSite) => Promise<boolean>;
}) {
  const { t } = useI18n();
  // Sign-outs under way, or that failed. One that is done leaves the list with its site.
  const [signingOut, setSigningOut] = useState<ReadonlyMap<BrowserSite, "pending" | "failed">>(
    new Map(),
  );
  const signOut = (site: BrowserSite) => {
    setSigningOut((held) => new Map(held).set(site, "pending"));
    void onSignOutSite(site).then((done) =>
      setSigningOut((held) => {
        const next = new Map(held);
        if (done) next.delete(site);
        else next.set(site, "failed");
        return next;
      }),
    );
  };
  return (
    <Section title={t("settings.siteSignIns.sites")}>
      {signIns === null ? (
        <SkeletonRows />
      ) : signIns.status !== "ready" ? (
        <p className="text-xs text-muted-foreground">
          {t(
            signIns.status === "locked"
              ? "settings.siteSignIns.locked"
              : "settings.siteSignIns.unreadable",
          )}
        </p>
      ) : signIns.sites.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("settings.siteSignIns.none")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {signIns.sites.map(({ site }) => {
            const state = signingOut.get(site);
            return (
              <li
                key={site}
                className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{site}</span>
                  <span role="alert" className="text-2xs text-blocked empty:hidden">
                    {state === "failed" && t("settings.siteSignIns.signOutSite.failed", { site })}
                  </span>
                </span>
                <Button
                  size="sm"
                  aria-label={t("settings.siteSignIns.signOutSite.label", { site })}
                  aria-disabled={!connected || state === "pending"}
                  onClick={() => {
                    if (connected && state !== "pending") signOut(site);
                  }}
                >
                  {t("settings.siteSignIns.signOutSite")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function SignOutAll({
  connected,
  onSignOut,
}: {
  connected: boolean;
  onSignOut: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [signOut, setSignOut] = useState<"idle" | "pending" | "done" | "failed">("idle");
  return (
    <Section apart>
      <div className="flex flex-col items-start gap-1.5">
        <Confirm
          trigger={
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={!connected}
              aria-disabled={signOut === "pending"}
            />
          }
          busy={signOut === "pending"}
          title={t("settings.siteSignIns.signOut.title")}
          body={t("settings.siteSignIns.signOut.body")}
          cancel={t("settings.siteSignIns.signOut.cancel")}
          confirm={t("settings.siteSignIns.signOut.confirm")}
          onConfirm={() => {
            setSignOut("pending");
            void onSignOut().then((done) => setSignOut(done ? "done" : "failed"));
          }}
        >
          {t("settings.siteSignIns.signOut")}
        </Confirm>
        <p
          role={signOut === "failed" ? "alert" : "status"}
          className={cn(
            "text-xs empty:hidden",
            signOut === "failed" ? "text-blocked" : "text-muted-foreground",
          )}
        >
          {signOut === "done" && t("settings.siteSignIns.signOut.done")}
          {signOut === "failed" && t("settings.siteSignIns.signOut.failed")}
        </p>
      </div>
    </Section>
  );
}
