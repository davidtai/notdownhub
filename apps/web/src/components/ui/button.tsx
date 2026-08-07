import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const button = cva(
  "inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none",
  {
    variants: {
      variant: {
        default:
          "bg-brand text-[#0c0f16] hover:brightness-110 rounded-md dark:text-[#0c0f16]",
        outline:
          "border border-line-strong bg-surface text-fg hover:bg-surface-2 rounded-md",
        ghost: "text-fg-muted hover:text-fg hover:bg-surface-2 rounded-md",
        subtle: "bg-surface-2 text-fg hover:brightness-105 rounded-md",
      },
      size: {
        sm: "h-8 px-3 text-xs",
        md: "h-9 px-4 text-sm",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button ref={ref} className={cn(button({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = "Button";
