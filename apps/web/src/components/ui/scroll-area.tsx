import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/** A plain overflow container relying on the themed native scrollbars from index.css. */
export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("overflow-auto", className)} {...props} />
  ),
);
ScrollArea.displayName = "ScrollArea";
