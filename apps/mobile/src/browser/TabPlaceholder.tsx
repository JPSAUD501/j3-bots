// SPDX-License-Identifier: AGPL-3.0-or-later
import { siteOf } from "@j3-bots/client-runtime/presentation";
import { Globe } from "lucide-react-native";
import { View } from "react-native";
import { Icon } from "../components/Icon.tsx";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";

/**
 * What stands in a tab's picture while there is none of the page it is on:
 * the page's title and its site, calm and centered, never an empty box, as
 * the web draws it (`TabPlaceholder.tsx`). The card names the tab.
 */
export function TabPlaceholder({ title, url }: { readonly title: string; readonly url: string }) {
  const { t } = useI18n();
  const site = siteOf(url);
  const name = title.trim() === "" ? site || t("browser.panel.newTab") : title;
  return (
    <View
      className="absolute inset-0 items-center justify-center gap-1.5 bg-muted px-3"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Icon icon={Globe} size={20} color="accent-muted-foreground" />
      <Text numberOfLines={2} className="text-center text-sm font-medium text-foreground">
        {name}
      </Text>
      {site !== "" && site !== name && (
        <Text numberOfLines={1} className="text-2xs text-muted-foreground">
          {site}
        </Text>
      )}
    </View>
  );
}
