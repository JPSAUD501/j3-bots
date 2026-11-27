// SPDX-License-Identifier: AGPL-3.0-or-later
import { DOCUMENT_LIMITS } from "./limits.ts";
import { Refused } from "./text.ts";

/**
 * A reader of the XML that Word, Excel and PowerPoint files are made of, and
 * only of what they use: elements, attributes, text and CDATA. It refuses a
 * document type declaration, which these files never have, so no entity is
 * ever defined, expanded or fetched; it knows the five predefined entities
 * and character references, and leaves any other `&name;` as it is written.
 */

export type XmlEvent =
  | {
      readonly _tag: "open";
      readonly name: string;
      readonly attributes: ReadonlyMap<string, string>;
      readonly empty: boolean;
    }
  | { readonly _tag: "close"; readonly name: string }
  | { readonly _tag: "text"; readonly text: string };

const PREDEFINED: ReadonlyMap<string, string> = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
]);

const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi;

const character = (code: number, written: string) =>
  Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
    ? String.fromCodePoint(code)
    : written;

const unescapeXml = (text: string): string =>
  text.includes("&")
    ? text.replace(ENTITY, (written, name: string) => {
        if (name.startsWith("#x") || name.startsWith("#X")) {
          return character(Number.parseInt(name.slice(2), 16), written);
        }
        if (name.startsWith("#")) return character(Number.parseInt(name.slice(1), 10), written);
        return PREDEFINED.get(name) ?? written;
      })
    : text;

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributesOf(source: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE)) {
    const [, name, double, single] = match;
    if (name !== undefined) attributes.set(name, unescapeXml(double ?? single ?? ""));
  }
  return attributes;
}

/** The events of `source`, in order. A tag that never closes its `<` makes it unreadable. */
export function* xmlEvents(source: string): Generator<XmlEvent, void, undefined> {
  let at = 0;
  while (at < source.length) {
    const open = source.indexOf("<", at);
    if (open < 0) {
      const tail = source.slice(at);
      if (tail.trim() !== "") yield { _tag: "text", text: unescapeXml(tail) };
      return;
    }
    if (open > at) yield { _tag: "text", text: unescapeXml(source.slice(at, open)) };
    if (source.startsWith("<!--", open)) {
      at = closing(source, "-->", open + 4);
    } else if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      if (end < 0) throw new Refused({ reason: "unreadable" });
      yield { _tag: "text", text: source.slice(open + 9, end) };
      at = end + 3;
    } else if (source.startsWith("<?", open)) {
      at = closing(source, "?>", open + 2);
    } else if (source.startsWith("<!", open)) {
      // A document type declaration, the only way to define an entity.
      throw new Refused({ reason: "unreadable" });
    } else {
      const end = tagEnd(source, open + 1);
      const inside = source.slice(open + 1, end);
      at = end + 1;
      if (inside.startsWith("/")) {
        yield { _tag: "close", name: inside.slice(1).trim() };
        continue;
      }
      const empty = inside.endsWith("/");
      const body = empty ? inside.slice(0, -1) : inside;
      const space = body.search(/\s/);
      const name = space < 0 ? body : body.slice(0, space);
      if (name === "") throw new Refused({ reason: "unreadable" });
      yield {
        _tag: "open",
        name,
        attributes: space < 0 ? new Map() : attributesOf(body.slice(space)),
        empty,
      };
      if (empty) yield { _tag: "close", name };
    }
  }
}

const closing = (source: string, marker: string, from: number) => {
  const end = source.indexOf(marker, from);
  if (end < 0) throw new Refused({ reason: "unreadable" });
  return end + marker.length;
};

/** Where the tag that starts at `from` ends: its `>`, outside quoted attribute values. */
function tagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let at = from; at < source.length; at++) {
    const char = source[at];
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return at;
    }
  }
  throw new Refused({ reason: "unreadable" });
}

/** An element of a part, and what is in it. */
export interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: ReadonlyArray<XmlElement | string>;
}

/**
 * `source` as a tree of elements, at most `elements` of them (a part with
 * more is too big). Its root is the first element; closing tags that do not
 * match make it unreadable.
 */
export function xmlTree(source: string): XmlElement {
  interface Building {
    readonly name: string;
    readonly attributes: ReadonlyMap<string, string>;
    readonly children: Array<XmlElement | string>;
  }
  const stack: Array<Building> = [];
  let root: Building | null = null;
  let count = 0;
  for (const event of xmlEvents(source)) {
    switch (event._tag) {
      case "open": {
        count += 1;
        if (count > DOCUMENT_LIMITS.elements) throw new Refused({ reason: "tooBig" });
        const element: Building = { name: event.name, attributes: event.attributes, children: [] };
        const parent = stack.at(-1);
        if (parent !== undefined) parent.children.push(element);
        else if (root === null) root = element;
        else throw new Refused({ reason: "unreadable" });
        stack.push(element);
        break;
      }
      case "close":
        if (stack.pop()?.name !== event.name) throw new Refused({ reason: "unreadable" });
        break;
      case "text":
        stack.at(-1)?.children.push(event.text);
        break;
    }
  }
  if (root === null || stack.length > 0) throw new Refused({ reason: "unreadable" });
  return root;
}

/** The elements directly in `element` named `name`. */
export const childrenNamed = (element: XmlElement, name: string): ReadonlyArray<XmlElement> =>
  element.children.filter(
    (child): child is XmlElement => typeof child !== "string" && child.name === name,
  );

/** The first element directly in `element` named `name`. */
export const childNamed = (element: XmlElement, name: string): XmlElement | undefined =>
  element.children.find(
    (child): child is XmlElement => typeof child !== "string" && child.name === name,
  );

/** The element at the end of `path`, one child name per step. */
export const pathOf = (
  element: XmlElement,
  ...path: ReadonlyArray<string>
): XmlElement | undefined =>
  path.reduce<XmlElement | undefined>(
    (at, name) => (at === undefined ? undefined : childNamed(at, name)),
    element,
  );

/** The elements anywhere in `element`, in document order, named `name`; not inside one another's match. */
export function descendantsNamed(element: XmlElement, name: string): ReadonlyArray<XmlElement> {
  const found: Array<XmlElement> = [];
  const walk = (at: XmlElement) => {
    for (const child of at.children) {
      if (typeof child === "string") continue;
      if (child.name === name) found.push(child);
      else walk(child);
    }
  };
  walk(element);
  return found;
}

/** The text of every `t`-like element (`textName`) in `element`, in order. */
export function textOf(element: XmlElement, textName: string): string {
  let text = "";
  const walk = (at: XmlElement) => {
    for (const child of at.children) {
      if (typeof child === "string") {
        if (at.name === textName) text += child;
      } else {
        walk(child);
      }
    }
  };
  walk(element);
  return text;
}

/**
 * The relationships of a part, by id: each target resolved from the part
 * (`resolvePart`), or null where it leads outside the zip.
 */
export interface Relationship {
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
}

export function relationshipsOf(source: string | null): ReadonlyMap<string, Relationship> {
  const found = new Map<string, Relationship>();
  if (source === null) return found;
  for (const element of childrenNamed(xmlTree(source), "Relationship")) {
    const id = element.attributes.get("Id");
    const target = element.attributes.get("Target");
    if (id === undefined || target === undefined) continue;
    found.set(id, {
      type: element.attributes.get("Type") ?? "",
      target,
      external: element.attributes.get("TargetMode") === "External",
    });
  }
  return found;
}

/** The part a part's relationships are kept in: `word/document.xml` has `word/_rels/document.xml.rels`. */
export const relationshipsPart = (part: string): string => {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
};
