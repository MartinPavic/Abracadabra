import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "../lib/api";

const components: Components = {
  h1: (props) => <h3 className="mt-3 mb-1 text-base font-semibold first:mt-0" {...props} />,
  h2: (props) => <h3 className="mt-3 mb-1 text-base font-semibold first:mt-0" {...props} />,
  h3: (props) => <h4 className="mt-3 mb-1 text-sm font-semibold first:mt-0" {...props} />,
  h4: (props) => <h4 className="mt-2 mb-1 text-sm font-semibold first:mt-0" {...props} />,
  p: (props) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  ul: (props) => <ul className="my-2 list-disc space-y-1 pl-5" {...props} />,
  ol: (props) => <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />,
  blockquote: (props) => (
    <blockquote
      className="my-2 border-l-2 border-zinc-300 pl-3 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400"
      {...props}
    />
  ),
  hr: () => <hr className="my-3 border-zinc-200 dark:border-zinc-800" />,
  code: (props) => (
    <code
      className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800"
      {...props}
    />
  ),
  pre: (props) => (
    <pre
      className="my-2 overflow-auto rounded-md bg-zinc-100 p-3 text-xs dark:bg-zinc-900 [&>code]:bg-transparent [&>code]:p-0"
      {...props}
    />
  ),
  table: (props) => (
    <div className="my-2 overflow-auto">
      <table className="w-full border-collapse text-left text-xs" {...props} />
    </div>
  ),
  th: (props) => (
    <th
      className="border border-zinc-200 bg-zinc-50 px-2 py-1 font-medium dark:border-zinc-800 dark:bg-zinc-900"
      {...props}
    />
  ),
  td: (props) => <td className="border border-zinc-200 px-2 py-1 dark:border-zinc-800" {...props} />,
  a: ({ href, children }: ComponentProps<"a">) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) void openUrl(href);
      }}
      className="text-blue-700 underline dark:text-blue-400"
    >
      {children}
    </a>
  ),
};

/** Renders agent output as markdown. Raw HTML in the text is shown as text, never as markup. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="px-4 py-3 text-sm break-words text-zinc-800 dark:text-zinc-200">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
