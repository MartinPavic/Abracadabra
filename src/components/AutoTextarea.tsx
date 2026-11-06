import { type TextareaHTMLAttributes, useLayoutEffect, useRef } from "react";
import { controlClasses } from "./ui";

/** Textarea that grows to fit its content (long commands wrap instead of scrolling off), and can be resized by hand. */
export function AutoTextarea({
  value,
  mono,
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string; mono?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  // Shares the control styling but not Textarea's min-height, which would stop it starting at one row.
  return (
    <textarea
      ref={ref}
      rows={1}
      spellCheck={false}
      value={value}
      className={[controlClasses, "resize-y break-all py-1.5", mono && "font-mono", className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}
