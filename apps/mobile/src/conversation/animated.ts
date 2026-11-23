// SPDX-License-Identifier: AGPL-3.0-or-later
import Animated from "react-native-reanimated";
import { withUniwind } from "uniwind";

/** Reanimated's view, styled by `className` as the app's other views are. */
export const AnimatedView = withUniwind(Animated.View);
