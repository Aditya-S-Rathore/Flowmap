import { Check, Copy } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "./markdownParser";

function Inlines({ list }: { list: Inline[] }): ReactNode {
  return list.map((n, i) => {
    switch (n.t) {
      case "text": return <Fragment key={i}>{n.v}</Fragment>;
      case "br": return <br key={i} />;
      case "code": return <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-xs break-words">{n.v}</code>;
      case "strong": return <strong key={i} className="font-semibold"><Inlines list={n.c} /></strong>;
      case "em": return <em key={i}><Inlines list={n.c} /></em>;
      case "link": return n.href.startsWith("http")
        ? <a key={i} href={n.href} target="_blank" rel="noreferrer noopener" className="text-accent underline-offset-2 hover:underline"><Inlines list={n.c} /></a>
        : <a key={i} href={n.href} className="text-accent underline-offset-2 hover:underline"><Inlines list={n.c} /></a>;
    }
  });
}

function CodeBlock({ lang, v }: { lang: string; v: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(v).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});
  return (
    <div className="overflow-hidden rounded-md border border-line bg-subtle">
      <div className="flex items-center justify-between border-b border-line px-3 py-1 text-xs text-fg-subtle">
        <span>{lang || "text"}</span>
        <button type="button" onClick={copy} aria-label="Copy code" className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted hover:text-fg">
          {copied ? <><Check className="size-3" aria-hidden />Copied</> : <><Copy className="size-3" aria-hidden />Copy</>}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed"><code>{v}</code></pre>
    </div>
  );
}

const HEADING = {
  1: "mt-1 text-base font-semibold", 2: "mt-1 text-sm font-semibold", 3: "text-sm font-semibold", 4: "text-sm font-medium text-fg-muted",
} as const;
// a whole document (the RFC preview): headings that structure the page
const HEADING_DOC = {
  1: "text-xl font-semibold tracking-tight", 2: "mt-5 border-b border-line pb-1 text-base font-semibold", 3: "mt-2 text-sm font-semibold", 4: "text-sm font-medium text-fg-muted",
} as const;

function Blocks({ list, doc = false }: { list: Block[]; doc?: boolean }): ReactNode {
  return list.map((b, i) => {
    switch (b.t) {
      case "p": return <p key={i} className="leading-relaxed break-words"><Inlines list={b.c} /></p>;
      case "h": { const H = `h${b.level + 2}` as "h3" | "h4" | "h5" | "h6"; return <H key={i} className={(doc ? HEADING_DOC : HEADING)[b.level]}><Inlines list={b.c} /></H>; }
      case "code": return <CodeBlock key={i} lang={b.lang} v={b.v} />;
      case "hr": return <hr key={i} className="border-line" />;
      case "quote": return <blockquote key={i} className="space-y-2 border-l-2 border-line-strong pl-3 text-fg-muted"><Blocks list={b.c} doc={doc} /></blockquote>;
      case "list": return (
        <ul key={i} className="space-y-1">
          {b.items.map((it, j) => (
            <li key={j} className="flex gap-2 break-words" style={{ marginLeft: `${it.depth * 1}rem` }}>
              <span className="w-4 shrink-0 text-right text-fg-subtle" aria-hidden>{it.marker}</span>
              <span className="min-w-0 leading-relaxed"><Inlines list={it.c} /></span>
            </li>
          ))}
        </ul>
      );
      case "table": return (
        <div key={i} className="overflow-x-auto rounded-md border border-line">
          <table className="w-full text-left text-xs">
            <thead className="bg-subtle"><tr>{b.head.map((c, j) => <th key={j} className="border-b border-line px-2.5 py-1.5 font-medium"><Inlines list={c} /></th>)}</tr></thead>
            <tbody>{b.rows.map((r, j) => <tr key={j} className="border-b border-line last:border-b-0">{r.map((c, k) => <td key={k} className="px-2.5 py-1.5 align-top"><Inlines list={c} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    }
  });
}

/** Claude's Markdown as React elements (never HTML). */
export function Markdown({ text, doc = false }: { text: string; doc?: boolean }) {
  return <div className={`${doc ? "space-y-3" : "space-y-2.5"} text-sm`}><Blocks list={parseMarkdown(text)} doc={doc} /></div>;
}
