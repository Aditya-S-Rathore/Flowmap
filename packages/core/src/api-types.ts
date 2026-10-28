// Shapes returned by the local server (/api/*) and MCP tools. Shared with the dashboard.

export type NodeKind =
  | "Route" | "Component" | "ClientCall" | "Operation" | "Schema" | "Function"
  | "Guard" | "Table" | "External" | "Job" | "Queue";

export type EdgeKind =
  | "renders" | "calls" | "requests" | "handles" | "guarded_by" | "decorated_by"
  | "reads" | "writes" | "calls_external" | "enqueues" | "triggers" | "defines" | "relates" | "navigates";

export type Severity = "error" | "warn";
export type Confidence = "exact" | "inferred";

export interface NodeView {
  id: string;
  kind: NodeKind;
  name: string;
  repo: string;
  file: string;          // repo-relative, "" for virtual nodes (externals)
  line: number;
  transactional: boolean; // opens a transaction itself
  inTx: boolean;          // runs inside a transaction opened upstream
  issueCount: number;
  maxSeverity: Severity | null;
  outCount: number;       // outgoing edges (for "expand" affordance)
  inCount: number;
  group: string;          // repo, or repo/package in a monorepo; virtual nodes: "External services", "Database", "Queues"
  attrs: Record<string, unknown>;
}

export interface EdgeView {
  id: number;
  src: string;
  dst: string;
  kind: EdgeKind;
  confidence: Confidence;
  file: string;
  line: number;
  attrs: {
    inLoop?: boolean;
    inTx?: boolean;
    afterCommit?: boolean;
    write?: boolean;
    method?: string;
    label?: string;
  };
}

export interface Subgraph {
  rootId: string;
  nodes: NodeView[];
  edges: EdgeView[];
  truncated?: boolean;   // some branches were left out to keep the view readable
  omitted?: number;      // screen flows: APIs not drawn (listed in the APIs tab instead)
}

export interface SearchHit {
  id: string;
  kind: NodeKind;
  name: string;
  repo: string;
  file: string;
  line: number;
}

export interface PathStep {
  id: string;
  kind: NodeKind;
  name: string;
  repo: string;
  file: string;
  line: number;
}

export interface Issue {
  id: string;           // fingerprint
  rule: string;
  ruleTitle: string;
  severity: Severity;
  status: "new" | "baseline";
  nodeId: string;
  nodeName: string;
  repo: string;
  file: string;
  line: number;
  message: string;
  why: string;
  fix: string;
  path: PathStep[];     // proof: root → ... → offending call
}

export interface IssueSummary {
  total: number;
  new: number;
  baseline: number;
  suppressed: number;
  bySeverity: Record<Severity, number>;
  byRule: { rule: string; title: string; severity: Severity; count: number; new: number }[];
}

export interface RuleInfo {
  id: string;
  title: string;
  description: string;
  why: string;
  fix: string;
  severity: Severity | "off";
  count: number;
  new: number;
}

export interface RepoStatus {
  name: string;
  path: string;          // absolute, for editor links
  branch: string | null;
  files: number;
  plugins: string[];
}

export interface Status {
  workspace: string;
  workspaceDir: string;
  repos: RepoStatus[];
  counts: { nodes: number; edges: number; byKind: Partial<Record<NodeKind, number>>; unresolved: number };
  indexedAt: string | null;
  indexing: boolean;
  lastDurationMs: number | null;
}

export interface Overview {
  status: Status;
  issues: IssueSummary;
  hotspots: { repo: string; file: string; issues: number; errors: number }[];
  largestFunctions: { id: string; name: string; repo: string; file: string; line: number; loc: number }[];
}

export interface Ref {
  id: string;
  kind: NodeKind;
  name: string;
  repo: string;
  file: string;
  line: number;
  detail?: string;       // e.g. method name, "write", guard source
}

export interface ExplainCard {
  node: NodeView;
  screens: Ref[];        // routes/components that reach this node
  operations: Ref[];     // API operations on the path (or served by it)
  callers: Ref[];        // direct callers
  callees: Ref[];        // direct callees
  guards: string[];
  permissions: string[];
  hasActor: boolean | null;   // handler receives the current user/actor
  input: { name: string; type: string; validated: boolean }[];
  flags: string[];
  reads: Ref[];          // tables read (reachable)
  writes: Ref[];         // tables written (reachable)
  externals: (Ref & { write: boolean; inTx: boolean })[];
  transaction: { opens: boolean; inTx: boolean; roots: Ref[] };
  issues: Issue[];
  schema: { args: string; returns: string } | null;
}

