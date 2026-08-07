import { cva, type VariantProps } from "class-variance-authority";
import { type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const badge = cva("inline-flex items-center gap-1 leading-none", {
  variants: {
    variant: {
      // Hairline chip — an event name, a matrix leg, a label.
      outline: "rounded-full border border-line px-2 py-1 text-[11px] font-medium text-fg-muted",
      // Filled label chip (runner labels).
      solid: "rounded-full bg-raised px-2 py-1 text-[11px] font-medium text-fg-muted",
      // Bare inline metadata, no chrome.
      plain: "text-[11px] text-fg-muted",
    },
  },
  defaultVariants: { variant: "outline" },
});

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badge> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badge({ variant }), className)} {...props} />;
}
