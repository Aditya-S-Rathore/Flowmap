// A small Markdown parser for what Claude writes in chat: headings, paragraphs, lists, tables, quotes, code, emphasis, links.
// It only builds a tree (rendered as React elements by Markdown.tsx), never HTML, so nothing in a reply can inject markup.
// Half-finished text (while streaming) is fine: an open code fence runs to the end, an unclosed `**` stays literal.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "br" }
  | { t: "strong" | "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3 | 4; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "hr" }
  | { t: "quote"; c: Block[] }
  | { t: "list"; items: { depth: number; marker: string; c: Inline[] }[] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] };

// code | **bold** | [text](url) | *em* | _em_ | bare url
const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w])_(?=\S)([^_\n]*?\S)_(?!\w)|(https?:\/\/[^\s<>)]+[^\s<>).,;:!?])/g;

/** Only web links and in-app links are ever clickable (no javascript:, data: …). */
export const safeHref = (href: string) => (/^(https?:\/\/|#\/|\/(?!\/))/i.test(href) ? href : null);

function plain(text: string, out: Inline[]) {
  text.split("\n").forEach((line, i) => {
    if (i) out.push({ t: "br" });
    if (line) out.push({ t: "text", v: line });
  });
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of src.matchAll(INLINE)) {
    plain(src.slice(last, m.index), out);
    last = m.index + m[0].length;
    if (m[2] !== undefined) out.push({ t: "code", v: m[2].trim() });
    else if (m[3] !== undefined) out.push({ t: "strong", c: parseInline(m[3]) });
    else if (m[4] !== undefined) {
      const href = safeHref(m[5]);
      if (href) out.push({ t: "link", href, c: parseInline(m[4]) });
      else out.push(...parseInline(m[4]));                         // not a safe link: just its text
    } else if (m[6] !== undefined || m[7] !== undefined) out.push({ t: "em", c: parseInline(m[6] ?? m[7]) });
    else out.push({ t: "link", href: m[8], c: [{ t: "text", v: m[8] }] });
  }
  plain(src.slice(last), out);
  return out;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const ROW = /^\s*\|.*\|\s*$/;
const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => parseInline(c.trim()));

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (n: number) => FENCE.test(lines[n]) || HEADING.test(lines[n]) || RULE.test(lines[n]) || ITEM.test(lines[n]) || /^\s{0,3}>/.test(lines[n]) || (ROW.test(lines[n]) && SEPARATOR.test(lines[n + 1] ?? ""));

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      i++;                                                         // the closing fence (absent while streaming)
      blocks.push({ t: "code", lang: fence[2], v: code.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ t: "h", level: Math.min(heading[1].length, 4) as 1 | 2 | 3 | 4, c: parseInline(heading[2]) }); i++; continue; }
    if (RULE.test(line)) { blocks.push({ t: "hr" }); i++; continue; }

    if (/^\s{0,3}>/.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
      blocks.push({ t: "quote", c: parseMarkdown(quote.join("\n")) });
      continue;
    }

    if (ROW.test(line) && SEPARATOR.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && ROW.test(lines[i]); i++) rows.push(cells(lines[i]));
      blocks.push({ t: "table", head, rows });
      continue;
    }

    if (ITEM.test(line)) {
      const items: { depth: number; marker: string; c: Inline[] }[] = [];
      for (; i < lines.length; i++) {
        const m = ITEM.exec(lines[i]);
        if (m) items.push({ depth: Math.min(Math.floor(m[1].replace(/\t/g, "  ").length / 2), 4), marker: /\d/.test(m[2]) ? m[2] : "•", c: parseInline(m[3]) });
        else if (items.length && /^\s+\S/.test(lines[i]) && !startsBlock(i)) items[items.length - 1].c.push({ t: "br" }, ...parseInline(lines[i].trim()));   // wrapped item text
        else break;
      }
      blocks.push({ t: "list", items });
      continue;
    }

    const para: string[] = [];
    for (; i < lines.length && lines[i].trim() && (!para.length || !startsBlock(i)); i++) para.push(lines[i]);
    blocks.push({ t: "p", c: parseInline(para.join("\n")) });
  }
  return blocks;
}
