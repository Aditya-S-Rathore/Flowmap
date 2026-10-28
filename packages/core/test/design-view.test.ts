import { test } from "node:test";
import assert from "node:assert/strict";
import { isChange, summarize, visibleDesignNodes, type DesignNodeLike } from "../src/design-view.ts";

const node = (id: string, change: DesignNodeLike["change"] = "existing", over: Partial<DesignNodeLike> = {}): DesignNodeLike => ({ id, change, ...over });
const ids = (list: DesignNodeLike[]) => list.map((n) => n.id).sort();
const NONE = new Set<string>();

test("unchanged nodes Claude listed for context are not drawn on their own", () => {
  const nodes = [node("a", "changed"), node("ctx1"), node("ctx2"), node("n", "new")];
  assert.deepEqual(ids(visibleDesignNodes(nodes, [], NONE)), ["a", "n"]);
});

test("changing the start point changes the picture: only the flow's nodes (and changes) show", () => {
  const nodes = [node("a", "changed"), node("x"), node("y")];
  assert.deepEqual(ids(visibleDesignNodes(nodes, [], new Set(["x"]))), ["a", "x"]);
  assert.deepEqual(ids(visibleDesignNodes(nodes, [], new Set(["y"]))), ["a", "y"]);
});

test("a node an arrow ties to a change stays, in either direction", () => {
  const nodes = [node("n", "new"), node("table"), node("caller"), node("far")];
  const arrows = [{ src: "n", dst: "table" }, { src: "caller", dst: "n" }];
  assert.deepEqual(ids(visibleDesignNodes(nodes, arrows, NONE)), ["caller", "n", "table"]);
});

test("an arrow between two unchanged nodes ties nothing", () => {
  const nodes = [node("a"), node("b"), node("c", "changed")];
  assert.deepEqual(ids(visibleDesignNodes(nodes, [{ src: "a", dst: "b" }], NONE)), ["c"]);
});

test("what you asked to see and suggestions waiting for review always show", () => {
  const nodes = [node("mine", "existing", { keep: true }), node("suggested", "existing", { pending: true }), node("ctx")];
  assert.deepEqual(ids(visibleDesignNodes(nodes, [], NONE)), ["mine", "suggested"]);
  assert.ok(isChange(nodes[1]) && !isChange(nodes[2]));
});

test("removed counts as a change", () => {
  assert.deepEqual(ids(visibleDesignNodes([node("r", "removed"), node("c")], [], NONE)), ["r"]);
});

test("who created a node does not matter: only an explicit keep does (older designs hold many auto-added nodes)", () => {
  const nodes = [node("a", "changed"), { ...node("autoAdded"), author: "user" } as DesignNodeLike, node("asked", "existing", { keep: true })];
  assert.deepEqual(ids(visibleDesignNodes(nodes, [], NONE)), ["a", "asked"]);
  assert.deepEqual([...changesKeep(nodes, [])].sort(), ["a", "asked"]);
});

test("numbers: by repo in order of appearance, then as stored: the order of the table and the diagram", () => {
  const n = (id: string, repo: string, change: DesignNodeLike["change"]) => ({ id, repo, change });
  const numbers = numberChanges([n("a", "web", "changed"), n("ctx", "web", "existing"), n("b", "api", "new"), n("c", "web", "removed"), n("d", "api", "changed")]);
  assert.deepEqual([...numbers], [["a", 1], ["c", 2], ["b", 3], ["d", 4]]);
});

test("summary in words", () => {
  assert.equal(summarize([node("a", "new"), node("b", "new"), node("c", "changed")]), "2 new · 1 changing");
  assert.equal(summarize([node("a")]), "");
  assert.equal(summarize([node("a", "removed")]), "1 removing");
});

// ---- a model of a real design: 5 things changed, 3 new files, 2 tables, 19 helpers the changed code calls ----
import { changesKeep, flowKeep, numberChanges, trim, type Arrow } from "../src/design-view.ts";

