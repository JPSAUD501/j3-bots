// SPDX-License-Identifier: AGPL-3.0-or-later
import { createI18n } from "@j3-bots/i18n";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nValue } from "./context";

const en = createI18n("en");

/**
 * A React root for a test, whose tree reads the interface's text in English
 * at once, as a page does once its catalog has loaded.
 */
export function createTestRoot(container: Element): Root {
  const root = createRoot(container);
  return {
    render: (children) => root.render(<I18nValue i18n={en}>{children}</I18nValue>),
    unmount: () => root.unmount(),
  };
}

/** A tree's markup, as a test's, with the interface's text in English. */
export const renderTestMarkup = (children: ReactNode): string =>
  renderToStaticMarkup(<I18nValue i18n={en}>{children}</I18nValue>);
