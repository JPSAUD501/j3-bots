// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotState, Notification } from "@j3-bots/contracts";
import type { AvatarLook } from "@j3-bots/design-tokens";

type AvatarMotion = "none" | "breathe" | "spin";

/** The mark inside the avatar's shape, how it moves, and the badge on its corner when the state concerns the operator. */
export interface AvatarAppearance extends AvatarLook {
  readonly motion: AvatarMotion;
}

/**
 * How the avatar shows a state. The mark alone tells every state apart, so the
 * avatar still reads when motion is off; motion only adds liveness. A turn the
 * server reports as stalled stops moving and breaks its ring, so "working"
 * and "stuck" never look the same. An idle bot with something the operator has
 * not read is done: a check, and the unread badge.
 */
export function avatarAppearance(state: BotState, unread: boolean): AvatarAppearance {
  switch (state._tag) {
    case "idle":
      return unread
        ? { mark: "check", motion: "none", badge: "unread" }
        : { mark: "dot", motion: "none", badge: null };
    case "thinking":
      return state.stalled ? STALLED : { mark: "ring", motion: "breathe", badge: null };
    case "working":
      return state.stalled ? STALLED : { mark: "arc", motion: "spin", badge: null };
    case "waiting":
      return { mark: "notch", motion: "none", badge: "waiting" };
    case "blocked":
      return { mark: "slash", motion: "none", badge: "blocked" };
  }
}

const STALLED: AvatarAppearance = { mark: "dotted", motion: "none", badge: null };

/**
 * How a bot's avatar shows, still, in a notification about one of its
 * entries: what the notification means to the operator. A card waits on
 * them, whatever state the roster has heard so far. A blocked bot shows it is
 * blocked, and one waiting on another card shows that. Anything else is
 * something the operator has not read, so the bot shows as done even while
 * its turn goes on: a still ring or arc would say nothing the notification does.
 */
export function notificationLook(
  notification: Pick<Notification, "kind" | "entryId">,
  state: BotState,
): AvatarLook {
  if (state._tag === "blocked" || state._tag === "waiting") return avatarAppearance(state, true);
  switch (notification.kind) {
    case "question":
    case "approval":
    case "secret-request":
      return avatarAppearance({ _tag: "waiting", entryId: notification.entryId }, true);
    case "message":
    case "handoff":
      return avatarAppearance({ _tag: "idle" }, true);
  }
}
