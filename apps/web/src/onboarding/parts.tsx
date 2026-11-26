// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";
import { Button } from "../components/ui/button";
import { textField } from "../components/ui/field";
import { cn } from "../lib/cn";
import { Cast } from "./Stage";

/** The app's text field, in the larger type of the screens before the first bot. */
export const bigFieldClass = cn(textField, "h-12 px-4 text-lg pointer-coarse:h-13");

/** The title of one screen before the first bot. Focus moves to it when its screen comes in. */
export function StepTitle({ children }: { readonly children: ReactNode }) {
  return (
    <h1 tabIndex={-1} data-step-title className="display-type text-3xl text-balance outline-none">
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
  describedBy,
}: {
  readonly children: ReactNode;
  readonly onClick?: () => void;
  readonly type?: "button" | "submit";
  /**
   * Announced as unavailable but still focusable, so its label stays
   * readable; pressing it then does nothing.
   */
  readonly disabled?: boolean;
  /** The ids of what says more about it, such as a line under it. */
  readonly describedBy?: string | undefined;
}) {
  return (
    <Button
      type={type}
      variant="primary"
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled}
      aria-describedby={describedBy}
      className="h-12 w-full text-lg pointer-coarse:h-13"
    >
      {children}
    </Button>
  );
}

/**
 * A screen before the first bot that is not a step of making it, as pairing
 * and naming the server, on the same dark stage as the first run: the cast
 * coming down into its lights, a title, what it says (`null` when the title
 * says it all) and what to do.
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
    <div className="onboarding dark flex h-full min-h-0 flex-1 flex-col items-center overflow-x-hidden overflow-y-auto bg-background px-6 py-10 text-foreground">
      <div className="my-auto flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <Cast />
        <div className="flex flex-col gap-2">
          <StepTitle>{title}</StepTitle>
          {body !== null && <p className="text-lg text-muted-foreground">{body}</p>}
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
