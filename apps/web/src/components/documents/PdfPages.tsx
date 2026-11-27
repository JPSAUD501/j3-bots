// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PDFDocumentProxy } from "pdfjs-dist";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useI18n } from "../../app/context";
import { shownPages } from "./documents";
import { drawPage, pageShape } from "./pdf";

/** A PDF page's shape before its own is known: A4 upright. */
const A4 = Math.SQRT2;
/** The widest a page is drawn, in CSS pixels. */
const MAX_PAGE_WIDTH = 900;

/** The width `frame` gives its content, as it changes. */
function useWidth(frame: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame]);
  return width;
}

/**
 * A PDF's pages, one under the other, as wide as the view lets them be. A
 * page is drawn as it comes near the view and let go of as it leaves it far
 * behind, so a long document holds only a few pages' pixels at a time.
 */
export function PdfPages({ pdf }: { pdf: PDFDocumentProxy }) {
  const frame = useRef<HTMLDivElement>(null);
  const width = Math.min(useWidth(frame), MAX_PAGE_WIDTH);
  const [shape, setShape] = useState(A4);
  useEffect(() => {
    let current = true;
    void pdf
      .getPage(1)
      .then((page) => {
        if (current) setShape(pageShape(page));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [pdf]);
  const pages = Array.from({ length: shownPages(pdf).count }, (_, at) => at + 1);
  return (
    <div ref={frame} className="flex w-full flex-col items-center gap-3">
      {width > 0 &&
        pages.map((number) => (
          <PdfPage key={number} pdf={pdf} number={number} width={width} shape={shape} />
        ))}
    </div>
  );
}

function PdfPage({
  pdf,
  number,
  width,
  shape,
}: {
  pdf: PDFDocumentProxy;
  number: number;
  width: number;
  shape: number;
}) {
  const { t } = useI18n();
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [ownShape, setOwnShape] = useState<number | null>(null);
  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry !== undefined) setNear(entry.isIntersecting);
      },
      { rootMargin: "150% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const target = canvas.current;
    if (!near || target === null) return;
    const controller = new AbortController();
    void pdf
      .getPage(number)
      .then((page) => {
        setOwnShape(pageShape(page));
        return drawPage(page, target, width, controller.signal);
      })
      .catch(() => {
        // A page that fails to draw stays blank; the others still show.
      });
    return () => {
      controller.abort();
      // Its pixels go as it leaves; it is drawn again when it comes back.
      target.width = 0;
      target.height = 0;
    };
  }, [near, pdf, number, width]);
  return (
    <div
      ref={holder}
      style={{ width, height: Math.round(width * (ownShape ?? shape)) }}
      className="shrink-0 overflow-hidden rounded-sm bg-white shadow-overlay"
    >
      <canvas
        ref={canvas}
        role="img"
        aria-label={t("document.page", { number: String(number) })}
        className="size-full"
      />
    </div>
  );
}

/**
 * The top of a PDF's first page, `width` CSS pixels wide, for its card. It
 * is drawn once, as the card shows.
 */
export function PdfThumbnail({ pdf, width }: { pdf: PDFDocumentProxy; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (target === null) return;
    const controller = new AbortController();
    void pdf
      .getPage(1)
      .then((page) => drawPage(page, target, width, controller.signal))
      .catch(() => {});
    return () => controller.abort();
  }, [pdf, width]);
  return <canvas ref={canvas} aria-hidden className="block w-full bg-white" />;
}
