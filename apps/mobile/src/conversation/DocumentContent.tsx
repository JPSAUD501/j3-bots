// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Block,
  DocumentContent,
  DocumentImage,
  Run,
  Sheet,
  Slide,
} from "@j3-bots/client-runtime/documents";
import * as Base64 from "effect/encoding/Base64";
import { type ReactElement, useState } from "react";
import { FlatList, Image, Pressable, ScrollView, View } from "react-native";
import { useI18n } from "../i18n.ts";
import { Text } from "../text.tsx";

/**
 * A document as read, drawn with the app's own views: its text as text, its
 * tables as tables, its pictures from their bytes. Nothing of the file
 * becomes markup, a link or an address, so nothing in it runs or is fetched.
 * Long ones are lists, which draw only what is near the screen.
 */
export function DocumentContentView({
  content,
  header,
}: {
  readonly content: DocumentContent;
  /** What shows above the document, such as the line that says only its start shows. */
  readonly header: ReactElement | null;
}) {
  switch (content._tag) {
    case "text":
      return <TextList text={content.text} header={header} />;
    case "flow":
      return (
        <FlatList
          data={content.blocks}
          keyExtractor={keyOf}
          renderItem={({ item }) => <BlockView block={item} />}
          ListHeaderComponent={header ?? undefined}
          contentContainerClassName="gap-3 px-5 py-4"
          className="flex-1 bg-background"
        />
      );
    case "sheets":
      return <Sheets sheets={content.sheets} header={header} />;
    case "slides":
      return (
        <FlatList
          data={content.slides}
          keyExtractor={keyOf}
          renderItem={({ item, index }) => <SlideView slide={item} number={index + 1} />}
          ListHeaderComponent={header ?? undefined}
          contentContainerClassName="gap-4 p-3"
          className="flex-1"
        />
      );
  }
}

const keys = new WeakMap<object, string>();
let lastKey = 0;
/** A key for a part of a read document, which never changes once read: its identity. */
const keyOf = (part: object): string => {
  let key = keys.get(part);
  if (key === undefined) {
    lastKey += 1;
    key = String(lastKey);
    keys.set(part, key);
  }
  return key;
};

// The lines of a text drawn as one piece of the list.
const LINES_PER_PIECE = 60;

/** A plain text in pieces of lines, so a long one draws only what is near the screen. */
function TextList({
  text,
  header,
}: {
  readonly text: string;
  readonly header: ReactElement | null;
}) {
  const [pieces] = useState(() => {
    const lines = text.split("\n");
    return Array.from({ length: Math.ceil(lines.length / LINES_PER_PIECE) }, (_, at) => ({
      at,
      text: lines.slice(at * LINES_PER_PIECE, (at + 1) * LINES_PER_PIECE).join("\n"),
    }));
  });
  return (
    <FlatList
      data={pieces}
      keyExtractor={(piece) => String(piece.at)}
      renderItem={({ item }) => (
        <Text selectable face="mono" className="text-sm leading-relaxed text-foreground">
          {item.text}
        </Text>
      )}
      ListHeaderComponent={header ?? undefined}
      contentContainerClassName="px-4 py-4"
      className="flex-1 bg-background"
    />
  );
}

const HEADING_STYLES = [
  "text-2xl font-semibold",
  "text-xl font-semibold",
  "text-lg font-semibold",
  "text-base font-semibold",
  "text-sm font-semibold",
  "text-sm font-semibold text-muted-foreground",
] as const;

function BlockView({ block }: { readonly block: Block }) {
  switch (block._tag) {
    case "heading":
      return (
        <Text
          accessibilityRole="header"
          className={`mt-2 text-foreground ${HEADING_STYLES[block.level - 1] ?? ""}`}
        >
          <Runs runs={block.runs} />
        </Text>
      );
    case "paragraph":
      return (
        <Text selectable className="text-base leading-relaxed text-foreground">
          <Runs runs={block.runs} />
        </Text>
      );
    case "item":
      return (
        <View className="flex-row gap-2" style={{ paddingStart: block.depth * 20 }}>
          <Text className="min-w-4 text-end text-base text-muted-foreground">{block.marker}</Text>
          <Text selectable className="min-w-0 flex-1 text-base leading-relaxed text-foreground">
            <Runs runs={block.runs} />
          </Text>
        </View>
      );
    case "quote":
      return (
        <View className="border-s-2 border-border ps-3">
          <Text selectable className="text-base leading-relaxed text-muted-foreground">
            <Runs runs={block.runs} />
          </Text>
        </View>
      );
    case "code":
      return (
        <ScrollView horizontal nestedScrollEnabled className="rounded-md bg-muted">
          <Text selectable face="mono" className="p-3 text-sm leading-relaxed text-foreground">
            {block.text}
          </Text>
        </ScrollView>
      );
    case "table":
      return <BlockTable rows={block.rows} header={block.header} />;
    case "image":
      return <Picture image={block.image} alt={block.alt} />;
    case "rule":
      return <View className="my-2 h-px bg-border" />;
  }
}

function Runs({ runs }: { readonly runs: ReadonlyArray<Run> }) {
  return runs.map((run) => (
    <Text
      key={keyOf(run)}
      face={run.code ? "mono" : "text"}
      className={`${run.bold ? "font-semibold" : ""} ${run.italic ? "italic" : ""} ${run.code ? "bg-muted text-[0.9em]" : ""}`}
    >
      {run.text}
    </Text>
  ));
}

/** Column names for `count` columns, as a spreadsheet letters them; a row's cells are keyed by them. */
const columnNames = (count: number): ReadonlyArray<string> =>
  Array.from({ length: count }, (_, column) => {
    let name = "";
    for (let left = column + 1; left > 0; left = Math.floor((left - 1) / 26)) {
      name = String.fromCharCode(65 + ((left - 1) % 26)) + name;
    }
    return name;
  });

