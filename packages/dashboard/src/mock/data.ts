import type { EdgeKind, EdgeView, Issue, NodeKind, NodeView, RepoStatus, RuleInfo } from "../types";

export const repos: RepoStatus[] = [
  { name: "backend", path: "/Users/dev/acme/backend", branch: "feat/addon-seats", files: 812, plugins: ["nestjs", "typeorm", "graphql"] },
  { name: "frontend", path: "/Users/dev/acme/frontend", branch: "feat/addon-seats", files: 1240, plugins: ["react", "redux-toolkit", "apollo"] },
];

type Raw = [id: string, kind: NodeKind, name: string, repo: string, file: string, line: number, attrs?: Record<string, unknown>];

const FE = "frontend";
const BE = "backend";

const raw: Raw[] = [
  // Screens
  ["fe:route:/settings/billing", "Route", "Settings › Billing", FE, "src/routes/settings.tsx", 42, { path: "/settings/billing" }],
  ["fe:route:/settings/profile", "Route", "Settings › Profile", FE, "src/routes/settings.tsx", 31, { path: "/settings/profile" }],
  ["fe:route:/team/members", "Route", "Team › Members", FE, "src/routes/team.tsx", 18, { path: "/team/members" }],
  ["fe:route:/projects/:id", "Route", "Projects › Detail", FE, "src/routes/projects.tsx", 25, { path: "/projects/:id" }],
  ["fe:cmp:BillingPage", "Component", "BillingPage", FE, "src/pages/settings/billing/BillingPage.tsx", 24],
  ["fe:cmp:AddonSeatsCard", "Component", "AddonSeatsCard", FE, "src/pages/settings/billing/AddonSeatsCard.tsx", 12],
  ["fe:cmp:InvoiceList", "Component", "InvoiceList", FE, "src/pages/settings/billing/InvoiceList.tsx", 9],
  ["fe:cmp:ProfilePage", "Component", "ProfilePage", FE, "src/pages/settings/profile/ProfilePage.tsx", 20],
  ["fe:cmp:MembersPage", "Component", "MembersPage", FE, "src/pages/team/MembersPage.tsx", 16],
  ["fe:cmp:ProjectPage", "Component", "ProjectPage", FE, "src/pages/projects/ProjectPage.tsx", 33],
  // Client calls
  ["fe:call:updateAddonSeatsAction", "ClientCall", "updateAddonSeatsAction", FE, "src/store/billing/billing.thunks.ts", 48],
  ["fe:call:fetchSubscriptionAction", "ClientCall", "fetchSubscriptionAction", FE, "src/store/billing/billing.thunks.ts", 21],
  ["fe:call:fetchInvoicesAction", "ClientCall", "fetchInvoicesAction", FE, "src/store/billing/billing.thunks.ts", 77],
  ["fe:call:setNicknameAction", "ClientCall", "setNicknameAction", FE, "src/store/profile/profile.thunks.ts", 15],
  ["fe:call:fetchTeamMembersAction", "ClientCall", "fetchTeamMembersAction", FE, "src/store/team/team.thunks.ts", 11],
  ["fe:call:resendInviteAction", "ClientCall", "resendInviteAction", FE, "src/store/team/team.thunks.ts", 39],
  ["fe:call:archiveProjectAction", "ClientCall", "archiveProjectAction", FE, "src/store/projects/projects.thunks.ts", 64],
  // Operations
  ["be:op:mutation updateAddonSeats", "Operation", "mutation updateAddonSeats", BE, "src/modules/acme/plan/plan.resolver.ts", 88,
    { opType: "mutation", transport: "graphql", hasActor: true, permissions: ["billing:manage"], input: [{ name: "input.seats", type: "Int!", validated: true }, { name: "input.planId", type: "ID!", validated: true }], schema: { args: "input: UpdateAddonSeatsInput!", returns: "AcmeSubscription!" } }],
  ["be:op:query subscription", "Operation", "query subscription", BE, "src/modules/acme/plan/plan.resolver.ts", 41,
    { opType: "query", transport: "graphql", hasActor: true, permissions: [], input: [], schema: { args: "", returns: "AcmeSubscription" } }],
  ["be:op:mutation setNickname", "Operation", "mutation setNickname", BE, "src/modules/users/user.resolver.ts", 112,
    { opType: "mutation", transport: "graphql", hasActor: false, permissions: [], input: [{ name: "userId", type: "ID!", validated: false }, { name: "code", type: "String!", validated: false }], schema: { args: "userId: ID!, code: String!", returns: "User!" } }],
  ["be:op:query teamMembers", "Operation", "query teamMembers", BE, "src/modules/team/team.resolver.ts", 27,
    { opType: "query", transport: "graphql", hasActor: true, permissions: ["team:read"], input: [{ name: "teamId", type: "ID!", validated: true }], schema: { args: "teamId: ID!", returns: "[TeamMember!]!" } }],
  ["be:op:mutation resendInvite", "Operation", "mutation resendInvite", BE, "src/modules/team/team.resolver.ts", 74,
    { opType: "mutation", transport: "graphql", hasActor: false, permissions: [], input: [{ name: "inviteId", type: "ID!", validated: true }], schema: { args: "inviteId: ID!", returns: "Boolean!" } }],
  ["be:op:mutation archiveProject", "Operation", "mutation archiveProject", BE, "src/modules/projects/project.resolver.ts", 131,
    { opType: "mutation", transport: "graphql", hasActor: true, permissions: ["project:admin"], input: [{ name: "projectId", type: "ID!", validated: true }], schema: { args: "projectId: ID!", returns: "Project!" } }],
  ["be:op:POST /webhooks/stripe", "Operation", "POST /webhooks/stripe", BE, "src/modules/acme/webhooks/stripe-webhook.controller.ts", 22,
    { opType: "POST", transport: "rest", hasActor: null, permissions: [], input: [{ name: "body", type: "any", validated: false }], schema: null }],
  ["be:op:GET /api/exports/:id", "Operation", "GET /api/exports/:id", BE, "src/modules/exports/export.controller.ts", 37,
    { opType: "GET", transport: "rest", hasActor: false, permissions: [], input: [{ name: "id", type: "string", validated: true }], schema: null }],
  // Guards
  ["be:guard:JwtAuthGuard", "Guard", "JwtAuthGuard", BE, "src/auth/guards/jwt-auth.guard.ts", 10],
  ["be:guard:AcmeStripeBilling", "Guard", "AcmeStripeBilling", BE, "src/modules/acme/guards/stripe-billing.guard.ts", 14],
  ["be:guard:TeamRoleGuard", "Guard", "TeamRoleGuard", BE, "src/modules/team/guards/team-role.guard.ts", 9],
  // Functions
  ["be:fn:AcmePlanService.updateAddonSeats", "Function", "AcmePlanService.updateAddonSeats", BE, "src/modules/acme/plan/plan.service.ts", 142, { transactional: true, loc: 96 }],
  ["be:fn:AcmePlanService.getSubscription", "Function", "AcmePlanService.getSubscription", BE, "src/modules/acme/plan/plan.service.ts", 58, { loc: 31 }],
  ["be:fn:AcmeCreditService.addCredits", "Function", "AcmeCreditService.addCredits", BE, "src/modules/acme/credit/credit.service.ts", 57, { loc: 44 }],
  ["be:fn:MailService.sendSeatChangeEmail", "Function", "MailService.sendSeatChangeEmail", BE, "src/modules/mail/mail.service.ts", 88, { loc: 27 }],
  ["be:fn:UserService.setNickname", "Function", "UserService.setNickname", BE, "src/modules/users/user.service.ts", 203, { loc: 22 }],
  ["be:fn:TeamService.listMembers", "Function", "TeamService.listMembers", BE, "src/modules/team/team.service.ts", 45, { loc: 58 }],
  ["be:fn:RoleService.getRolesForUser", "Function", "RoleService.getRolesForUser", BE, "src/modules/team/role.service.ts", 19, { loc: 14 }],
  ["be:fn:TeamService.resendInvite", "Function", "TeamService.resendInvite", BE, "src/modules/team/team.service.ts", 131, { loc: 35 }],
  ["be:fn:ProjectService.archive", "Function", "ProjectService.archive", BE, "src/modules/projects/project.service.ts", 210, { transactional: true, loc: 118 }],
  ["be:fn:StorageService.deleteProjectAssets", "Function", "StorageService.deleteProjectAssets", BE, "src/modules/storage/storage.service.ts", 74, { loc: 40 }],
  ["be:fn:StripeWebhookService.handleEvent", "Function", "StripeWebhookService.handleEvent", BE, "src/modules/acme/webhooks/stripe-webhook.service.ts", 31, { loc: 164 }],
  ["be:fn:ExportService.getExport", "Function", "ExportService.getExport", BE, "src/modules/exports/export.service.ts", 52, { loc: 29 }],
  ["be:fn:ExchangeRateClient.getRate", "Function", "ExchangeRateClient.getRate", BE, "src/common/fx/exchange-rate.client.ts", 12, { loc: 18 }],
  ["be:fn:ReportService.generateUsageReport", "Function", "ReportService.generateUsageReport", BE, "src/modules/reports/report.service.ts", 66, { transactional: true, loc: 141 }],
  // Jobs & queues
  ["be:job:UsageReportJob", "Job", "UsageReportJob", BE, "src/modules/reports/usage-report.job.ts", 15, { schedule: "0 3 * * *" }],
  ["be:queue:reports", "Queue", "reports", BE, "src/modules/reports/reports.queue.ts", 8],
  // Tables
  ["be:table:acme_subscriptions", "Table", "acme_subscriptions", BE, "src/modules/acme/entities/acme-subscription.entity.ts", 11, { entity: "AcmeSubscription", relations: [{ to: "users", column: "user_id", indexed: true }] }],
  ["be:table:acme_credits", "Table", "acme_credits", BE, "src/modules/acme/entities/acme-credit.entity.ts", 9, { entity: "AcmeCredit", relations: [{ to: "acme_subscriptions", column: "subscription_id", indexed: false }, { to: "users", column: "user_id", indexed: true }] }],
  ["be:table:users", "Table", "users", BE, "src/modules/users/user.entity.ts", 14, { entity: "User", relations: [] }],
  ["be:table:team_members", "Table", "team_members", BE, "src/modules/team/team-member.entity.ts", 8, { entity: "TeamMember", relations: [{ to: "users", column: "user_id", indexed: true }] }],
  ["be:table:user_roles", "Table", "user_roles", BE, "src/modules/team/user-role.entity.ts", 7, { entity: "UserRole", relations: [{ to: "users", column: "user_id", indexed: false }] }],
  ["be:table:projects", "Table", "projects", BE, "src/modules/projects/project.entity.ts", 12, { entity: "Project", relations: [{ to: "users", column: "owner_id", indexed: true }] }],
  ["be:table:exports", "Table", "exports", BE, "src/modules/exports/export.entity.ts", 10, { entity: "Export", relations: [{ to: "users", column: "user_id", indexed: false }] }],
  ["be:table:usage_events", "Table", "usage_events", BE, "src/modules/reports/usage-event.entity.ts", 6, { entity: "UsageEvent", relations: [{ to: "projects", column: "project_id", indexed: true }] }],
  // Externals
  ["ext:Stripe", "External", "Stripe", BE, "", 0],
  ["ext:S3", "External", "S3", BE, "", 0],
  ["ext:Mail", "External", "Mail", BE, "", 0],
  ["ext:HTTP", "External", "HTTP", BE, "", 0],
];

