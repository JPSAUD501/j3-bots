// SPDX-License-Identifier: AGPL-3.0-or-later
import { ExternalLink } from "lucide-react-native";
import { Linking } from "react-native";
import { PressScale } from "../press.tsx";
import { Text } from "../text.tsx";
import { Icon } from "./Icon.tsx";

/** A link to a page of the docs, which opens in the phone's browser. */
export function DocsLink({ href, label }: { readonly href: string; readonly label: string }) {
  return (
    <PressScale
      accessibilityRole="link"
      onPress={() => void Linking.openURL(href).catch(() => undefined)}
      className="min-h-11 flex-row items-center gap-1"
    >
      <Text className="text-sm text-muted-foreground underline">{label}</Text>
      <Icon icon={ExternalLink} size={12} color="accent-muted-foreground" />
    </PressScale>
  );
}
