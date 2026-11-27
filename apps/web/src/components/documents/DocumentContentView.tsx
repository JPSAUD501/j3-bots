// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  Block,
  DocumentContent,
  DocumentImage,
  Run,
  Sheet,
  Slide,
} from "@j3-bots/client-runtime/documents";
import { Tabs } from "@base-ui/react/tabs";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useI18n } from "../../app/context";
import { cn } from "../../lib/cn";

/**
 * A document as read, drawn with the app's own elements: its text as text,
 * its tables as tables, its pictures from their bytes. Nothing of the file
 * becomes markup, a style, a link or an address, so nothing in it runs or is
 * fetched.
 */
export function DocumentContentView({ content }: { content: DocumentContent }) {
  switch (content._tag) {
    case "text":
      return (
        <Paper>
          <pre className="font-mono text-sm leading-relaxed break-words whitespace-pre-wrap">
            {content.text}
          </pre>
        </Paper>
      );
    case "flow":
      return (
        <Paper>
          <Blocks blocks={content.blocks} />
        </Paper>
      );
    case "sheets":
      return <Sheets sheets={content.sheets} />;
    case "slides":
      return <Slides slides={content.slides} />;
  }
}

/** A page of the document's own: the theme's background, a column wide enough to read. */
function Paper({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl rounded-md bg-background px-5 py-6 text-foreground shadow-overlay sm:px-10 sm:py-10">
      {children}
    </div>
  );
}

const keys = new WeakMap<object, number>();
let lastKey = 0;
/** A key for a part of a read document, which never changes once read: its identity. */
const keyOf = (part: object): number => {
  let key = keys.get(part);
  if (key === undefined) {
    lastKey += 1;
    key = lastKey;
    keys.set(part, key);
  }
  return key;
};

// How many blocks or rows are drawn at first, and added each time the end comes near.
const STEP = 200;

/**
 * How many of `total` items to draw: a first `STEP`, and `STEP` more each
 * time `end` comes within a screen of the view, so a long document opens at
 * once.
 */
function useProgressive(total: number) {
  const [shown, setShown] = useState(Math.min(total, STEP));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = end.current;
    if (target === null || shown >= total) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown((now) => Math.min(now + STEP, total));
        }
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [shown, total]);
  return {
    shown: Math.min(shown, total),
    end: shown < total ? <div ref={end} aria-hidden className="h-px" /> : null,
  };
}