type RawEdge = [src: string, dst: string, kind: EdgeKind, attrs?: EdgeView["attrs"], confidence?: "inferred"];

const rawEdges: RawEdge[] = [
  ["fe:route:/settings/billing", "fe:cmp:BillingPage", "renders"],
  ["fe:cmp:BillingPage", "fe:cmp:AddonSeatsCard", "renders"],
  ["fe:cmp:BillingPage", "fe:cmp:InvoiceList", "renders"],
  ["fe:cmp:BillingPage", "fe:call:fetchSubscriptionAction", "calls"],
  ["fe:cmp:AddonSeatsCard", "fe:call:updateAddonSeatsAction", "calls"],
  ["fe:cmp:InvoiceList", "fe:call:fetchInvoicesAction", "calls"],
  ["fe:call:updateAddonSeatsAction", "be:op:mutation updateAddonSeats", "requests"],
  ["fe:call:fetchSubscriptionAction", "be:op:query subscription", "requests"],
  ["fe:route:/settings/profile", "fe:cmp:ProfilePage", "renders"],
  ["fe:cmp:ProfilePage", "fe:call:setNicknameAction", "calls"],
  ["fe:call:setNicknameAction", "be:op:mutation setNickname", "requests"],
  ["fe:route:/team/members", "fe:cmp:MembersPage", "renders"],
  ["fe:cmp:MembersPage", "fe:call:fetchTeamMembersAction", "calls"],
  ["fe:cmp:MembersPage", "fe:call:resendInviteAction", "calls"],
  ["fe:call:fetchTeamMembersAction", "be:op:query teamMembers", "requests"],
  ["fe:call:resendInviteAction", "be:op:mutation resendInvite", "requests"],
  ["fe:route:/projects/:id", "fe:cmp:ProjectPage", "renders"],
  ["fe:cmp:ProjectPage", "fe:call:archiveProjectAction", "calls"],
  ["fe:call:archiveProjectAction", "be:op:mutation archiveProject", "requests"],

  ["be:op:mutation updateAddonSeats", "be:guard:JwtAuthGuard", "guarded_by"],
  ["be:op:mutation updateAddonSeats", "be:guard:AcmeStripeBilling", "guarded_by"],
  ["be:op:mutation updateAddonSeats", "be:fn:AcmePlanService.updateAddonSeats", "handles"],
  ["be:fn:AcmePlanService.updateAddonSeats", "be:fn:AcmeCreditService.addCredits", "calls", { inTx: true }],
  ["be:fn:AcmePlanService.updateAddonSeats", "ext:Stripe", "calls_external", { method: "subscriptions.update", write: true, inTx: true, label: "subscriptions.update" }],
  ["be:fn:AcmePlanService.updateAddonSeats", "be:table:acme_subscriptions", "writes", { inTx: true, write: true }],
  ["be:fn:AcmePlanService.updateAddonSeats", "be:fn:MailService.sendSeatChangeEmail", "calls", { afterCommit: true }],
  ["be:fn:AcmeCreditService.addCredits", "be:table:acme_credits", "writes", { inTx: true, write: true }],
  ["be:fn:MailService.sendSeatChangeEmail", "ext:Mail", "calls_external", { method: "sendEmail", write: true, label: "sendEmail" }],

  ["be:op:query subscription", "be:guard:JwtAuthGuard", "guarded_by"],
  ["be:op:query subscription", "be:fn:AcmePlanService.getSubscription", "handles"],
  ["be:fn:AcmePlanService.getSubscription", "be:table:acme_subscriptions", "reads"],
  ["be:fn:AcmePlanService.getSubscription", "be:fn:ExchangeRateClient.getRate", "calls"],
  ["be:fn:ExchangeRateClient.getRate", "ext:HTTP", "calls_external", { method: "GET api.exchangerate.host", label: "GET" }, "inferred"],

  ["be:op:mutation setNickname", "be:guard:JwtAuthGuard", "guarded_by"],
  ["be:op:mutation setNickname", "be:fn:UserService.setNickname", "handles"],
  ["be:fn:UserService.setNickname", "be:table:users", "writes", { write: true }],

  ["be:op:query teamMembers", "be:guard:JwtAuthGuard", "guarded_by"],
  ["be:op:query teamMembers", "be:guard:TeamRoleGuard", "guarded_by"],
  ["be:op:query teamMembers", "be:fn:TeamService.listMembers", "handles"],
  ["be:fn:TeamService.listMembers", "be:table:team_members", "reads"],
  ["be:fn:TeamService.listMembers", "be:table:users", "reads"],
  ["be:fn:TeamService.listMembers", "be:fn:RoleService.getRolesForUser", "calls", { inLoop: true }],
  ["be:fn:RoleService.getRolesForUser", "be:table:user_roles", "reads"],

  ["be:op:mutation resendInvite", "be:fn:TeamService.resendInvite", "handles"],
  ["be:fn:TeamService.resendInvite", "be:table:team_members", "reads"],
  ["be:fn:TeamService.resendInvite", "ext:Mail", "calls_external", { method: "sendEmail", write: true, label: "sendEmail" }],

  ["be:op:mutation archiveProject", "be:guard:JwtAuthGuard", "guarded_by"],
  ["be:op:mutation archiveProject", "be:fn:ProjectService.archive", "handles"],
  ["be:fn:ProjectService.archive", "be:table:projects", "writes", { inTx: true, write: true }],
  ["be:fn:ProjectService.archive", "be:fn:StorageService.deleteProjectAssets", "calls", { inTx: true }],
  ["be:fn:StorageService.deleteProjectAssets", "ext:S3", "calls_external", { method: "deleteObjects", write: true, inTx: true, label: "deleteObjects" }],

  ["be:op:POST /webhooks/stripe", "be:fn:StripeWebhookService.handleEvent", "handles"],
  ["be:fn:StripeWebhookService.handleEvent", "be:table:acme_subscriptions", "writes", { write: true }],
  ["be:fn:StripeWebhookService.handleEvent", "be:fn:AcmeCreditService.addCredits", "calls", { inLoop: true }],

  ["be:op:GET /api/exports/:id", "be:guard:JwtAuthGuard", "guarded_by"],
  ["be:op:GET /api/exports/:id", "be:fn:ExportService.getExport", "handles"],
  ["be:fn:ExportService.getExport", "be:table:exports", "reads"],
  ["be:fn:ExportService.getExport", "ext:S3", "calls_external", { method: "getSignedUrl", label: "getSignedUrl" }],

  ["be:job:UsageReportJob", "be:fn:ReportService.generateUsageReport", "triggers"],
  ["be:fn:ReportService.generateUsageReport", "be:table:usage_events", "reads", { inTx: true }],
  ["be:fn:ReportService.generateUsageReport", "be:queue:reports", "enqueues", { afterCommit: true }],
];

