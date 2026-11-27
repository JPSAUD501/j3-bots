// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { releaseName, type WhatsNewView } from "@j3-bots/client-runtime";
import type { WhatsNewRelease } from "@j3-bots/i18n/whats-new";
import { SparklesIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { useI18n } from "../app/context";
import { Section } from "./SettingsSection";
import { Button } from "./ui/button";
import { dialogBackdrop, screenDialog } from "./ui/dialog";

// "What's new": in the roster's footer, beside Settings, only while there is
// something the operator has not seen, a quiet "New in 0.14" once after an
// update, until opened; and always on Settings' About page while the server
// has anything to show. Opening it lists what each release lets people do,
// the newest first.

/** What's new as the shell shows it, and opening it, which drops the mark. */
export interface WhatsNewIntents {
  readonly view: WhatsNewView;
  readonly open: () => void;
}

/**
 * What's new's way in: `footer`, the roster's row, which shows only while
 * there is something new and stays while its list is open; `about`, the row
 * on Settings' About page, always there.
 */
export function WhatsNewButton({
  whatsNew,
  place,
}: {
  readonly whatsNew: WhatsNewIntents;
  readonly place: "footer" | "about";
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const { releases, mark } = whatsNew.view;
  if (releases.length === 0 || (place === "footer" && mark === null && !open)) return null;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) whatsNew.open();
        setOpen(next);
      }}
    >
      <Dialog.Trigger
        render={
          place === "footer" ? (
            <Button variant="ghost-muted" className="w-full justify-start px-2" />
          ) : (
            <Button variant="secondary" size="sm" className="self-start" />
          )
        }
      >
        <SparklesIcon aria-hidden />
        {place === "footer" ? t("whatsNew.title") : t("whatsNew.see")}
        {mark !== null && (
          <span className="ms-auto flex items-center gap-1.5 text-xs font-medium text-accent">
            <span aria-hidden className="size-1.5 rounded-full bg-accent" />
            {t("whatsNew.mark", { version: releaseName(mark) })}
          </span>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdrop} />
        <Dialog.Popup
          aria-labelledby={titleId}
          className={`${screenDialog} tablet:top-12 tablet:bottom-12 tablet:max-w-xl`}
        >
          <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border ps-4 pe-2">
            <Dialog.Title id={titleId} className="display-type text-lg">
              {t("whatsNew.title")}
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button
                  variant="ghost-muted"
                  size="icon"
                  className="ms-auto"
                  aria-label={t("whatsNew.close")}
                />
              }
            >
              <XIcon />
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WhatsNewPage releases={releases} />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** What's new on Settings' About page, while the server has anything to show. */
export function WhatsNewSection({ whatsNew }: { readonly whatsNew: WhatsNewIntents }) {
  const { t } = useI18n();
  if (whatsNew.view.releases.length === 0) return null;
  return (
    <Section title={t("whatsNew.title")}>
      <p className="text-xs text-muted-foreground">{t("whatsNew.description")}</p>
      <WhatsNewButton whatsNew={whatsNew} place="about" />
    </Section>
  );
}

/** Each release's entries, the newest release first. */
export function WhatsNewPage({ releases }: { readonly releases: ReadonlyArray<WhatsNewRelease> }) {
  const { t, locale } = useI18n();
  return (
    <div className="flex flex-col gap-8 px-4 py-5">
      <p className="text-sm text-muted-foreground">{t("whatsNew.description")}</p>
      {releases.map((release) => (
        <section key={release.version} className="flex flex-col gap-4">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t("whatsNew.release", { version: releaseName(release.version) })}
          </h3>
          <ul className="flex flex-col gap-5">
            {release.entries.map((entry) => (
              <li key={entry.title.en} className="flex flex-col gap-1">
                <h4 className="font-medium text-foreground">{entry.title[locale]}</h4>
                <p className="text-sm text-foreground">{entry.body[locale]}</p>
                {entry.where !== undefined && (
                  <p className="text-sm text-muted-foreground">{entry.where[locale]}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
