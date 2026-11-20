// SPDX-License-Identifier: AGPL-3.0-or-later

/** The most an approval's detail carries, as `ApprovalEntry.detail` allows. */
const MAX_DETAIL = 20_000;

/**
 * What an approval card shows under its action, from the engine's prompt and
 * reason: everything they say past the action, and never the action again.
 * The action is one line taken from the title or the prompt, so a prompt that
 * starts with it gives only its later lines; a first line cut short to fit the
 * action stays whole here. Trimmed, as the contract requires; null when
 * nothing is left.
 */
export function approvalDetail(
  action: string,
  texts: ReadonlyArray<string | undefined>,
): string | null {
  const parts = texts.flatMap((text) => {
    const trimmed = text?.trim() ?? "";
    const [first = "", ...rest] = trimmed.split("\n");
    const remainder = first.trim() === action ? rest.join("\n").trim() : trimmed;
    return remainder === "" ? [] : [remainder];
  });
  const detail = [...new Set(parts)].join("\n\n").slice(0, MAX_DETAIL).trimEnd();
  return detail === "" ? null : detail;
}
