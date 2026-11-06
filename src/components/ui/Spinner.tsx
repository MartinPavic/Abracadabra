export function Spinner({ className = "size-4", decorative = false }: { className?: string; decorative?: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      {...(decorative ? { "aria-hidden": true } : { role: "status", "aria-label": "Loading" })}
      className={`${className} animate-spin motion-reduce:animate-none`}
    >
      <circle cx="12" cy="12" r="9" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  );
}
