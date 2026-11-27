// SPDX-License-Identifier: AGPL-3.0-or-later
import { Dialog } from "@base-ui/react/dialog";
import { useProfileEdits } from "@j3-bots/client-runtime/react";
import { SettingsIcon } from "lucide-react";
import { useId } from "react";
import { useI18n } from "../app/context";
import { deferred } from "../lib/deferred";
import { useTabletUp } from "../lib/useTabletUp";
import type { SettingsButtonProps } from "./SettingsDialog";
import { UpdatePromptEntryButton } from "./UpdatePrompt";
import { WhatsNewButton } from "./WhatsNew";
import { Button } from "./ui/button";
import { dialogBackdrop, screenDialog } from "./ui/dialog";

/**
 * Settings' pages are not part of the app's first load: their code is fetched
 * once the app is up (`preloadWhenIdle` in the shell), or when Settings opens.
 */
export const settingsPanel = deferred(() =>
  import("./SettingsDialog").then((settings) => settings.SettingsPanel),
);

// The profile form's unsaved edits are held outside the dialog: Settings
// closed for the operator, as when a notification opens a conversation,
// keeps them; closing it themselves discards them.

/**
 * The roster's footer: the way back to the update prompt, What's new, and
 * Settings, which opens everything that is not about one bot at the list of
 * its pages. Opening Settings reads the settings and devices again, for what
 * another device changed.
 */
export function SettingsButton({ data, intents }: SettingsButtonProps) {
  const { t } = useI18n();
  const titleId = useId();
  const profile = useProfileEdits(data.settingsSaves.profile);
  const updateEntry = intents.updatePrompt?.entry ?? null;
  const wide = useTabletUp();
  return (
    <div className="flex flex-col border-t border-border p-2">
      {updateEntry !== null && intents.updatePrompt !== undefined && (
        <UpdatePromptEntryButton entry={updateEntry} onOpen={intents.updatePrompt.reopen} />
      )}
      <WhatsNewButton whatsNew={intents.whatsNew} />
      <Dialog.Root
        open={data.settingsOpen}
        onOpenChange={(open) => {
          if (open) {
            intents.showSettingsPage(null);
            intents.refreshSettings();
            intents.refreshDevices();
            intents.serverUpdate?.refresh();
          } else {
            profile.discard();
            // The operator has seen how the update this device followed ended.
            intents.serverUpdate?.dismissEnded();
          }
          intents.setSettingsOpen(open);
        }}
      >
        <Dialog.Trigger
          render={<Button variant="ghost-muted" className="w-full justify-start px-2" />}
        >
          <SettingsIcon aria-hidden />
          {t("settings.title")}
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Backdrop className={dialogBackdrop} />
          <Dialog.Popup
            aria-labelledby={titleId}
            className={`${screenDialog} tablet:top-12 tablet:bottom-12 tablet:max-w-3xl`}
          >
            <settingsPanel.Component
              data={data}
              intents={intents}
              profile={profile}
              titleId={titleId}
              wide={wide}
            />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
