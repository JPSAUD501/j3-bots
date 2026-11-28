// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import { useI18n } from "../../app/context";
import { useWaitingBots } from "../waiting";

/**
 * "(needs you)" before the page's title while a bot waits for the person, so
 * a browser tab says it in its own title: in a browser, the app has no
 * notification of its own to show.
 */
export function NeedsYouTitle() {
  const { t } = useI18n();
  const waiting = useWaitingBots().size > 0;
  const words = t("browser.title.needsYou");
  useEffect(() => {
    if (!waiting) return;
    const before = document.title;
    document.title = `${words} ${before}`;
    return () => {
      document.title = before;
    };
  }, [waiting, words]);
  return null;
}
