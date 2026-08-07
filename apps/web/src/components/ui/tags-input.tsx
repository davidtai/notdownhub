import * as TagsInputPrimitive from "@diceui/tags-input";
import { X } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

// Added via: npx shadcn@latest add "https://diceui.com/r/tags-input.json"
// (diceui tags-input — the shadcn-ecosystem tags/pills input, built on the
// @diceui/tags-input headless primitive). Re-themed from the registry's default
// shadcn tokens to notdownhub's palette (bg-surface / border-line / text-fg …),
// matching the other primitives in this folder. Structure is unchanged.

function TagsInput({
  className,
  ...props
}: React.ComponentProps<typeof TagsInputPrimitive.Root>) {
  return (
    <TagsInputPrimitive.Root
      data-slot="tags-input"
      className={cn("flex w-full flex-col gap-2", className)}
      {...props}
    />
  );
}

function TagsInputLabel({
  className,
  ...props
}: React.ComponentProps<typeof TagsInputPrimitive.Label>) {
  return (
    <TagsInputPrimitive.Label
      data-slot="tags-input-label"
      className={cn(
        "font-medium text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        className,
      )}
      {...props}
    />
  );
}

function TagsInputList({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="tags-input-list"
      className={cn(
        "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-2 text-sm text-fg focus-within:border-accent focus-within:ring-1 focus-within:ring-accent disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function TagsInputInput({
  className,
  ...props
}: React.ComponentProps<typeof TagsInputPrimitive.Input>) {
  return (
    <TagsInputPrimitive.Input
      data-slot="tags-input-input"
      className={cn(
        "flex-1 bg-transparent text-fg outline-none placeholder:text-fg-subtle disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function TagsInputItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof TagsInputPrimitive.Item>) {
  return (
    <TagsInputPrimitive.Item
      data-slot="tags-input-item"
      className={cn(
        "inline-flex max-w-[calc(100%-8px)] items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 py-1 font-mono text-[12px] text-fg transition-colors focus:outline-none data-disabled:cursor-not-allowed data-editable:select-none data-editing:bg-surface data-disabled:opacity-50 data-editing:ring-1 data-editing:ring-accent [&:not([data-editing])]:pr-1.5 [&[data-highlighted]:not([data-editing])]:bg-accent [&[data-highlighted]:not([data-editing])]:text-white",
        className,
      )}
      {...props}
    >
      <TagsInputPrimitive.ItemText className="truncate">
        {children}
      </TagsInputPrimitive.ItemText>
      <TagsInputPrimitive.ItemDelete className="size-4 shrink-0 rounded-sm opacity-60 transition-opacity hover:opacity-100">
        <X className="size-3.5" />
      </TagsInputPrimitive.ItemDelete>
    </TagsInputPrimitive.Item>
  );
}

function TagsInputClear({
  className,
  ...props
}: React.ComponentProps<typeof TagsInputPrimitive.Clear>) {
  return (
    <TagsInputPrimitive.Clear
      data-slot="tags-input-clear"
      className={cn(
        "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium text-fg-subtle transition-colors hover:text-fg",
        className,
      )}
      {...props}
    />
  );
}

export {
  TagsInput,
  TagsInputClear,
  TagsInputInput,
  TagsInputItem,
  TagsInputLabel,
  TagsInputList,
};
