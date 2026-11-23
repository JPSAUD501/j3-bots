// SPDX-License-Identifier: AGPL-3.0-or-later
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../app/context";
import { cn } from "../lib/cn";
import { Button } from "./ui/button";

/** How long the button says Copied before it offers Copy again, in ms. */
const COPIED_FOR = 2000;

/**
 * A shell command, wrapped so it reads in full on any width, with a button
 * pinned to its top corner that copies it. Where the page has no clipboard
 * (served over plain HTTP on the local network) or the browser refuses, the
 * button selects the command and says, in words and to screen readers, to
 * copy it by hand. A copy says Copied for a moment, then the button offers
 * Copy again. `large` is for a screen the command is the point of: larger
 * type, and the button says Copy in words.
 */
export function CommandLine({
  command,
  copyLabel,
  large = false,
}: {
  command: string;
  copyLabel: string;
  large?: boolean;
}) {
  const { t } = useI18n();
  // What the last press did, numbered: each press is a new outcome, so a second Copy holds Copied
  // for its own moment, and the sentence is a new one, announced again.
  const [outcome, setOutcome] = useState<{
    readonly result: "none" | "copied" | "selected";
    readonly press: number;
  }>({ result: "none", press: 0 });
  const { result } = outcome;
  const codeRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (outcome.result !== "copied") return;
    const done = window.setTimeout(
      () => setOutcome((now) => ({ ...now, result: "none" })),
      COPIED_FOR,
    );
    return () => window.clearTimeout(done);
  }, [outcome]);
  const select = (press: number) => {
    if (codeRef.current) window.getSelection()?.selectAllChildren(codeRef.current);
    setOutcome({ result: "selected", press });
  };
  const copy = () => {
    const press = outcome.press + 1;
    if (!("clipboard" in navigator)) {
      select(press);
      return;
    }
    navigator.clipboard.writeText(command).then(
      () => setOutcome({ result: "copied", press }),
      () => select(press),
    );
  };
  return (
    <span className="flex flex-col">
      <span
        className={cn(
          "flex items-start gap-1 rounded-md bg-code-background ps-2.5",
          large && "items-center gap-2 py-1.5 ps-3.5 pe-1.5",
        )}
      >
        <code
          ref={codeRef}
          className={cn(
            "min-w-0 flex-1 py-1.5 font-mono text-xs whitespace-pre-wrap wrap-anywhere",
            large && "text-sm",
          )}
        >
          {command}
        </code>
        {large ? (
          <Button
            variant="outline"
            aria-label={result === "copied" ? t("firstRun.connect.copied") : copyLabel}
            onClick={copy}
          >
            {result === "copied" ? <CheckIcon /> : <CopyIcon />}
            {result === "copied" ? t("firstRun.connect.copied") : t("commandLine.copy")}
          </Button>
        ) : (
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={result === "copied" ? t("firstRun.connect.copied") : copyLabel}
            onClick={copy}
          >
            {result === "copied" ? <CheckIcon /> : <CopyIcon />}
          </Button>
        )}
      </span>
      {/* Present, though empty, from the start, so the sentence is announced when it appears. Keyed
          by the press, so pressing again replaces it and it is announced again. */}
      <span role="status" className="text-xs text-muted-foreground not-empty:mt-1">
        {result === "selected" && <span key={outcome.press}>{t("firstRun.connect.selected")}</span>}
      </span>
    </span>
  );
}
