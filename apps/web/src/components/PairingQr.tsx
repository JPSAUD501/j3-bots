// SPDX-License-Identifier: AGPL-3.0-or-later
import { generate } from "lean-qr";
import { toSvgPath } from "lean-qr/extras/svg";
import { useMemo } from "react";

/** Light modules around the code, as the QR standard asks, so a camera finds its edges. */
const QUIET_ZONE = 4;

/**
 * `text` as a QR code. Black on white in either theme: cameras read a light
 * code on a dark ground poorly, and the quiet zone is part of the image.
 */
export function PairingQr({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const code = generate(text);
    return { size: code.size, path: toSvgPath(code) };
  }, [text]);
  const side = size + 2 * QUIET_ZONE;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-QUIET_ZONE} ${-QUIET_ZONE} ${side} ${side}`}
      shapeRendering="crispEdges"
      className="size-40 shrink-0 rounded-md"
    >
      <rect x={-QUIET_ZONE} y={-QUIET_ZONE} width={side} height={side} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
