// SPDX-License-Identifier: AGPL-3.0-or-later
import { useJ3Client, useSignIns } from "@j3-bots/client-runtime/react";
import type { BrowserSignIns, BrowserSite } from "@j3-bots/contracts";
import { useIsFocused } from "@react-navigation/native";
import { useState } from "react";
import { View } from "react-native";
import { Problem, Quiet, Section, SkeletonRows } from "../components/form.tsx";
import { useConfirm } from "../confirm.tsx";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";
import { useSay } from "../toast.tsx";
import { Button } from "../ui.tsx";

/**
 * Settings' Browser page: the sites the person is signed in to in J3 Bots'
 * browser, which their bots use too, followed while the page is in front,
 * each with its own Sign out; then signing out of all of them, which asks
 * first since it ends every one at once. A server older than the list shows
 * none, only signing out of all; sign-ins locked with the secrets can be
 * signed out of only once the secrets can be read.
 */
export function BrowserSection({ connected }: { readonly connected: boolean }) {
  const signIns = useSignIns(useIsFocused());
  return (
    <>
      {signIns?._tag !== "unsupported" && (
        <SitesSection
          signIns={signIns?._tag === "ready" ? signIns.value : null}
          connected={connected}
        />
      )}
      <SignOutAll
        connected={connected && !(signIns?._tag === "ready" && signIns.value.status === "locked")}
      />
    </>
  );
}

function SitesSection({
  signIns,
  connected,
}: {
  readonly signIns: BrowserSignIns | null;
  readonly connected: boolean;
}) {
  const { t } = useI18n();
  const client = useJ3Client();
  // Sign-outs under way, or that failed. One that is done leaves the list with its site.
  const [signingOut, setSigningOut] = useState<ReadonlyMap<BrowserSite, "pending" | "failed">>(
    new Map(),
  );
  const signOut = (site: BrowserSite) => {
    setSigningOut((held) => new Map(held).set(site, "pending"));
    void client.signOutSite(site).then((result) =>
      setSigningOut((held) => {
        const next = new Map(held);
        if (result._tag === "done") next.delete(site);
        else next.set(site, "failed");
        return next;
      }),
    );
  };
  return (
    <Section open title={t("settings.siteSignIns.sites")}>
      {signIns === null ? (
        <SkeletonRows />
      ) : signIns.status !== "ready" ? (
        <Quiet>
          {t(
            signIns.status === "locked"
              ? "settings.siteSignIns.locked"
              : "settings.siteSignIns.unreadable",
          )}
        </Quiet>
      ) : signIns.sites.length === 0 ? (
        <Quiet>{t("settings.siteSignIns.none")}</Quiet>
      ) : (
        signIns.sites.map(({ site }) => {
          const state = signingOut.get(site);
          return (
            <View
              key={site}
              className="flex-row items-center gap-3 rounded-md border border-border px-3 py-2"
            >
              <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-base text-foreground">
                  {site}
                </Text>
                <Problem>
                  {state === "failed"
                    ? t("settings.siteSignIns.signOutSite.failed", { site })
                    : null}
                </Problem>
              </View>
              <Button
                variant="secondary"
                label={t("settings.siteSignIns.signOutSite")}
                // Names the site, as a row of buttons each saying "Sign out" would not.
                accessibilityLabel={t("settings.siteSignIns.signOutSite.label", { site })}
                disabled={!connected || state === "pending"}
                onPress={() => signOut(site)}
              />
            </View>
          );
        })
      )}
    </Section>
  );
}

function SignOutAll({ connected }: { readonly connected: boolean }) {
  const { t } = useI18n();
  const client = useJ3Client();
  const say = useSay();
  const confirm = useConfirm();
  const [state, setState] = useState<"idle" | "pending" | "failed">("idle");
  const signOut = () => {
    setState("pending");
    void client.signOutBrowser().then((result) => {
      if (result._tag === "done") say(t("settings.siteSignIns.signOut.done"));
      setState(result._tag === "done" ? "idle" : "failed");
    });
  };
  return (
    <Section apart>
      <View className="items-start gap-1">
        <Button
          variant="destructive"
          label={t("settings.siteSignIns.signOut")}
          disabled={!connected || state === "pending"}
          onPress={() =>
            confirm({
              title: t("settings.siteSignIns.signOut.title"),
              body: t("settings.siteSignIns.signOut.body"),
              cancel: t("settings.siteSignIns.signOut.cancel"),
              confirm: t("settings.siteSignIns.signOut.confirm"),
              onConfirm: signOut,
            })
          }
        />
        <Problem>{state === "failed" ? t("settings.siteSignIns.signOut.failed") : null}</Problem>
      </View>
    </Section>
  );
}
