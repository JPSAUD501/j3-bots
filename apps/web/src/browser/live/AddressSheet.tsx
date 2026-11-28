// SPDX-License-Identifier: AGPL-3.0-or-later
import { addressOf } from "@j3-bots/client-runtime/presentation";
import { useState } from "react";
import { useI18n } from "../../app/context";
import { Button } from "../../components/ui/button";
import { textField } from "../../components/ui/field";
import { cn } from "../../lib/cn";
import { Sheet } from "./Sheet";

/**
 * An address to go to, or to open a new tab at, typed in a sheet, as on the
 * phone: a host alone is taken as https, and anything that is not a web
 * address says so in place.
 */
export function AddressSheet({
  open,
  title,
  onClose,
  onGo,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  /** Goes to `url`, an address the person means. */
  readonly onGo: (url: string) => void;
}) {
  const { t } = useI18n();
  const [typed, setTyped] = useState("");
  const [wrong, setWrong] = useState(false);
  const close = () => {
    setTyped("");
    setWrong(false);
    onClose();
  };
  return (
    <Sheet open={open} title={title} onClose={close}>
      <form
        // The address is checked here, so a host alone can be taken as https.
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const url = addressOf(typed);
          if (url === null) {
            setWrong(true);
            return;
          }
          setTyped("");
          setWrong(false);
          onGo(url);
        }}
      >
        <input
          type="url"
          inputMode="url"
          enterKeyHint="go"
          // The sheet opens because the person asked to type an address: it takes the focus.
          autoFocus
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            setWrong(false);
          }}
          aria-label={t("browser.viewer.address")}
          aria-invalid={wrong}
          aria-describedby={wrong ? "browser-sheet-address-error" : undefined}
          placeholder={t("browser.address.placeholder")}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={cn(textField, "h-11 px-3 text-base")}
        />
        {wrong && (
          <p id="browser-sheet-address-error" role="alert" className="text-sm text-blocked">
            {t("browser.viewer.badAddress")}
          </p>
        )}
        <Button type="submit" variant="primary">
          {t("browser.address.go")}
        </Button>
      </form>
    </Sheet>
  );
}
