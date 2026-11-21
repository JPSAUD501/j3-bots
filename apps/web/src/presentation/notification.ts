// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Notification, RoomId } from "@j3-bots/contracts";
import type { PresentationContext } from "./roster";

/** What a notification says: whose it is, and what they wrote or need. */
export interface NotificationContent {
  readonly title: string;
  readonly body: string;
}

/**
 * A notification as the operator reads it: from the bot, or from the room it
 * was said in, naming the bot. Without a preview it says only what kind of
 * thing arrived. Null for a bot or room this window no longer lists, such as
 * one deleted since: there is nothing to open.
 */
export function notificationContent(
  notification: Notification,
  ctx: PresentationContext,
  roomName: (roomId: RoomId) => string | null,
): NotificationContent | null {
  const { t } = ctx.i18n;
  const name = ctx.botName(notification.botId);
  if (name === null) return null;
  const { preview } = notification;
  const text = (() => {
    switch (notification.kind) {
      case "message":
        return preview ?? t("notification.message");
      case "question":
        return preview === null
          ? t("notification.question")
          : t("summary.asks", { prompt: preview });
      case "approval":
        return preview === null
          ? t("notification.approval")
          : t("summary.needsApproval", { action: preview });
      case "secret-request":
        return preview === null
          ? t("notification.secret")
          : t("summary.needsSecret", { label: preview });
      case "handoff":
        return preview === null
          ? t("notification.handoff")
          : t("summary.handoffSent", { text: preview });
    }
  })();
  const { target } = notification;
  if (target._tag === "conversation") return { title: name, body: text };
  const room = roomName(target.roomId);
  return room === null ? null : { title: room, body: t("summary.fromBot", { name, text }) };
}
