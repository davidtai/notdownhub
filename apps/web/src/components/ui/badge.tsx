import { cva, type VariantProps } from "class-variance-authority";
import { type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const badge = cva(
  "inline-flex items-center gap-1.5 font-mono text-[11px] font-medium leading-none",
  {
    variants: {
      variant: {
        // Monospace "chips" with a hairline — reads like a panel readout, not a pill.
        outline:
          "rounded border border-line px-1.5 py-1 text-fg-muted",
        solid: "rounded px-1.5 py-1 bg-surface-2 text-fg",
        plain: "text-fg-muted",
      },
    },
    defaultVariants: { variant: "outline" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badge> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badge({ variant }), className)} {...props} />;
}
