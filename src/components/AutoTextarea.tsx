import { type TextareaHTMLAttributes, useLayoutEffect, useRef } from "react";

/** Textarea that grows to fit its content (long commands wrap instead of scrolling off), and can be resized by hand. */
export function AutoTextarea({
  value,
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      spellCheck={false}
      value={value}
      className={`resize-y break-all ${className}`}
      {...props}
    />
  );
}
