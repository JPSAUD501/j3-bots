// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BotId, Notification, RoomId } from "@j3-bots/contracts";
import type { I18n } from "./i18n.ts";

/** What a notification says: whose it is, and what they wrote or need. */
export interface NotificationText {
  readonly title: string;
  readonly body: string;
}

/** The names a notification shows, or null for a bot or room that no longer exists. */
export interface NotificationNames {
  readonly botName: (id: BotId) => string | null;
  readonly roomName: (id: RoomId) => string | null;
}

/**
 * A notification as the operator reads it: from the bot, or from the room it
 * was said in, naming the bot. Without a preview it says only what kind of
 * thing arrived. Null for a bot or room that has no name any more, such as one
 * deleted since: there is nothing to open.
 */
export function notificationText(
  notification: Notification,
  names: NotificationNames,
  { t }: I18n,
): NotificationText | null {
  const name = names.botName(notification.botId);
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
      case "browser-help": {
        // Fixed words, never the bot's note (`Notification.browserHelp`).
        const help = notification.browserHelp;
        if (help === null) return t("notification.browserHelp");
        const step = t(`browserHelp.reason.${help.reason}`);
        return help.site === ""
          ? t("notification.browserHelpStep", { step })
          : t("notification.browserHelpStepOnSite", { step, site: help.site });
      }
      case "connector":
        // The two connector cards that notify: a sign-in the bot waits on, and
        // a service's question that holds the bot's call until it is answered.
        if (notification.connector === "input")
          return preview === null
            ? t("notification.connectorInput")
            : t("summary.connectorAsks", { name: preview });
        return preview === null
          ? t("notification.connectorSignIn")
          : t("summary.connectorSignIn", { name: preview });
      case "handoff":
        return preview === null
          ? t("notification.handoff")
          : t("summary.handoffSent", { text: preview });
    }
  })();
  const { target } = notification;
  if (target._tag === "conversation") return { title: name, body: text };
  const room = names.roomName(target.roomId);
  return room === null ? null : { title: room, body: t("summary.fromBot", { name, text }) };
}
