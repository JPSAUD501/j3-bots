// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  isTemplateFileName,
  readTemplateFile,
  templateFileTooLarge,
} from "@j3-bots/client-runtime/presentation";
import { useEffect, useEffectEvent } from "react";
import type { TemplateOpened } from "../components/TemplateDialogs";

/**
 * Reads a file the operator picked or dropped as a template: one over the
 * limit is refused before its text is read.
 */
export const readTemplate = (file: File): Promise<TemplateOpened> =>
  templateFileTooLarge(file.size)
    ? Promise.resolve({ _tag: "too-large" })
    : file.text().then(readTemplateFile, (): TemplateOpened => ({ _tag: "unreadable" }));

/**
 * A template file dropped anywhere on the page opens as one: `onTemplate`
 * gets it, and the composer under it never takes it as an attachment. Any
 * other file dropped where nothing takes it is ignored, so the page never
 * leaves for it.
 */
export function useTemplateDrop(onTemplate: (file: File) => void): void {
  const take = useEffectEvent(onTemplate);
  useEffect(() => {
    const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
    const over = (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const dropTemplate = (event: DragEvent) => {
      const files = event.dataTransfer?.files;
      const file = files?.length === 1 ? files[0] : undefined;
      if (file === undefined || !isTemplateFileName(file.name)) return;
      event.preventDefault();
      event.stopPropagation();
      take(file);
    };
    const dropElsewhere = (event: DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", dropTemplate, { capture: true });
    window.addEventListener("drop", dropElsewhere);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", dropTemplate, { capture: true });
      window.removeEventListener("drop", dropElsewhere);
    };
  }, []);
}