export const edges: EdgeView[] = rawEdges.map(([src, dst, kind, attrs = {}, confidence], i) => ({
  id: i + 1, src, dst, kind, confidence: confidence ?? "exact", file: "", line: 0, attrs,
}));

const inTxIds = new Set(["be:fn:AcmeCreditService.addCredits", "be:fn:StorageService.deleteProjectAssets"]);

export const nodes: NodeView[] = raw.map(([id, kind, name, repo, file, line, attrs = {}]) => ({
  id, kind, name, repo, file, line,
  transactional: attrs.transactional === true,
  inTx: inTxIds.has(id),
  issueCount: 0, maxSeverity: null,
  outCount: edges.filter((e) => e.src === id).length,
  inCount: edges.filter((e) => e.dst === id).length,
  group: repo || (kind === "External" ? "External services" : kind === "Table" ? "Database" : "Queues"),
  attrs,
}));

const nodeById = new Map(nodes.map((n) => [n.id, n]));

export const rules: Omit<RuleInfo, "count" | "new">[] = [
  { id: "tx-external-call", title: "External call inside a DB transaction", description: "A transaction stays open while waiting on a third-party API.", severity: "error",
    why: "The transaction holds a DB connection and locks while waiting on the network, and a rollback can't undo the external change.", fix: "Move the call after commit with runOnTransactionCommit()." },
  { id: "tx-no-write", title: "Transaction with no writes", description: "A transaction is opened but nothing is written.", severity: "warn",
    why: "It takes a connection and locks for nothing.", fix: "Remove @Transactional() from this method." },
  { id: "n-plus-one", title: "N+1 query in loop", description: "A query runs once per item inside a loop.", severity: "warn",
    why: "One round-trip per item gets slow as data grows.", fix: "Load everything in one query before the loop." },
  { id: "id-without-actor", title: "Takes an ID but never checks the caller", description: "Handler accepts a resource/user ID but never compares it with the current user.", severity: "error",
    why: "Any logged-in user can pass someone else's id (IDOR).", fix: "Use the authenticated user's id or check permission first." },
  { id: "raw-error-in-handler", title: "Raw Error thrown in handler", description: "Handler throws a plain Error instead of a typed HTTP/GraphQL error.", severity: "warn",
    why: "Plain Errors become 500s with no useful message.", fix: "Throw a typed exception such as BadRequestException." },
  { id: "unvalidated-input", title: "Unvalidated input", description: "Input reaches the handler without validation.", severity: "warn",
    why: "Whatever the client sends reaches the service.", fix: "Use an input DTO with class-validator decorators." },
  { id: "unguarded-operation", title: "API without auth guard", description: "Operation is reachable without any authentication guard.", severity: "error",
    why: "Anyone who can reach the server can call it.", fix: "Add @UseGuards(JwtAuthGuard), or ignore it with a reason if it's public." },
  { id: "dead-reference", title: "Client calls an API that doesn't exist", description: "Frontend references an operation the backend no longer serves.", severity: "warn",
    why: "It breaks the build or fails at runtime.", fix: "Remove the import or restore the missing file/export." },
  { id: "contract-drift", title: "Client/server contract drift", description: "Client selects or sends fields the server schema doesn't define.", severity: "error",
    why: "The call fails at runtime.", fix: "Restore the backend operation or remove the dead call." },
];

