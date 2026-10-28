import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInline, parseMarkdown, safeHref } from "../src/components/markdownParser.ts";

const text = (c: ReturnType<typeof parseInline>): string => c.map((x) => (x.t === "text" || x.t === "code" ? x.v : x.t === "br" ? "\n" : x.t === "link" || x.t === "strong" || x.t === "em" ? text(x.c) : "")).join("");

test("headings, paragraphs, bold, italic, code, links", () => {
  const b = parseMarkdown("## Overview\nThe flow is **fast** and `setNickname` is *called* by [docs](https://example.com).\n\nSecond paragraph");
  assert.deepEqual(b.map((x) => x.t), ["h", "p", "p"]);
  assert.equal((b[0] as any).level, 2);
  const inline = (b[1] as any).c;
  assert.deepEqual(inline.map((x: any) => x.t), ["text", "strong", "text", "code", "text", "em", "text", "link", "text"]);
  assert.equal(inline[7].href, "https://example.com");
});

test("snake_case and file names are not italic; stray markers stay literal", () => {
  const c = parseInline("use user_id and my_file_name.ts, 2 * 3 * 4 and **unfinished");
  assert.ok(c.every((x) => x.t === "text"), JSON.stringify(c));
  assert.equal(text(c), "use user_id and my_file_name.ts, 2 * 3 * 4 and **unfinished");
});

test("only web and in-app links are clickable", () => {
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.test"]) assert.equal(safeHref(bad), null, bad);
  assert.ok(safeHref("https://a.test") && safeHref("#/designs/x") && safeHref("/api/status"));
  const c = parseInline("[click](javascript:alert(1))");
  assert.ok(c.every((x) => x.t !== "link"));
  assert.ok(text(c).startsWith("click") && !text(c).includes("javascript"), text(c).slice(0, 40));
});

test("HTML is plain text, never markup", () => {
  const c = parseInline("<img src=x onerror=alert(1)> <script>x</script>");
  assert.ok(c.every((x) => x.t === "text"));
});

test("fenced code, also while still streaming (no closing fence)", () => {
  const done = parseMarkdown("```ts\nconst a = 1;\n```\nafter");
  assert.deepEqual(done.map((x) => x.t), ["code", "p"]);
  assert.deepEqual(done[0], { t: "code", lang: "ts", v: "const a = 1;" });
  const open = parseMarkdown("before\n```sql\nSELECT 1;\nSELECT 2");
  assert.deepEqual(open[1], { t: "code", lang: "sql", v: "SELECT 1;\nSELECT 2" });
});

test("lists: bullets, numbers, nesting, wrapped lines", () => {
  const [list] = parseMarkdown("- one\n  - nested\n- two\n  continues\n1. first\n2. second") as any[];
  assert.equal(list.t, "list");
  assert.deepEqual(list.items.map((i: any) => [i.depth, i.marker]), [[0, "•"], [1, "•"], [0, "•"], [0, "1."], [0, "2."]]);
  assert.equal(text(list.items[2].c), "two\ncontinues");
});

test("tables and quotes and rules", () => {
  const b = parseMarkdown("| Name | Role |\n|---|---|\n| a | **b** |\n\n> quoted\n> text\n\n---");
  assert.deepEqual(b.map((x) => x.t), ["table", "quote", "hr"]);
  const table = b[0] as any;
  assert.equal(table.head.length, 2);
  assert.equal(table.rows[0][1][0].t, "strong");
});

test("a lone line of dashes is a rule, a list item is a list", () => {
  assert.deepEqual(parseMarkdown("---").map((x) => x.t), ["hr"]);
  assert.deepEqual(parseMarkdown("- item").map((x) => x.t), ["list"]);
});
