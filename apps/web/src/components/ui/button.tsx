// SPDX-License-Identifier: AGPL-3.0-or-later
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn";
import type { DataAttributes } from "../../lib/dataAttributes";
import { touchTarget } from "../../lib/touchTarget";

const buttonVariants = cva(
  [
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium text-sm outline-none transition-[background-color,border-color,color] duration-(--duration-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    touchTarget,
  ],
  {
    defaultVariants: { variant: "outline", size: "default" },
    variants: {
      variant: {
        /** The one action a card or dialog exists for. */
        primary: "border-foreground bg-foreground text-background hover:bg-foreground/85",
        outline: "border-input bg-surface text-foreground hover:bg-muted",
        ghost: "border-transparent text-foreground hover:bg-muted",
        "ghost-muted":
          "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
        destructive: "border-blocked bg-blocked text-background hover:bg-blocked/85",
        "destructive-outline":
          "border-input bg-surface text-blocked hover:border-blocked/40 hover:bg-blocked-surface",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 px-2.5 text-xs",
        icon: "size-8",
        "icon-sm": "size-7",
        "icon-pill": "size-8 rounded-pill",
      },
    },
  },
);

type ButtonProps = useRender.ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const own: ComponentProps<"button"> & DataAttributes = {
    className: cn(buttonVariants({ variant, size }), className),
    type: render ? undefined : "button",
    "data-slot": "button",
  };
  return useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(own, props),
  });
}
