// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Inline,
  type MentionName,
  parseMessageText,
} from "@j3-bots/client-runtime/presentation";
import type { Attachment } from "@j3-bots/contracts";
import { FileChip } from "./FileChip";
import { TextMention } from "./MentionChip";

/** A message's files, each drawn where it was placed in its text. */
interface PlacedFiles {
  readonly files: ReadonlyArray<Attachment>;
  /** Where each stands in the text, in their order. */
  readonly offsets: ReadonlyArray<number>;
  readonly onOpen: (attachment: Attachment) => void;
}

/**
 * Message text with paragraphs, code and links, and each of its files where
 * it was placed. Plain text everywhere else; nothing is rendered as HTML.
 * Each part is marked with where it stands in `text`, so a selection maps
 * back to it (`quoteSelection.ts`).
 */
export function MessageText({
  text,
  mentionable,
  placed,
  quoteId,
}: {
  text: string;
  mentionable?: ReadonlyArray<MentionName>;
  placed?: PlacedFiles;
  /** The message's id, where a passage of it can be quoted. */
  quoteId?: string;
}) {
  const blocks = parseMessageText(text, mentionable, placed?.offsets);
  return (
    // The attribute is `QUOTE_TEXT` (quoteSelection.ts).
    <div className="flex flex-col gap-2" data-quote-text={quoteId}>
      {blocks.map((block, i) =>
        block.kind === "code" ? (
          <pre
            // Blocks have no identity besides their order, which never changes for a given text.
            // oxlint-disable-next-line react/no-array-index-key -- see above
            key={i}
            className="overflow-x-auto rounded-md bg-code-background px-2.5 py-2 font-mono text-xs leading-5"
          >
            <code data-at={block.at}>{block.text}</code>
          </pre>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- blocks are positional
          <p key={i} className="whitespace-pre-wrap break-words">
            {block.inlines.map((inline, j) => (
              // oxlint-disable-next-line react/no-array-index-key -- inlines are positional
              <InlinePart key={j} inline={inline} placed={placed} />
            ))}
          </p>
        ),
      )}
    </div>
  );
}

function InlinePart({ inline, placed }: { inline: Inline; placed: PlacedFiles | undefined }) {
  switch (inline.kind) {
    case "text":
      return <span data-at={inline.at}>{inline.text}</span>;
    case "code":
      return (
        <code
          data-at={inline.at}
          className="rounded-sm bg-code-background px-1 py-px font-mono text-[0.9em]"
        >
          {inline.text}
        </code>
      );
    case "link":
      return (
        <a
          data-at={inline.at}
          href={inline.href}
          target="_blank"
          rel="noreferrer noopener"
          className="wrap-anywhere underline decoration-current/40 underline-offset-2 hover:decoration-current"
        >
          {inline.text}
        </a>
      );
    case "mention":
      // `@` and the name, which a selection takes whole.
      return (
        <span data-atom-at={inline.at} data-atom-end={inline.at + 1 + inline.name.length}>
          <TextMention name={inline.name} of={inline.of} />
        </span>
      );
    case "file": {
      const attachment = placed?.files[inline.index];
      return attachment === undefined ? null : (
        <FileChip attachment={attachment} onOpen={() => placed?.onOpen(attachment)} />
      );
    }
  }
}
