// SPDX-License-Identifier: AGPL-3.0-or-later
// Adapted from T3 Code v0.1.13, apps/server/src/preview/ServerBrowserPage.ts (MIT License,
// Copyright (c) 2026 T3 Tools Inc.; see this package's NOTICE): `withoutDataPayload`, the
// tree's `data:` redaction, `DOTTED_SCRIPT`, `dottedPattern` and `maskTree`.

/** What a hidden value shows as in a snapshot. */
export const MASKED_VALUE = "••••••••";

/**
 * A `data:` address carries its content, which can be a whole file. Keeps
 * only its media type, read as a browser reads the scheme: past leading
 * controls and spaces, and with tabs and newlines anywhere removed. A value
 * a snapshot quotes and escapes is read unescaped.
 */
export const withoutDataPayload = (url: string): string => {
  const value = url
    .replace(/^["']/, "")
    .replace(/\\(x[\da-f]{2}|u[\da-f]{4}|.)/gi, (_escape, code: string) =>
      code.length > 1
        ? String.fromCharCode(Number.parseInt(code.slice(1), 16))
        : ({ t: "\t", n: "\n", r: "\r", '"': '"', "\\": "\\" }[code] ?? "\u0001"),
    )
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\u0000-\u0020]+/, "");
  const parsed = /^data:([^,;]*)/i.exec(value);
  if (parsed === null) return url;
  const type = (parsed[1] ?? "").trim();
  const mediaType = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/.test(type) ? type : "";
  return `data:${mediaType},…`;
};

/**
 * The tree with every link's `data:` payload removed. Split on LF alone, so
 * a value keeps a U+2028 a multiline pattern would take for a line end.
 */
export const withoutTreeDataPayloads = (tree: string): string =>
  tree
    .split("\n")
    .map((line) => {
      const url = /^(\s*- \/url: )(.*)$/s.exec(line);
      return url === null ? line : `${url[1] ?? ""}${withoutDataPayload(url[2] ?? "")}`;
    })
    .join("\n");

/**
 * Run in an isolated world of each frame: the values of password fields and
 * of fields or editable text the page hides behind dots, in open shadow
 * roots too, raw and normalized as accessible text is.
 */
export const DOTTED_SCRIPT = `(() => {
  const values = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
      const field = element.localName === "input" || element.localName === "textarea";
      if (!field && !element.isContentEditable) continue;
      const dots = getComputedStyle(element).getPropertyValue("-webkit-text-security");
      if (element.type !== "password" && (dots === "none" || dots === "")) continue;
      for (const value of field ? [element.value, element.defaultValue] : [element.textContent ?? ""])
        values.push(value, value.replace(/[\\u200b\\u00ad]/g, "").trim().replace(/\\s+/g, " "));
    }
  };
  visit(document);
  return [...new Set(values.filter((value) => value.trim()))];
})()`;

/**
 * One pattern matching every form the values may take in a snapshot: as
 * they are, JSON-escaped, quoted as Playwright quotes, with `'` doubled.
 * A value under four characters must stand as a word of its own, so it does
 * not hide unrelated text. `too-long` when a value is too long to match,
 * which leaves nothing safe to show.
 */
export const dottedPattern = (
  values: ReadonlyArray<string>,
):
  | { readonly _tag: "none" }
  | { readonly _tag: "pattern"; readonly pattern: RegExp }
  | {
      readonly _tag: "too-long";
    } => {
  const sources = values
    .flatMap((value) => {
      const json = JSON.stringify(value).slice(1, -1);
      // Playwright writes control characters as JSON does, with \xNN for the unnamed ones.
      const quoted = value.replace(/[\\"\p{Cc}]/gu, (char) =>
        '\\"\b\f\n\r\t'.includes(char)
          ? JSON.stringify(char).slice(1, -1)
          : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
      );
      const forms = [value, json, quoted].flatMap((form) => [form, form.replaceAll("'", "''")]);
      return [...new Set(forms)].map((form) => ({ form, word: value.length < 4 }));
    })
    // Longest first, so a form inside another never leaves the rest showing.
    .toSorted((a, b) => b.form.length - a.form.length)
    .map(({ form, word }) => {
      const literal = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return word ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal;
    });
  if (sources.length === 0) return { _tag: "none" };
  try {
    const pattern = new RegExp(sources.join("|"), "gu");
    // Compile now for one-byte and two-byte strings, so a size error shows here.
    pattern.test("");
    pattern.test("\u2022");
    return { _tag: "pattern", pattern };
  } catch {
    return { _tag: "too-long" };
  }
};

// Playwright single-quotes keys holding ': ' and leaves /.../ names unquoted. Only its own
// attributes are recognized, so a name's text cannot pass for one.
const TREE_LINE =
  /^(\s*- '?[^\s"':]+)( "(?:[^"\\]|\\.)*"| \/(?:.*?\/)?)?((?: \[(?:active|checked(?:=mixed)?|disabled|expanded|level=\d+|pressed(?:=mixed)?|selected|ref=(?:f\d+)?e\d+|cursor=pointer|box=-?\d+,-?\d+,\d+,\d+)\])*'?)(:.*)?$/;

/**
 * The tree with every hidden value masked, except inside a line's role and
 * its attributes, so refs keep working.
 */
export const maskTree = (tree: string, dotted: RegExp): string =>
  tree
    .split("\n")
    .map((line) => {
      const node = TREE_LINE.exec(line);
      const name = node?.[1]?.length ?? 0;
      const attributes = name + (node?.[2]?.length ?? 0);
      const end = attributes + (node?.[3]?.length ?? 0);
      const kept = (from: number, to: number) => to <= name || (from >= attributes && to <= end);
      return line.replace(dotted, (match: string, offset: number) =>
        kept(offset, offset + match.length) ? match : MASKED_VALUE,
      );
    })
    .join("\n");

/** Text with every hidden value masked. */
export const maskText = (text: string, dotted: RegExp): string =>
  text.replace(dotted, MASKED_VALUE);
