// SPDX-License-Identifier: AGPL-3.0-or-later
import { GlobeIcon } from "lucide-react";
import { useI18n } from "../../app/context";
import { Button } from "../../components/ui/button";

/** In the conversation's header, in the desktop app: the globe that opens the browser beside it. */
export function BrowserToggle({
  open,
  onToggle,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <Button
      variant="ghost-muted"
      size="icon"
      onClick={onToggle}
      aria-pressed={open}
      aria-label={t(open ? "desktopBrowser.close" : "browser.open")}
    >
      <GlobeIcon />
    </Button>
  );
}