export function Blocks({
  blocks,
  compact = false,
}: {
  blocks: ReadonlyArray<Block>;
  compact?: boolean;
}) {
  const { shown, end } = useProgressive(blocks.length);
  return (
    <div className={cn("flex flex-col", compact ? "gap-1.5" : "gap-3")}>
      {blocks.slice(0, shown).map((block) => (
        <BlockView key={keyOf(block)} block={block} />
      ))}
      {end}
    </div>
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

function BlockView({ block }: { block: Block }) {
  switch (block._tag) {
    case "heading":
      return (
        <div
          role="heading"
          aria-level={Math.min(block.level + 2, 6)}
          className={cn("mt-2 text-balance", HEADING_STYLES[block.level - 1])}
        >
          <Runs runs={block.runs} />
        </div>
      );
    case "paragraph":
      return (
        <p className="break-words whitespace-pre-wrap">
          <Runs runs={block.runs} />
        </p>
      );
    case "item":
      return (
        <div className="flex gap-2" style={{ paddingInlineStart: `${block.depth * 1.25}rem` }}>
          <span className="min-w-4 shrink-0 text-end text-muted-foreground tabular-nums">
            {block.marker}
          </span>
          <span className="min-w-0 break-words whitespace-pre-wrap">
            <Runs runs={block.runs} />
          </span>
        </div>
      );
    case "quote":
      return (
        <blockquote className="border-s-2 border-border ps-3 break-words whitespace-pre-wrap text-muted-foreground">
          <Runs runs={block.runs} />
        </blockquote>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-sm leading-relaxed">
          {block.text}
        </pre>
      );
    case "table":
      return <BlockTable rows={block.rows} header={block.header} />;
    case "image":
      return <Picture image={block.image} alt={block.alt} />;
    case "rule":
      return <hr className="my-2 border-border" />;
  }
}

function Runs({ runs }: { runs: ReadonlyArray<Run> }) {
  return runs.map((run) => {
    const key = keyOf(run);
    const text = run.code ? (
      <code className="rounded-sm bg-muted px-1 font-mono text-[0.9em]">{run.text}</code>
    ) : (
      run.text
    );
    const leaning = run.italic ? <em>{text}</em> : text;
    return run.bold ? <strong key={key}>{leaning}</strong> : <span key={key}>{leaning}</span>;
  });
}

/** Column names for `count` columns: the cells of a row are keyed by them. */
const columnNames = (count: number): ReadonlyArray<string> =>
  Array.from({ length: count }, (_, column) => {
    let name = "";
    for (let left = column + 1; left > 0; left = Math.floor((left - 1) / 26)) {
      name = String.fromCharCode(65 + ((left - 1) % 26)) + name;
    }
    return name;
  });

function BlockTable({
  rows,
  header,
}: {
  rows: ReadonlyArray<ReadonlyArray<string>>;
  header: boolean;
}) {
  const columns = columnNames(Math.max(0, ...rows.map((row) => row.length)));
  const [head, ...body] = rows;
  const cell = "border border-border px-2 py-1 align-top break-words whitespace-pre-wrap";
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {header && head !== undefined && (
          <thead>
            <tr>
              {columns.map((name, column) => (
                <th key={name} className={cn(cell, "bg-muted text-start font-semibold")}>
                  {head[column] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {(header ? body : rows).map((row) => (
            <tr key={keyOf(row)}>
              {columns.map((name, column) => (
                <td key={name} className={cell}>
                  {row[column] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A picture of the document, drawn from its bytes, never from an address the file names. */
export function Picture({
  image,
  alt,
  className,
}: {
  image: DocumentImage;
  alt: string;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <img
      alt={alt === "" ? t("document.picture") : alt}
      className={cn("mx-auto max-h-[70vh] max-w-full rounded-sm object-contain", className)}
      ref={(element) => {
        if (element === null) return;
        const url = URL.createObjectURL(new Blob([image.bytes.slice()], { type: image.mediaType }));
        element.src = url;
        return () => URL.revokeObjectURL(url);
      }}
    />
  );
}

function Sheets({ sheets }: { sheets: ReadonlyArray<Sheet> }) {
  const { t } = useI18n();
  const [first] = sheets;
  if (first === undefined) return null;
  if (sheets.length === 1) return <SheetGrid sheet={first} />;
  return (
    <Tabs.Root defaultValue={0} className="flex min-h-0 w-full flex-col gap-2">
      <Tabs.List
        aria-label={t("document.sheets")}
        className="flex shrink-0 gap-1 overflow-x-auto rounded-pill bg-viewer-pressed p-1"
      >
        {sheets.map((sheet, at) => (
          <Tabs.Tab
            key={keyOf(sheet)}
            value={at}
            className="pressable h-8 shrink-0 cursor-pointer rounded-pill px-3 text-sm font-medium whitespace-nowrap text-viewer-muted-foreground outline-none hover:text-viewer-foreground focus-visible:outline-2 focus-visible:outline-accent data-active:bg-background data-active:text-foreground"
          >
            {sheet.name}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {sheets.map((sheet, at) => (
        <Tabs.Panel key={keyOf(sheet)} value={at} className="min-h-0">
          <SheetGrid sheet={sheet} />
        </Tabs.Panel>
      ))}
    </Tabs.Root>
  );
}

/** A sheet as a spreadsheet shows it: lettered columns, numbered rows, cells on one line each. */
export function SheetGrid({ sheet, compact = false }: { sheet: Sheet; compact?: boolean }) {
  const { shown, end } = useProgressive(sheet.rows.length);
  const columns = columnNames(sheet.columns);
  const edge = "border border-border px-2 text-muted-foreground bg-muted font-normal tabular-nums";
  return (
    <div className="w-full overflow-auto rounded-md bg-background text-foreground shadow-overlay">
      <table className={cn("border-collapse", compact ? "text-[0.625rem]" : "text-sm")}>
        <thead className="sticky top-0 z-10">
          <tr>
            <th aria-hidden className={cn(edge, "sticky start-0 z-10")} />
            {columns.map((name) => (
              <th key={name} scope="col" className={cn(edge, "py-0.5 text-center")}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.slice(0, shown).map((row, at) => (
            <tr key={keyOf(row)}>
              <th scope="row" className={cn(edge, "sticky start-0 py-0.5 text-end")}>
                {at + 1}
              </th>
              {columns.map((name, column) => (
                <td
                  key={name}
                  title={(row[column]?.length ?? 0) > 40 ? row[column] : undefined}
                  className={cn(
                    "max-w-72 truncate border border-border px-2 py-0.5 whitespace-pre",
                    compact && "max-w-24",
                  )}
                >
                  {row[column]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {end}
    </div>
  );
}

function Slides({ slides }: { slides: ReadonlyArray<Slide> }) {
  const { t } = useI18n();
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {slides.map((slide, at) => (
        <section
          key={keyOf(slide)}
          aria-label={t("document.slide", { number: String(at + 1) })}
          className="flex aspect-video min-h-fit flex-col gap-3 rounded-md bg-background px-6 py-5 text-foreground shadow-overlay sm:px-10 sm:py-8"
        >
          <p className="text-2xs font-medium text-muted-foreground tabular-nums">{at + 1}</p>
          {slide.title !== null && (
            <div role="heading" aria-level={3} className="text-xl font-semibold text-balance">
              {slide.title}
            </div>
          )}
          <Blocks blocks={slide.blocks} compact />
        </section>
      ))}
    </div>
  );
}
