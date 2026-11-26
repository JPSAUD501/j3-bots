// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GestureResponderEvent } from "react-native";
import { makeMutable } from "react-native-reanimated";

/**
 * A finger on the screen, for the avatars: where it is now and where it came
 * down, in the window's px, and whether it is still down. On a phone it stands
 * for the pointer: an avatar looks at a finger that is close to it, goes down
 * under one that lands on it, and answers when it lifts. The avatars read it
 * on the UI thread, in the frame they already run.
 */
export const finger = makeMutable({ x: 0, y: 0, startX: 0, startY: 0, down: false });

const moved = ({ nativeEvent }: GestureResponderEvent) => {
  const { startX, startY } = finger.get();
  finger.set({ x: nativeEvent.pageX, y: nativeEvent.pageY, startX, startY, down: true });
};

const lifted = () => finger.set({ ...finger.get(), down: false });

/**
 * What the app's outermost view takes to follow the finger. These listen to
 * every touch without claiming any, so whatever is pressed still gets it.
 */
export const fingerWatch = {
  onTouchStart: ({ nativeEvent }: GestureResponderEvent) => {
    const { pageX: x, pageY: y } = nativeEvent;
    finger.set({ x, y, startX: x, startY: y, down: true });
  },
  onTouchMove: moved,
  onTouchEnd: lifted,
  onTouchCancel: lifted,
} as const;