export interface TableInfo {
  id: string;
  name: string;
  entity: string | null;
  repo: string;
  file: string;
  line: number;
  readers: Ref[];
  writers: Ref[];
  relations: { to: string; column: string; indexed: boolean | null }[];   // null: can't tell (index built at runtime)
  issues: Issue[];       // e.g. missing-fk-index; empty when the rule is off or suppressed
}

export interface ChangeSet {
  base: string;
  repos: { name: string; branch: string | null; base: string; files: string[]; error?: string }[];
  changed: Ref[];        // functions/handlers/components whose code changed
  affected: {
    operations: Ref[];
    screens: Ref[];
    tables: Ref[];
    externals: Ref[];
  };
  issues: Issue[];       // new issues located in changed code
}

export type UiKind =
  | "box" | "row" | "col" | "grid" | "card" | "nav" | "form" | "modal" | "tabs" | "list" | "table"
  | "heading" | "text" | "button" | "link" | "input" | "select" | "checkbox" | "image" | "icon" | "component";

/** One element of a screen's rough wireframe, read from JSX / templates. */
export interface WireNode {
  kind: UiKind;
  label?: string;
  children?: WireNode[];
  component?: Ref;       // the component this part comes from (kind "component")
  apis?: Ref[];          // APIs this button / form / link triggers
  submits?: boolean;     // a form-like wrapper (Formik, Ant Design Form, <form>): its submit buttons run `apis`
  to?: Ref;              // screen a link or button navigates to
  key?: string;          // i18n key the label came from (matched against translations on screenshots)
  repeat?: boolean;      // rendered once per item (list rows)
  optional?: boolean;    // shown only in some states
  cols?: number;
  repo: string;
  file: string;
  line: number;
}

export interface ShotInfo {
  variant: "desktop" | "desktop-dark" | "mobile" | "mobile-dark";
  at: string;
  ok: boolean;           // false: redirected to sign-in, error page, or not reachable
  note?: string;
  width: number;
  height: number;
  blocked?: number;      // write requests the page tried during capture (blocked)
}

export interface Wireframe {
  screen: Ref;
  root: WireNode | null;
  shots: ShotInfo[];     // see `flowmap screenshots`
  capturable: boolean;   // this screen's repo has screenshots.baseUrl, so the dashboard can capture it
}

/** A clickable area on a screenshot, matched to the code behind it. Coordinates in page pixels. */
export interface ShotSpot {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: UiKind;
  label: string;
  apis?: Ref[];
  to?: Ref;
  component?: Ref;
  repo: string;
  file: string;
  line: number;
}

export interface ShotSpots {
  width: number;
  height: number;
  spots: ShotSpot[];
}

export interface Counts {
  apis: number;
  reads: number;         // tables read
  writes: number;        // tables written
  externals: number;
  issues: number;
  maxSeverity: Severity | null;
}

export interface ScreenInfo extends Counts {
  id: string;
  name: string;          // URL path, or the screen name for name-based (mobile) routers
  repo: string;
  group: string;
  file: string;
  line: number;
  component: Ref | null;
  auth: boolean | null;  // null = unknown
  flag: string | null;
  linksIn: number;       // screens/components that link here
  linksOut: Ref[];       // screens this one links to
  apiIds: string[];      // APIs this screen reaches
  shot: string | null;   // when a screenshot was captured (ISO), or null
  unlinked: boolean;     // nothing links here although the repo has navigation links
}

export interface ApiInfo extends Counts {
  id: string;
  name: string;
  repo: string;
  group: string;
  file: string;
  line: number;
  protocol: string;      // graphql | rest | action
  handler: Ref | null;
  guards: string[];
  guarded: boolean;
  screens: number;       // screens that reach it
}

export interface JobInfo extends Counts {
  id: string;
  kind: NodeKind;        // Job | Queue
  name: string;
  repo: string;
  group: string;
  file: string;
  line: number;
  handler: Ref | null;
}

export interface AppMap {
  groups: string[];
  hasNavigation: boolean;
  screens: ScreenInfo[];
  apis: ApiInfo[];
  jobs: JobInfo[];
}

export interface ArchNode {
  id: string;
  label: string;
  kind: "service" | "external" | "queue";
  screens: number;
  apis: number;
  tables: number;
  jobs: number;
  issues: number;
}

export interface ArchLink {
  src: string;
  dst: string;
  kind: "requests" | "enqueues" | "calls_external" | "triggers";
  count: number;
  samples: Ref[];        // a few call sites behind the link
}

export interface Architecture {
  nodes: ArchNode[];
  links: ArchLink[];
}

export interface Suggestion {
  kind: "plugin" | "external" | "client" | "unused" | "info";
  repo: string;
  title: string;
  detail: string;
  config?: string;       // snippet to add to flowmap.config.mjs
}

