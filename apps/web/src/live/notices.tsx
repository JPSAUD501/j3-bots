// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext, type ReactNode, use, useCallback, useState } from "react";
import { type Notice, Toast } from "../components/Toast";

const SayContext = createContext<((text: string) => void) | null>(null);

/** Shows a short sentence in the page's one toast. */
export const useSay = () => {
  const say = use(SayContext);
  if (say === null) throw new Error("useSay needs Notices above it.");
  return say;
};

/**
 * One toast and the way to say something in it, for whoever places the toast
 * itself, as a page that is not the whole window's does.
 */
export function useNotice(): { readonly say: (text: string) => void; readonly toast: ReactNode } {
  const [notice, setNotice] = useState<Notice | null>(null);
  const say = useCallback(
    (text: string) => setNotice((previous) => ({ id: (previous?.id ?? 0) + 1, text })),
    [],
  );
  return { say, toast: <Toast notice={notice} onDone={() => setNotice(null)} /> };
}

/**
 * The page's toast, above the gate: a notice outlives the screen that asked
 * for it, as when signing out leaves the shell and another tab's pairing
 * brings it back.
 */
export function Notices({ children }: { children: ReactNode }) {
  const { say, toast } = useNotice();
  return (
    <SayContext value={say}>
      {children}
      {toast}
    </SayContext>
  );
}