const ruleById = new Map(rules.map((r) => [r.id, r]));

type RawIssue = [rule: string, status: "new" | "baseline", path: string[], message: string, why: string, fix: string, severity?: "error" | "warn"];

const rawIssues: RawIssue[] = [
  ["tx-external-call", "new",
    ["fe:route:/settings/billing", "fe:cmp:BillingPage", "fe:cmp:AddonSeatsCard", "fe:call:updateAddonSeatsAction", "be:op:mutation updateAddonSeats", "be:fn:AcmePlanService.updateAddonSeats", "ext:Stripe"],
    "Stripe subscriptions.update is called inside the transaction opened by AcmePlanService.updateAddonSeats.",
    "If Stripe succeeds but the transaction rolls back (e.g. addCredits fails), the customer is billed for seats they don't have. The open transaction also holds row locks for the whole Stripe round-trip.",
    "Commit the DB changes first, then call Stripe from an after-commit hook or an outbox job. Use an idempotency key so retries are safe."],
  ["tx-external-call", "baseline",
    ["fe:route:/projects/:id", "fe:cmp:ProjectPage", "fe:call:archiveProjectAction", "be:op:mutation archiveProject", "be:fn:ProjectService.archive", "be:fn:StorageService.deleteProjectAssets", "ext:S3"],
    "S3 deleteObjects runs inside the transaction opened by ProjectService.archive.",
    "Files are deleted permanently even if the archive transaction rolls back, leaving a live project with missing assets.",
    "Move asset deletion to an after-commit hook or a background job keyed by project id."],
  ["tx-no-write", "new",
    ["be:job:UsageReportJob", "be:fn:ReportService.generateUsageReport"],
    "ReportService.generateUsageReport opens a transaction but only reads usage_events.",
    "A read-only transaction on a large table holds a snapshot and connection for the whole report run, adding lock and pool pressure for no benefit.",
    "Remove @Transactional or use a read-only replica query without a transaction."],
  ["n-plus-one", "new",
    ["fe:route:/team/members", "fe:cmp:MembersPage", "fe:call:fetchTeamMembersAction", "be:op:query teamMembers", "be:fn:TeamService.listMembers", "be:fn:RoleService.getRolesForUser", "be:table:user_roles"],
    "RoleService.getRolesForUser queries user_roles once per member inside a loop in TeamService.listMembers.",
    "A team with 200 members triggers 200 extra queries per page load; latency grows linearly with team size.",
    "Load roles for all member ids in one query (WHERE user_id IN (...)) or use a DataLoader."],
  ["n-plus-one", "baseline",
    ["be:op:POST /webhooks/stripe", "be:fn:StripeWebhookService.handleEvent", "be:fn:AcmeCreditService.addCredits", "be:table:acme_credits"],
    "AcmeCreditService.addCredits is called once per invoice line item.",
    "Large invoices produce dozens of inserts and can time out the webhook, causing Stripe to retry and double-credit.",
    "Collect credits first and insert them in a single batch."],
  ["id-without-actor", "new",
    ["fe:route:/settings/profile", "fe:cmp:ProfilePage", "fe:call:setNicknameAction", "be:op:mutation setNickname", "be:fn:UserService.setNickname", "be:table:users"],
    "setNickname takes userId as an argument but never compares it to the authenticated user.",
    "Any logged-in user can set the nickname on any other account by sending a different userId (IDOR).",
    "Drop the userId argument and use @CurrentUser(), or assert userId === currentUser.id before writing."],
  ["id-without-actor", "baseline",
    ["be:op:GET /api/exports/:id", "be:fn:ExportService.getExport", "be:table:exports"],
    "GET /api/exports/:id loads an export by id without checking its owner.",
    "Export ids are sequential, so any user can download other customers' exports.",
    "Filter by owner: findOne({ id, userId: currentUser.id }) and return 404 otherwise."],
  ["raw-error-in-handler", "new",
    ["be:op:mutation archiveProject", "be:fn:ProjectService.archive"],
    "archiveProject throws new Error('Project already archived').",
    "Raw errors surface as INTERNAL_SERVER_ERROR, hide the real cause from the client and page on-call for a user mistake.",
    "Throw a typed error such as BadRequestException or a GraphQL UserInputError."],
  ["raw-error-in-handler", "baseline",
    ["be:op:GET /api/exports/:id", "be:fn:ExportService.getExport"],
    "getExport throws new Error('not found') when the export is missing.",
    "Clients get a 500 instead of a 404, and error monitoring fills with noise.",
    "Throw NotFoundException."],
  ["unvalidated-input", "new",
    ["be:op:mutation setNickname"],
    "Argument `code` is a plain String with no validation.",
    "Arbitrary strings (including very long or malformed codes) are written straight to users.nickname.",
    "Add a DTO with @IsString() @Length(4, 32) @Matches(/^[A-Z0-9-]+$/) and enable ValidationPipe."],
  ["unvalidated-input", "baseline",
    ["be:op:POST /webhooks/stripe", "be:fn:StripeWebhookService.handleEvent"],
    "Webhook body is typed `any` and used without signature verification.",
    "Anyone who finds the URL can post fake events and grant themselves credits.",
    "Verify the Stripe-Signature header with stripe.webhooks.constructEvent before handling."],
  ["unguarded-operation", "new",
    ["fe:route:/team/members", "fe:cmp:MembersPage", "fe:call:resendInviteAction", "be:op:mutation resendInvite"],
    "mutation resendInvite has no authentication guard.",
    "Unauthenticated callers can trigger invite emails to arbitrary addresses, which can be abused for spam and damages sender reputation.",
    "Add @UseGuards(JwtAuthGuard, TeamRoleGuard) to the resolver method."],
  ["unguarded-operation", "baseline",
    ["be:op:POST /webhooks/stripe"],
    "POST /webhooks/stripe has no guard.",
    "Webhooks are public by design, but without signature verification any caller is trusted.",
    "Keep it public but add a StripeSignatureGuard, or mark the route @Public() with a comment explaining the verification.", "warn"],
  ["dead-reference", "new",
    ["fe:route:/settings/billing", "fe:cmp:BillingPage", "fe:cmp:InvoiceList", "fe:call:fetchInvoicesAction"],
    "fetchInvoicesAction requests `query invoices`, which no backend resolver serves.",
    "The invoice list always fails at runtime; the error is swallowed and users see an empty list.",
    "Point the call at `query acmeInvoices` or restore the resolver."],
  ["contract-drift", "new",
    ["fe:route:/settings/billing", "fe:cmp:BillingPage", "fe:call:fetchSubscriptionAction", "be:op:query subscription"],
    "fetchSubscriptionAction selects `seatLimit`, which AcmeSubscription doesn't define.",
    "GraphQL rejects the whole query, so the billing page fails to load for every user.",
    "Use `addonSeats` (renamed in plan.resolver.ts) or add a field resolver for seatLimit."],
  ["contract-drift", "baseline",
    ["fe:route:/team/members", "fe:cmp:MembersPage", "fe:call:fetchTeamMembersAction", "be:op:query teamMembers"],
    "fetchTeamMembersAction selects `avatarUrl`, but TeamMember exposes `avatar`.",
    "Member avatars never render; the query returns a validation error in strict mode.",
    "Rename the selection to `avatar`.", "warn"],
];

