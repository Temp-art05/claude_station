import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * M3 outlined text field. Focus thickens the outline to 2px via an inset
 * shadow rather than a real border, so the field doesn't shift its content by a
 * pixel when you click into it.
 */
const base =
  "w-full rounded-md border border-outline/45 bg-white/3 px-3.5 py-2 text-sm text-ink " +
  "backdrop-blur-md placeholder:text-ink-faint " +
  "transition-[border-color,background-color,box-shadow] duration-200 ease-emphasized " +
  "hover:border-outline/80 hover:bg-white/5 " +
  "focus:border-primary focus:bg-white/6 focus:shadow-[inset_0_0_0_1px_var(--color-primary)] " +
  "focus:outline-none disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(base, "h-10", className)} {...props} />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(base, "min-h-[80px] resize-y", className)} {...props} />
));
Textarea.displayName = "Textarea";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("m3-label-md mb-1.5 block font-semibold text-ink-muted", className)}
      {...props}
    />
  );
}
