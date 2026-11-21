// SPDX-License-Identifier: AGPL-3.0-or-later
import { layout } from "@j3-bots/design-tokens";
import { useWindowDimensions } from "react-native";

/**
 * Whether the roster and a conversation sit side by side: from the tablet
 * width up, as on an unfolded foldable. Below it, one shows at a time.
 */
export const useSideBySide = (): boolean =>
  useWindowDimensions().width >= layout.breakpoints.tablet;