// ---------- designs: a feature drawn on top of the real graph before it is built ----------

export type DesignAuthor = "user" | "claude";

/** Real node (graph id) or proposed one (id "new:<key>"). `pending`: added by Claude, waiting for accept / reject. */
export interface DesignNode {
  id: string;
  change: "existing" | "new" | "changed" | "removed";
  kind: NodeKind;
  name: string;
  repo: string;
  file?: string;            // proposed: suggested location
  transactional?: boolean;  // proposed: opens a transaction
  guards?: string[];        // proposed: auth guards it will have
  note?: string;
  x?: number;
  y?: number;
  keep?: boolean;           // you asked to see it (added from search): the Changes and Flow views show it although it is unchanged
  pinned?: boolean;         // you placed it: x / y are honoured. Without it the layout decides (older files saved x / y for every node)
  author: DesignAuthor;
  pending?: boolean;
}

/** Only proposed edges are stored; edges between real nodes come from the graph. */
export interface DesignEdge {
  id: string;
  src: string;
  dst: string;
  kind: EdgeKind;
  change: "new" | "removed";
  author: DesignAuthor;
  pending?: boolean;
}

export interface DesignNote {
  id: string;
  text: string;
  x: number;
  y: number;
  author: DesignAuthor;
}

export type DesignStatus = "draft" | "review" | "approved" | "rejected";

export interface Design {
  version: number;
  title: string;
  status?: DesignStatus;    // where the RFC stands; "draft" when missing
  summary: string;          // the TL;DR: 2–3 lines, what changes, why, the impact, what reviewers must decide
  rfc: string;              // Markdown, the doc reviewers read
  rfcBy?: DesignAuthor;     // last to edit the RFC (Claude never overwrites the user's text)
  nodes: DesignNode[];
  edges: DesignEdge[];
  notes: DesignNote[];
  decisions: { question: string; answer: string }[];
  updatedAt: string;
}

/** Conversation with Claude about a design, kept next to it (saving it never conflicts with canvas edits). */
export interface DesignChat {
  session?: string;         // Claude conversation id, to continue it
  messages: { role: DesignAuthor; text: string; tools?: string[]; model?: string }[];   // tools: what Claude did while answering
}

export interface DesignSummary {
  slug: string;
  title: string;
  summary: string;
  version: number;
  updatedAt: string;
  pending: number;
}

export interface DesignImpact {
  introduced: Issue[];      // would appear if the design is built
  resolved: Issue[];        // would go away
  tables: TableInfo[];      // tables the design touches, with everyone else who reads / writes them
  dependents: { id: string; name: string; refs: Ref[] }[];   // what depends on changed / removed nodes
}

export type DesignNodeView = NodeView & Pick<DesignNode, "change" | "author" | "pending" | "x" | "y" | "note" | "keep"> & {
  introduced: number;       // issues the design would add on this node (included in issueCount)
  context?: boolean;        // dashboard only: part of the real flow around the changes, not stored in the design
};
export type DesignEdgeView = EdgeView & { designId?: string; change?: DesignEdge["change"]; pending?: boolean };

/** Conversations with Claude about one design, newest first (the open one is `active`). */
export interface ChatSummary {
  id: string;
  title: string;            // the first thing you asked
  updatedAt: string;
  count: number;            // messages
  active: boolean;
}

/** The real flow around a design's changes, found automatically: the flows of the entry points (screens, APIs, jobs) that reach them. */
export interface DesignFlow {
  flow: Subgraph;
  from: Ref[];              // the entry points drawn
  roots: number;            // existing code the design changes (0: nothing to draw a flow for yet)
}

export interface DesignView {
  slug: string;
  design: Design;
  nodes: DesignNodeView[];
  edges: DesignEdgeView[];
  stale: string[];          // real nodes no longer in the code
  impact: DesignImpact;
  chat: DesignChat["messages"];       // the open conversation
  conversations: ChatSummary[];
}

/** Claude Code on this machine, for the dashboard's setup checklist. */
export interface ClaudeStatus {
  version: string | null;   // null: not installed
  signedIn: boolean;
  plugin: boolean;          // FlowMap plugin installed (tools + skills in terminal sessions)
}

export type ServerEvent =
  | { type: "indexing"; phase: string }
  | { type: "updated"; files: number; durationMs: number; config?: boolean }
  | { type: "error"; message: string }
  | { type: "shot"; id: string; ok: boolean; note?: string }
  | { type: "design"; slug: string; version: number }
  | { type: "chat"; slug: string; text?: string; tool?: string; done?: boolean; error?: string };

/** What the dashboard chat may do: "full" = everything a terminal Claude Code session can; "design" = read code + edit the design only. */
export type ChatMode = "full" | "design";
