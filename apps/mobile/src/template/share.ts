// SPDX-License-Identifier: AGPL-3.0-or-later
import { templateFileName } from "@j3-bots/client-runtime/presentation";
import {
  type BotId,
  type BotTemplate,
  TEMPLATE_MEDIA_TYPE,
  templateFileText,
} from "@j3-bots/contracts";
import { useNavigation } from "@react-navigation/native";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import type { Navigation } from "../navigation.tsx";

/** The folder in the app's cache the template being shared is written to. */
const shared = () => new Directory(Paths.cache, "templates");

/**
 * Hands the template to the system's share sheet as a `.j3bot` file, of the
 * template's media type, so an app that keeps it can open it in J3 Bots. The
 * file is written to the app's cache, over the one shared before: the
 * system clears it as it needs. Resolves whether the sheet opened.
 */
export async function sendTemplate(template: BotTemplate, title: string): Promise<boolean> {
  try {
    const folder = shared();
    folder.create({ intermediates: true, idempotent: true });
    const file = new File(folder, templateFileName(template.profile.name));
    file.create({ overwrite: true });
    await file.write(templateFileText(template));
    await Sharing.shareAsync(file.uri, { mimeType: TEMPLATE_MEDIA_TYPE, dialogTitle: title });
    return true;
  } catch {
    return false;
  }
}

/**
 * Shares a bot as a template: opens the screen that shows all the file will
 * hold, and ends in the system's share sheet.
 */
export function useShareBotTemplate(): (botId: BotId) => void {
  const navigation = useNavigation<Navigation>();
  return (botId) => navigation.navigate("shareTemplate", { botId });
}