const CELL_WIDTH = 140;

function BlockTable({
  rows,
  header,
}: {
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  readonly header: boolean;
}) {
  const columns = columnNames(Math.max(0, ...rows.map((row) => row.length)));
  return (
    <ScrollView horizontal nestedScrollEnabled>
      <View className="border-s border-t border-border">
        {rows.map((row, at) => (
          <View key={keyOf(row)} className={`flex-row ${header && at === 0 ? "bg-muted" : ""}`}>
            {columns.map((name, column) => (
              <Text
                key={name}
                selectable
                style={{ width: CELL_WIDTH }}
                className={`border-e border-b border-border px-2 py-1 text-sm text-foreground ${header && at === 0 ? "font-semibold" : ""}`}
              >
                {row[column] ?? ""}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/** A picture of the document, drawn from its bytes, never from an address the file names. */
export function Picture({
  image,
  alt,
  height = 220,
}: {
  readonly image: DocumentImage;
  readonly alt: string;
  readonly height?: number;
}) {
  const { t } = useI18n();
  const [uri] = useState(() => `data:${image.mediaType};base64,${Base64.encode(image.bytes)}`);
  return (
    <Image
      source={{ uri }}
      accessibilityLabel={alt === "" ? t("document.picture") : alt}
      resizeMode="contain"
      style={{ width: "100%", height }}
      className="rounded-sm"
    />
  );
}

function Sheets({
  sheets,
  header,
}: {
  readonly sheets: ReadonlyArray<Sheet>;
  readonly header: ReactElement | null;
}) {
  const { t } = useI18n();
  const [shown, setShown] = useState(0);
  const sheet = sheets[shown] ?? sheets[0];
  if (sheet === undefined) return null;
  return (
    <View className="flex-1 gap-2">
      {header}
      {sheets.length > 1 && (
        <ScrollView
          horizontal
          accessibilityLabel={t("document.sheets")}
          accessibilityRole="tablist"
          contentContainerClassName="gap-1 px-2"
          className="max-h-11 shrink-0 grow-0"
        >
          {sheets.map((each, at) => (
            <Pressable
              key={keyOf(each)}
              accessibilityRole="tab"
              accessibilityState={{ selected: at === shown }}
              onPress={() => setShown(at)}
              className={`h-9 justify-center rounded-pill px-4 ${at === shown ? "bg-background" : "bg-viewer-pressed"}`}
            >
              <Text
                numberOfLines={1}
                className={`text-sm font-medium ${at === shown ? "text-foreground" : "text-viewer-foreground"}`}
              >
                {each.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <SheetGrid key={keyOf(sheet)} sheet={sheet} />
    </View>
  );
}

const ROW_NUMBER_WIDTH = 48;
const COLUMN_WIDTH = 112;

/**
 * A sheet as a spreadsheet shows it: lettered columns, numbered rows, each
 * cell on one line. It scrolls sideways as a whole and down as a list.
 */
export function SheetGrid({
  sheet,
  rows,
  compact = false,
}: {
  readonly sheet: Sheet;
  /** The most rows drawn, for a card; every row otherwise. */
  readonly rows?: number;
  readonly compact?: boolean;
}) {
  const columns = columnNames(compact ? Math.min(sheet.columns, 4) : sheet.columns);
  const width = compact ? 64 : COLUMN_WIDTH;
  const edge = "border-e border-b border-border bg-muted px-1 text-muted-foreground";
  const size = compact ? "text-[10px]" : "text-sm";
  const head = (
    <View className="flex-row">
      <View style={{ width: ROW_NUMBER_WIDTH / (compact ? 2 : 1) }} className={edge} />
      {columns.map((name) => (
        <Text key={name} style={{ width }} className={`${edge} ${size} text-center`}>
          {name}
        </Text>
      ))}
    </View>
  );
  const line = (row: ReadonlyArray<string>, at: number) => (
    <View key={keyOf(row)} className="flex-row bg-background">
      <Text
        style={{ width: ROW_NUMBER_WIDTH / (compact ? 2 : 1) }}
        className={`${edge} ${size} text-end`}
      >
        {at + 1}
      </Text>
      {columns.map((name, column) => (
        <Text
          key={name}
          numberOfLines={1}
          style={{ width }}
          className={`border-e border-b border-border px-1 ${size} text-foreground`}
        >
          {row[column] ?? ""}
        </Text>
      ))}
    </View>
  );
  if (rows !== undefined) {
    return (
      <View className="overflow-hidden border-s border-t border-border bg-background">
        {head}
        {sheet.rows.slice(0, rows).map(line)}
      </View>
    );
  }
  return (
    <ScrollView horizontal nestedScrollEnabled className="flex-1 bg-background">
      <FlatList
        data={sheet.rows}
        keyExtractor={keyOf}
        renderItem={({ item, index }) => line(item, index)}
        ListHeaderComponent={head}
        stickyHeaderIndices={[0]}
        className="border-s border-t border-border"
      />
    </ScrollView>
  );
}

function SlideView({ slide, number }: { readonly slide: Slide; readonly number: number }) {
  const { t } = useI18n();
  return (
    <View
      accessibilityLabel={t("document.slide", { number: String(number) })}
      className="gap-3 rounded-md bg-background px-5 py-4"
      style={{ minHeight: 200 }}
    >
      <Text className="text-2xs font-medium text-muted-foreground">{number}</Text>
      {slide.title !== null && (
        <Text accessibilityRole="header" className="text-xl font-semibold text-foreground">
          {slide.title}
        </Text>
      )}
      {slide.blocks.map((block) => (
        <BlockView key={keyOf(block)} block={block} />
      ))}
    </View>
  );
}
