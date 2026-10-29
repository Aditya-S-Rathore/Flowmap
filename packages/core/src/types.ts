import type { SourceFile, CallExpression, Node as TsNode } from "ts-morph";
import type { NodeKind, EdgeKind, Confidence, Severity } from "./api-types.ts";

export type { NodeKind, EdgeKind, Confidence, Severity };
export type Attrs = Record<string, any>;

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  repo: string;
  file: string;
  line: number;
  endLine: number;
  attrs: Attrs;
  keys: string[];          // lookup keys other edges link to (e.g. "fn:backend:UserService.find")
}

export interface GraphEdge {
  id?: number;
  src: string;
  dst?: string | null;
  dstKey: string;          // symbolic target, resolved by the linker
  resolvedKey?: string | null; // dstKey after constant substitution
  kind: EdgeKind;
  repo: string;
  file: string;
  line: number;
  confidence?: Confidence;
  attrs: Attrs;            // hint (file path), inLoop, inTx, afterCommit, write, method, label, constRef...
}

export interface RepoConfig {
  name: string;
  path: string;            // absolute
  plugins: string[];
  tsconfig?: string;
  base?: string;           // git ref for "changes" mode
  ignore?: string[];       // repo-specific ignore globs
  connected?: boolean;     // pulled in via another repo's `connect` (its baseline belongs to that repo)
  screenshots?: ScreenshotConfig;   // this frontend's own app URL for `flowmap screenshots`
  database?: string;       // "postgres" | "mysql" | ...; detected from the repo's dependencies when not set
}

/** Opt-in: `flowmap screenshots` captures each screen of a frontend from the app you run locally. */
export interface ScreenshotConfig {
  baseUrl: string;                 // the URL you open in the browser, e.g. "http://localhost:3000"
  params?: Record<string, string>; // sample values for path params; others are taken from links on captured pages
  allow?: string[];                // write requests to let through (your session refresh), e.g. ["/api/auth/refresh"]
  wait?: number;                   // ms to wait after load (default 1500)
  width?: number;
  height?: number;
  allowRemote?: boolean;           // allow a non-local baseUrl (staging); off by default
}

export interface ClientCallConfig {
  call: string;            // "graphqlApi.mutationRequest"
  opArg?: number;          // argument holding the operation name
  docArg?: number;         // argument holding a gql document
}

export interface FlagCallConfig {
  call: string;            // "useFeatureFlag" or "flags.isEnabled"
  arg?: number;            // argument holding the flag's name (default 0)
}

export interface FlowMapConfig {
  name: string;
  repos: RepoConfig[];
  clients: ClientCallConfig[];
  flags: FlagCallConfig[];               // feature-flag checks: code that calls one is marked as behind that flag
  externals: Record<string, string>;     // class/identifier name -> external label
  afterCommit: string[];
  ignore: string[];
  rules: Record<string, Severity | "off">;
  actorDecorators: string[];
  permissionDecorators: string[];
  publicOperations: string;              // regex source for operations that may be unguarded
  authzGuards: string;                   // regex source for guards that imply authorization
  warnings: string[];                    // e.g. a connected repo that isn't checked out
}

export interface Workspace {
  dir: string;             // folder holding flowmap.config + .flowmap/
  configPath: string;
  config: FlowMapConfig;
  dbPath: string;
}

export interface FieldInfo {
  name: string;
  typeName: string | null;     // "UserService", "Repository"
  typeArgs: string[];          // ["User"]
  decorators: DecoratorInfo[];
}

export interface DecoratorInfo {
  name: string;
  args: string[];              // raw text of each argument
  line: number;
}

export interface ClassInfo {
  name: string;
  line: number;
  decorators: DecoratorInfo[];
  extends: string | null;      // "Repository<User>"
  fields: Map<string, FieldInfo>;
}

export interface ParamInfo {
  name: string;
  type: string;
  typeIsLiteral: boolean;
  decorators: DecoratorInfo[];
}

export interface FnInfo {
  node: GraphNode;
  cls: ClassInfo | null;
  methodName: string;
  decorators: DecoratorInfo[];
  params: ParamInfo[];
  body: TsNode;
}

export interface CallSite {
  fn: FnInfo;
  call: CallExpression;
  line: number;
  callee: string;              // callee text (truncated), e.g. "this.userRepo.save"
  root: string | null;         // "this" | identifier at the start of the chain | null
  segments: string[];          // property names after the root: ["userRepo", "save"]
  chained: boolean;            // an intermediate call exists: this.repo.createQueryBuilder().getMany()
  method: string;              // last segment ("save") or identifier ("fetch")
  field: FieldInfo | null;     // when the chain starts with this.<field>
  inLoop: boolean;
  inTx: boolean;               // inside a transaction callback
  afterCommit: boolean;        // inside an after-commit callback
  claimed: boolean;            // a plugin produced edges for it
}

export interface ImportInfo {
  spec: string;
  resolved: string | null;     // repo-relative file path when it points inside the repo
  imported: string;            // "default" | "*" | exported name
}

/** The markup part of a .vue/.svelte/.astro file (script blocks blanked out, offsets kept). */
export interface Template {
  text: string;
  line(offset: number): number;
}

export interface FileContext {
  sf: SourceFile;
  repo: RepoConfig;
  file: string;                // repo-relative
  config: FlowMapConfig;
  roots: string[];             // package roots in the repo ("" = repo root, "apps/web", ...), longest first
  hasFile(path: string): boolean;
  template?: Template;         // single-file components only
  fns: FnInfo[];
  classes: Map<string, ClassInfo>;
  calls: CallSite[];
  imports: Map<string, ImportInfo>;       // local identifier -> import
  resolveImport(spec: string): string | null;
  fnKey(name: string): string;            // "fn:<repo>:<name>"
  node(n: Omit<GraphNode, "endLine" | "keys" | "attrs"> & Partial<Pick<GraphNode, "endLine" | "keys" | "attrs">>): GraphNode;
  edge(e: Omit<GraphEdge, "repo" | "file"> & Partial<Pick<GraphEdge, "file">>): void;
  constant(key: string, value: string): void;
  meta: Attrs;                            // per-file facts (imports/exports/suppressions)
}

export interface FlowMapPlugin {
  id: string;
  detect?(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): boolean;
  extract?(ctx: FileContext): void;
  extractPy?(ctx: import("./python.ts").PyFileContext): void;     // Python files (tree-sitter)
  extractText?(file: string, text: string, ctx: Pick<FileContext, "repo" | "file" | "node" | "edge" | "constant">): void; // non-TS files
  textExtensions?: string[];
  derive?(graph: import("./graph.ts").Graph): void;
}