export const issues: Issue[] = rawIssues.map(([rule, status, path, message, why, fix, severity], i) => {
  // The issue sits on the last code node of the path (not on the table/external it touches).
  const last = nodeById.get(path[path.length - 1])!;
  const at = last.kind === "Table" || last.kind === "External" ? nodeById.get(path[path.length - 2])! : last;
  const r = ruleById.get(rule)!;
  return {
    id: `${rule}:${at.id}:${i}`,
    rule, ruleTitle: r.title,
    severity: severity ?? (r.severity === "off" ? "warn" : r.severity),
    status, nodeId: at.id, nodeName: at.name, repo: at.repo, file: at.file, line: at.line,
    message, why, fix,
    path: path.map((id) => {
      const n = nodeById.get(id)!;
      return { id, kind: n.kind, name: n.name, repo: n.repo, file: n.file, line: n.line };
    }),
  };
});

for (const n of nodes) {
  const own = issues.filter((i) => i.nodeId === n.id);
  n.issueCount = own.length;
  n.maxSeverity = own.some((i) => i.severity === "error") ? "error" : own.length ? "warn" : null;
}

export const changedFiles: Record<string, string[]> = {
  backend: ["src/modules/acme/plan/plan.service.ts", "src/modules/acme/credit/credit.service.ts", "src/modules/users/user.resolver.ts"],
  frontend: ["src/pages/settings/billing/AddonSeatsCard.tsx", "src/store/billing/billing.thunks.ts"],
};
