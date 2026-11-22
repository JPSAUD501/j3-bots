// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { Button } from "../components/ui/button";
import { Cast } from "./Cast";

/** A text field of the screens before the first bot, in their large type. */
export const bigFieldClass =
  "h-12 w-full rounded-lg border-2 border-input bg-surface px-4 text-lg placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:outline-none aria-invalid:border-blocked pointer-coarse:h-13";

/** The title of one screen before the first bot. Focus moves to it when its screen comes in. */
export function StepTitle({ children }: { readonly children: ReactNode }) {
  return (
    <h1
      tabIndex={-1}
      data-step-title
      className="text-(length:--onboarding-title) leading-tight font-semibold tracking-tight text-balance outline-none"
    >
      {children}
    </h1>
  );
}

/** The one action of a screen before the first bot. */
export function BigButton({
  children,
  onClick,
  type = "button",
  disabled = false,
}: {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly type?: "button" | "submit";
  /** Announced as unavailable but still focusable, so its label stays readable. */
  readonly disabled?: boolean;
}) {
  return (
    <Button
      type={type}
      variant="primary"
      onClick={onClick}
      aria-disabled={disabled}
      className="onboarding-press h-12 w-full rounded-pill text-lg pointer-coarse:h-13"
    >
      {children}
    </Button>
  );
}

/**
 * A screen before the first bot that is not a step of making it, as pairing
 * and naming the server: the team still to come, a title and what to do.
 */
export function FirstScreen({
  title,
  body,
  children,
}: {
  readonly title: string;
  readonly body: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="onboarding flex h-full min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 py-10">
      <div className="my-auto flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <Cast compact />
        <div className="flex flex-col gap-2">
          <StepTitle>{title}</StepTitle>
          <p className="text-lg text-muted-foreground">{body}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The answer to a form, kept to its own space under the form: room for two
 * lines is held while it is empty, so a refusal does not move the form.
 */
export function FormProblem({
  id,
  children,
}: {
  readonly id: string;
  readonly children: ReactNode;
}) {
  return (
    <p id={id} role="alert" className="min-h-[2lh] text-center text-sm text-blocked">
      {children}
    </p>
  );
}
