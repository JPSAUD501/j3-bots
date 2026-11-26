// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConnectorPrompt, PromptArguments } from "@j3-bots/contracts";
import { FILE_MARK } from "../files/placed.ts";

/** A prompt the `/` menu offers, with the name of the connector whose server writes it. */
export interface PromptOption extends ConnectorPrompt {
  readonly connector: string;
}

const SLASH = new RegExp(`^/([^\\s${FILE_MARK}]*)$`, "u");

/**
 * What the operator typed after `/` when the whole draft is a `/` and one
 * word: the `/` menu filters its prompts by it. Null for any other draft,
 * which the menu leaves alone.
 */
export function promptQuery(text: string): string | null {
  return SLASH.exec(text)?.[1] ?? null;
}

/**
 * The prompts whose name, title or connector holds `query`, ignoring case,
 * in the order the server gave them.
 */
export function promptOptions(
  query: string,
  prompts: ReadonlyArray<PromptOption>,
): ReadonlyArray<PromptOption> {
  const wanted = query.toLocaleLowerCase();
  return prompts.filter((prompt) =>
    [prompt.name, prompt.title ?? "", prompt.connector].some((text) =>
      text.toLocaleLowerCase().includes(wanted),
    ),
  );
}

/**
 * The arguments the operator filled in, as the prompt's server takes them:
 * those left empty are left out. Null while a required one is empty.
 */
export function promptArguments(
  prompt: ConnectorPrompt,
  drafts: Readonly<Record<string, string>>,
): PromptArguments | null {
  const given: Record<string, string> = {};
  for (const argument of prompt.arguments) {
    const value = drafts[argument.name]?.trim() ?? "";
    if (value === "") {
      if (argument.required) return null;
      continue;
    }
    given[argument.name] = value;
  }
  return given;
}