const names = ["cb", "stitch", "ready", "consume", "tx", "jobs", "m1", "m2", "m3"];
const helpers = Array.from({ length: 19 }, (_, i) => `h${i}`);
const model = () => {
  const nodes: DesignNodeLike[] = [
    ...["cb", "stitch", "ready", "consume", "tx"].map((id) => node(id, "changed")),
    node("jobs"),
    ...["m1", "m2", "m3"].map((id) => node(id, "new")),
    ...helpers.map((id) => node(id)),
  ];
  const arrows: Arrow[] = [
    { src: "cb", dst: "consume", kind: "calls" }, { src: "stitch", dst: "consume", kind: "calls" }, { src: "ready", dst: "consume", kind: "calls" },
    { src: "stitch", dst: "jobs", kind: "writes" }, { src: "ready", dst: "jobs", kind: "reads" }, { src: "consume", dst: "tx", kind: "writes" },
    { src: "m1", dst: "tx", kind: "writes", change: "new" }, { src: "m2", dst: "tx", kind: "writes", change: "new" },
    { src: "m3", dst: "tx", kind: "writes", change: "new" }, { src: "m3", dst: "jobs", kind: "reads", change: "new" },
    ...["cb", "stitch", "ready"].flatMap((f) => helpers.slice(0, 8).map((h) => ({ src: f, dst: h, kind: "calls" }))),
    ...helpers.slice(8).map((h) => ({ src: "consume", dst: h, kind: "calls" })),
    { src: "h0", dst: "h9", kind: "calls" },
  ];
  return { nodes, arrows };
};

test("Changes: the 19 helpers fold away; changes, new files and the tables they touch stay", () => {
  const { nodes, arrows } = model();
  const { nodes: shown, hidden } = trim(nodes, arrows, changesKeep(nodes, arrows));
  assert.deepEqual(ids(shown), [...names].sort());
  assert.equal(shown.length, 9, "within what a reader can take in at a glance");
  assert.equal(hidden.get("consume")?.length, 11, "its own helpers wait behind +11");
  assert.ok(!hidden.has("m1") && !hidden.has("tx"), "nothing is folded behind the new files or the table");
});

test("Changes: a changed function's plain calls are not kept, but what it writes is", () => {
  const nodes = [node("fn", "changed"), node("helper"), node("table")];
  const keep = changesKeep(nodes, [{ src: "fn", dst: "helper", kind: "calls" }, { src: "fn", dst: "table", kind: "writes" }]);
  assert.deepEqual([...keep].sort(), ["fn", "table"]);
});

test("opening a +N brings its folded nodes in, and they can be opened in turn", () => {
  const { nodes, arrows } = model();
  const keep = changesKeep(nodes, arrows);
  const one = trim(nodes, arrows, keep, new Set(["consume"]));
  assert.equal(one.nodes.length, 9 + 11);
  assert.ok(one.hidden.has("h0") || !ids(one.nodes).includes("h0"), "h0's own neighbours are still folded");
  const two = trim(nodes, arrows, keep, new Set(["cb"]));
  assert.ok(ids(two.nodes).includes("h0") && ids(two.nodes).includes("h7"));
  const deeper = trim(nodes, arrows, keep, new Set(["cb", "h0"]));
  assert.ok(ids(deeper.nodes).includes("h9"), "h0 was opened too");
});

test("Flow: the way from an entry point to a change is kept; side branches fold into +N", () => {
  const design = [node("change", "changed")];
  const arrows: Arrow[] = [
    { src: "screen", dst: "api", kind: "requests" }, { src: "api", dst: "service", kind: "calls" }, { src: "service", dst: "change", kind: "calls" },
    { src: "screen", dst: "otherApi", kind: "requests" }, { src: "otherApi", dst: "elsewhere", kind: "calls" }, { src: "service", dst: "audit", kind: "calls" },
  ];
  const all = ["screen", "api", "service", "change", "otherApi", "elsewhere", "audit"].map((id) => ({ id }));
  const keep = flowKeep(new Set(all.map((n) => n.id)), design, arrows);
  assert.deepEqual([...keep].sort(), ["api", "change", "screen", "service"]);
  // a stored function that only reads the changed table is not on the way to it, when the flow's own routes are what counts
  const withReader = [...arrows, { src: "reader", dst: "change", kind: "reads" }];
  const known = new Set([...all.map((n) => n.id), "reader"]);
  assert.ok(flowKeep(known, design, withReader).has("reader"), "counted when every arrow counts");
  assert.ok(!flowKeep(known, design, withReader, arrows).has("reader"), "left out when only the flow's routes count");
  const { hidden } = trim(all, arrows, keep);
  assert.deepEqual([hidden.get("screen"), hidden.get("service")], [["otherApi"], ["audit"]]);
});
