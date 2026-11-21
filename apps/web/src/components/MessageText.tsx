// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseMessageText, type Inline } from "@j3-bots/client-runtime/presentation";

/** Message text with paragraphs, code and links. Plain text everywhere else; nothing is rendered as HTML. */
export function MessageText({
  text,
  mentionable,
}: {
  text: string;
  mentionable?: ReadonlyArray<string>;
}) {
  const blocks = parseMessageText(text, mentionable);
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block, i) =>
        block.kind === "code" ? (
          <pre
            // Blocks have no identity besides their order, which never changes for a given text.
            // oxlint-disable-next-line react/no-array-index-key -- see above
            key={i}
            className="overflow-x-auto rounded-md bg-code-background px-2.5 py-2 font-mono text-xs leading-5"
          >
            <code>{block.text}</code>
          </pre>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- blocks are positional
          <p key={i} className="whitespace-pre-wrap break-words">
            {block.inlines.map((inline, j) => (
              // oxlint-disable-next-line react/no-array-index-key -- inlines are positional
              <InlinePart key={j} inline={inline} />
            ))}
          </p>
        ),
      )}
    </div>
  );
}

function InlinePart({ inline }: { inline: Inline }) {
  switch (inline.kind) {
    case "text":
      return inline.text;
    case "code":
      return (
        <code className="rounded-sm bg-code-background px-1 py-px font-mono text-[0.9em]">
          {inline.text}
        </code>
      );
    case "link":
      return (
        <a
          href={inline.href}
          target="_blank"
          rel="noreferrer noopener"
          className="wrap-anywhere underline decoration-current/40 underline-offset-2 hover:decoration-current"
        >
          {inline.text}
        </a>
      );
    case "mention":
      return <span className="font-semibold">@{inline.name}</span>;
  }
}
