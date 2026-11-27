// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AndroidHaptics,
  ImpactFeedbackStyle,
  impactAsync,
  performAndroidHapticsAsync,
} from "expo-haptics";
import { Platform } from "react-native";

/**
 * The tick a long press gives as it opens a menu. On Android it is the
 * system's own long-press feedback, which follows the phone's touch-feedback
 * setting and needs no permission; on iOS, a medium impact.
 */
export const feelLongPress = (): void => {
  void (Platform.OS === "android"
    ? performAndroidHapticsAsync(AndroidHaptics.Long_Press)
    : impactAsync(ImpactFeedbackStyle.Medium));
};

/**
 * The light tick a swiped message gives as it goes far enough that letting go
 * replies to it: on Android the system's segment tick, on iOS a light impact.
 */
export const feelSwipeReply = (): void => {
  void (Platform.OS === "android"
    ? performAndroidHapticsAsync(AndroidHaptics.Segment_Tick)
    : impactAsync(ImpactFeedbackStyle.Light));
};
