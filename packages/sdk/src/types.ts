// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
export type DefaultSchema = Record<string, Record<string, unknown>>;

export type ID = string;
export type Locale = string;
export type Brand<TBrand extends string, TValue> = TValue & {
  readonly __brand: TBrand;
};

export type AgentRiskLevel = "safe" | "review_required" | "dangerous" | "blocked";

export interface AgentGoalResource {
  id: string;
  siteId: string;
  title: string;
  description: string | null;
  source: string;
  createdBy: string | null;
  assigneeAgent: string;
  priority: string;
  deadline: string | null;
  status: string;
  successCriteria: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentGoalCreateInput {
  title: string;
  description?: string;
  source?: "user" | "flow" | "api" | "schedule";
  assigneeAgent?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  successCriteria?: Record<string, unknown>;
}

export interface AgentRunResource {
  id: string;
  goalId: string;
  siteId: string;
  agentName: string;
  provider: string;
  model: string;
  status: string;
  budget: Record<string, unknown>;
  policySnapshotHash: string | null;
  risk: AgentRiskLevel | string;
  metrics: Record<string, unknown>;
  error: string | null;
  retryOfRunId: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentToolResource {
  name: string;
  description: string;
  requiredCapabilities: string[];
  service: "schema" | "items" | "ai";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  riskPolicy: { level: AgentRiskLevel; approvalPolicy?: string };
  rateLimit: { maxCallsPerMinute?: number; maxCallsPerRun?: number };
  enabled: boolean;
  owner: string;
  extensionId?: string | null;
}

export interface AgentApprovalResource {
  id: string;
  runId: string;
  siteId: string;
  legacyApprovalId: string | null;
  subjectType: "plan" | "tool_call" | "artifact" | "schema_diff" | string;
  subjectId: string;
  status: string;
  approvalPolicy: string;
  requestedByAgent: string;
  decidedBy: string | null;
  decisionReason: string | null;
  expiresAt: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export type AgentArtifactType =
  | "schema_diff"
  | "page_spec"
  | "component_spec"
  | "seed_data"
  | "api_spec"
  | "prompt"
  | "migration";

export interface AgentArtifactResource {
  id: string;
  runId: string;
  siteId: string;
  type: AgentArtifactType | string;
  target: string | null;
  title: string;
  contentRef: string | null;
  content: Record<string, unknown>;
  hash: string;
  version: number;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentArtifactCreateInput {
  runId: string;
  type: AgentArtifactType;
  title: string;
  target?: string;
  content: Record<string, unknown>;
}

export interface AgentEvaluationResource {
  id: string;
  runId: string;
  siteId: string;
  artifactId: string | null;
  kind: string;
  status: "pass" | "warn" | "fail" | string;
  score: number | null;
  summary: string;
  details: Record<string, unknown>;
  artifactHash: string | null;
  createdAt: string;
}

export interface AgentMemoryResource {
  id: string;
  siteId: string;
  scope: string;
  scopeId: string | null;
  sourceType: string;
  sourceId: string | null;
  content: string;
  embedding: unknown;
  confidence: number;
  metadata: Record<string, unknown>;
  expiresAt: string | null;
  createdAt: string;
}

export interface AgentMemoryContext {
  siteId: string;
  memories: AgentMemoryResource[];
  recentRuns: AgentRunResource[];
  approvedArtifacts: AgentArtifactResource[];
}

export interface AgentMemoryWriteInput {
  scope: string;
  scopeId?: string;
  sourceType: string;
  sourceId?: string;
  content: string;
  confidence?: number;
}

export interface AgentGenerateAppInput {
  collections?: string[];
  targetApp?: string;
  constraints?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  approvalPolicy?: string;
}

export interface AgentGenerateAppResult {
  run: { goalId: string; runId: string; agentName: string };
  artifacts: AgentArtifactResource[];
  evaluations: AgentEvaluationResource[];
}

export type PrimaryKeyType =
  | "nanoid"
  | "uuid"
  | "integer"
  | "bigInteger"
  | "string";

export type StorageMode = "jsonb" | "materialized" | "physical" | "external";

export interface CollectionResource {
  id: string;
  siteId: string;
  name: string;
  label?: string | null;
  pluralLabel?: string | null;
  hidden?: boolean;
  system?: boolean;
  singleton: boolean;
  icon?: string | null;
  color?: string | null;
  note?: string | null;
  primaryKeyField?: string;
  displayTemplate: string | null;
  sortField: string | null;
  archiveField: string | null;
  archiveValue: string | null;
  unarchiveValue?: string | null;
  itemDuplicationFields?: string[];
  translations?: Record<string, unknown>;
  accountability?: "all" | "activity" | "none";
  versioning?: boolean;
  primaryKeyType?: PrimaryKeyType;
  storageMode?: StorageMode;
  meta: Record<string, unknown>;
  fields?: FieldResource[];
  systemFields?: FieldResource[];
  createdAt?: string;
  updatedAt?: string;
}

export type CollectionInput = Omit<
  Partial<CollectionResource>,
  "id" | "siteId" | "fields" | "systemFields" | "createdAt" | "updatedAt"
> & {
  name: string;
};

export interface FieldResource {
  id: string;
  collectionId: string;
  name: string;
  type: string;
  interface: string;
  display?: string | null;
  label?: string | null;
  note?: string | null;
  defaultValue?: unknown;
  nullable?: boolean;
  unique?: boolean;
  indexed?: boolean;
  searchable?: boolean;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  special?: unknown[];
  translations?: Record<string, unknown>;
  options?: Record<string, unknown>;
  displayOptions?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  conditions?: unknown[];
  required: boolean;
  readonly?: boolean;
  hidden: boolean;
  encrypted?: boolean;
  versioned?: boolean;
  rawEnabled?: boolean;
  width?: "half" | "full" | "fill";
  group?: string | null;
  sortOrder: number;
  system?: boolean;
  locked?: boolean;
  generated?: boolean;
  column?: string;
  renameFrom?: string;
  migrationPlan?: Record<string, unknown>;
  confirmRiskyChange?: boolean;
  [key: string]: unknown;
}

export type FieldInput = Omit<
  Partial<FieldResource>,
  "id" | "collectionId"
> & {
  name: string;
  type: string;
  interface: string;
};

export interface FieldMutationOptions {
  migrationPlan?: Record<string, unknown>;
  confirmRiskyChange?: boolean;
}

export interface FieldRenameInput extends FieldMutationOptions {
  type: string;
  interface: string;
  display?: string | null;
  label?: string | null;
  note?: string | null;
  defaultValue?: unknown;
  nullable?: boolean;
  unique?: boolean;
  indexed?: boolean;
  searchable?: boolean;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  special?: unknown[];
  options?: Record<string, unknown>;
  displayOptions?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  conditions?: unknown[];
  required?: boolean;
  readonly?: boolean;
  hidden?: boolean;
  encrypted?: boolean;
  versioned?: boolean;
  rawEnabled?: boolean;
  width?: "half" | "full" | "fill";
  group?: string | null;
  sortOrder?: number;
  [key: string]: unknown;
}

export interface FieldDeleteOptions extends FieldMutationOptions {
  force?: boolean;
  backupToRevisions?: boolean;
}

export interface RelationResource {
  id: string;
  siteId: string;
  manyCollection: string;
  manyField: string;
  oneCollection: string;
  oneField: string | null;
  junctionCollection: string | null;
  type?: RelationType;
  aliasField?: string | null;
  relatedDisplayTemplate?: string | null;
  junctionManyField?: string | null;
  junctionOneField?: string | null;
  sortField?: string | null;
  onDelete?: "restrict" | "cascade" | "set null" | "no action";
  meta?: Record<string, unknown>;
}

export type RelationType = "m2o" | "o2m" | "m2m" | "m2a";

export type RelationInput = Omit<
  Partial<RelationResource>,
  "id" | "siteId"
> & {
  manyCollection: string;
  manyField: string;
  oneCollection: string;
  type?: RelationType;
};

export type SchemaDiffRisk = "low" | "medium" | "high";

export type SchemaRuntimeImpact =
  | "cache_invalidation"
  | "permission_recompile"
  | "typegen_rebuild"
  | "data_migration_required"
  | "relation_reindex"
  | "storage_runtime_change";

export interface SchemaDiffEntry {
  name?: string;
  field?: string;
  identity?: string;
  type?: string;
  changes?: string[];
  risk: SchemaDiffRisk;
  runtimeImpact: SchemaRuntimeImpact[];
}

export interface SchemaDiff {
  risk: SchemaDiffRisk;
  runtimeImpact: SchemaRuntimeImpact[];
  collection: {
    added: string[];
    removed: string[];
    changed: SchemaDiffEntry[];
  };
  fields: {
    added: SchemaDiffEntry[];
    removed: SchemaDiffEntry[];
    changed: SchemaDiffEntry[];
  };
  relations: {
    added: SchemaDiffEntry[];
    removed: SchemaDiffEntry[];
    changed: SchemaDiffEntry[];
  };
}

export interface SchemaChangedEvent {
  type: "schema.changed";
  siteId: string;
  collection: string;
  affectedCollections: string[];
  diff: SchemaDiff;
}

export interface SchemaApplyResult {
  collection: CollectionResource;
  diff: SchemaDiff;
  affectedCollections: string[];
  event: SchemaChangedEvent;
}

export type SchemaApplyInput = Partial<CollectionInput> & {
  fields?: FieldInput[];
  relations?: RelationInput[];
};

export type SchemaDiffInput = SchemaApplyInput & {
  name: string;
};

export interface TypegenSchemaFilters {
  include?: string[];
  exclude?: string[];
}

export type ItemFilterOp =
  | "_eq"
  | "_neq"
  | "_in"
  | "_nin"
  | "_gt"
  | "_gte"
  | "_lt"
  | "_lte"
  | "_contains"
  | "_starts_with"
  | "_ends_with"
  | "_null"
  | "_nnull"
  // JSON field search: query into nested JSONB. A dotted field key
  // (e.g. "metadata.author.country") addresses a nested path; these operators
  // act on JSON containment / key existence.
  | "_json_contains"
  | "_has_key"
  | "_has_any_keys"
  | "_has_all_keys";

export interface ItemFilter {
  _and?: ItemFilter[];
  _or?: ItemFilter[];
  /** Field key; may be a dotted path into nested JSON, e.g. "meta.author.country". */
  [key: string]: { [op in ItemFilterOp]?: unknown } | ItemFilter[] | undefined;
}

export interface ListItemsParams {
  fields?: string[];
  filter?: ItemFilter;
  sort?: string[];
  limit?: number;
  offset?: number;
  status?: string | null;
  /**
   * Controls whether the server computes the `count(*)` total. `'total_count'`
   * (default) returns `meta.total`; `'none'` skips the extra aggregate query
   * for a cheaper list (e.g. infinite scroll) and omits `meta.total`.
   */
  meta?: 'total_count' | 'none';
}

/** Reserved metadata attributes present on every search hit. */
export interface SearchHitMeta {
  /** Which collection the hit belongs to. */
  _collection?: string;
  /** Human-readable display title derived at index time. */
  _title?: string;
  /** Item update timestamp, if available. */
  _updatedAt?: string | number;
}

export type SearchHit = SearchHitMeta & Record<string, unknown>;

export interface SearchParams {
  /** Restrict to one collection. Omit for cross-collection (global) search. */
  collection?: string;
  /** MeiliSearch filter expression. */
  filter?: string;
  /** Sort directives, e.g. `["_updatedAt:desc"]`. */
  sort?: string[];
  limit?: number;
  offset?: number;
}

export interface SearchResponse {
  data: SearchHit[];
  meta: {
    query: string;
    limit: number;
    offset: number;
    totalHits?: number;
    processingTimeMs?: number;
    /** Single-collection search: the collection searched. */
    collection?: string;
    /** Cross-collection search: the collections fanned out over. */
    collections?: string[];
    /** Cross-collection search: true when the collection set was capped. */
    truncated?: boolean;
  };
}

export interface ItemRow<
  TData extends Record<string, unknown> = Record<string, unknown>,
> {
  id: string;
  siteId: string;
  collectionId: string;
  status: string;
  data: TData;
  sort: number;
  /**
   * Incremented by every change. Pass it back as `expectedVersion` when you
   * update the item; a newer server version means someone else changed it
   * and the update fails with VERSION_CONFLICT (409).
   */
  version: number;
  /** Held items are never published (only a human with publish permission releases the hold). */
  hold: boolean;
  /** Content scheduling window (Publish_Window); null when not scheduled. */
  publishAt?: string | null;
  unpublishAt?: string | null;
  /** Editorial workflow state; null when the workflow is not in use. */
  editorialState?: string | null;
  userCreated: string | null;
  userUpdated: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface RevisionRow {
  id: string;
  siteId: string;
  collectionId: string;
  itemId: string;
  delta: {
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown>;
  };
  userId: string | null;
  createdAt: string;
  /* Provenance (content-os Req 1.1; content-os-ui Req 4.1). The CMS has
   * returned these columns since the content-os provenance migration —
   * optional here so older payloads stay assignable. */
  authorType?: "human" | "agent";
  createdByRunId?: string | null;
  model?: string | null;
  constitutionHash?: string | null;
  confidence?: number | null;
  sources?: unknown[] | null;
  staged?: boolean;
  autoCommitAt?: string | null;
}

export interface ListItemsResponse<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  data: ItemRow<T>[];
  meta: { total: number; limit: number; offset: number };
}

/* ---------------- Access (Phase C) ---------------- */

export type PermissionAction =
  | "create"
  | "read"
  | "update"
  | "delete"
  | "share"
  | "read_decrypted"
  /** Approve or reject an item in editorial review, per collection (HeoPress P07a). */
  | "review";

export interface RoleResource {
  id: string;
  siteId: string;
  key: string | null;
  systemKey: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  parentId: string | null;
  adminAccess: boolean;
  appAccess: boolean;
  createdAt?: string;
}

export interface RoleDetail extends RoleResource {
  policies: Array<{ policyId: string; priority: number }>;
  users: Array<{ userId: string }>;
}

export interface PolicyResource {
  id: string;
  siteId: string;
  key: string | null;
  name: string;
  icon: string | null;
  description: string | null;
  adminAccess: boolean;
  appAccess: boolean;
  enforceTfa: boolean;
  ipAllow: string[];
  ipDeny: string[];
  validFrom: string | null;
  validUntil: string | null;
  /** Top-level guardrails: time window, IP allow/deny. */
  rules: Record<string, unknown>;
  createdAt?: string;
}

export interface PermissionRow {
  id: string;
  siteId: string;
  policyId: string;
  collection: string;
  action: PermissionAction;
  permissions: Record<string, unknown>;
  validation: Record<string, unknown>;
  presets: Record<string, unknown>;
  fields: string[];
}

export interface PolicyDetail extends PolicyResource {
  permissions: PermissionRow[];
}

export interface CompiledPermission {
  collection: string;
  action: PermissionAction;
  rule: Record<string, unknown> | null;
  fields: string[];
  presets: Record<string, unknown>;
  validation: Record<string, unknown>;
  sources?: Array<{ policyId: string; policyName: string }>;
}

export interface PermissionBundle {
  admin: boolean;
  /** An instance administrator (the bootstrap account or an `admin` token role): the control plane admits it on every site. */
  instanceAdmin?: boolean;
  appAccess: boolean;
  tfaRequired: boolean;
  byKey: Record<string, CompiledPermission>;
  roles: Array<{
    id: string;
    name: string;
    adminAccess: boolean;
    appAccess: boolean;
  }>;
  policies: Array<{
    id: string;
    name: string;
    key: string | null;
  }>;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason: string | null;
  fields: string[];
  rule?: Record<string, unknown> | null;
  presets?: Record<string, unknown>;
}

export interface AccessConflict {
  severity: "warning" | "blocking";
  collection: string;
  action: PermissionAction;
  existingPolicy: string;
  incomingPolicy: string;
  reason: string;
}

export interface AccessConflictReport {
  ok: boolean;
  conflicts: AccessConflict[];
  warnings: AccessConflict[];
}

export interface AccessConflictCheckInput {
  target: { type: "role" | "user" | "api_key"; id: string };
  addPolicies?: string[];
  removePolicies?: string[];
}

/* ---------------- Non-staff access grants ---------------- */

/** Actions an operator may grant to a non-staff realm. */
export type GrantAction = "read" | "create" | "update" | "delete";

/** One `(collection, action)` grant held by a realm. */
export interface RealmAccessGrant {
  collection: string;
  action: GrantAction;
  /** Row scope: only `status = 'published'` rows. */
  publishedOnly: boolean;
  /** Row scope: only rows the principal created. Never set for `public`. */
  ownOnly: boolean;
  /** Field whitelist; `["*"]` = all, `["-secret"]` excludes. */
  fields: string[];
}

/**
 * A non-staff realm as the picker sees it: what it may be granted, and what it
 * currently holds. `allowedActions` and `supportsOwnOnly` are served by the
 * API rather than hard-coded client-side, so a realm's limits are stated once.
 */
export interface RealmAccessDescriptor {
  key: "public" | "subscriber";
  label: string;
  summary: string;
  allowedActions: GrantAction[];
  supportsOwnOnly: boolean;
  /** Whether an operator can turn the realm on and off (public only). */
  togglable: boolean;
  enabled: boolean;
  grants: RealmAccessGrant[];
}

export interface RealmAccessState {
  /** Grantable collections: non-system, non-hidden. */
  collections: Array<{ name: string; label: string | null }>;
  realms: RealmAccessDescriptor[];
}

export interface RealmGrantInput {
  collection: string;
  /** Defaults to `read`. */
  action?: GrantAction;
  publishedOnly?: boolean;
  ownOnly?: boolean;
  fields?: string[];
}

/* ---------------- Access Export / Import ---------------- */

export const ACCESS_EXPORT_SCHEMA = "heopress.access@v1";

export type AccessImportMode = "merge" | "replace-managed" | "replace-all";

export interface AccessExportManifest {
  schema: typeof ACCESS_EXPORT_SCHEMA;
  exportedAt: string;
  roles: AccessExportRole[];
  policies: AccessExportPolicy[];
  bindings: AccessExportBindings;
  apiKeys: AccessExportApiKey[];
}

export interface AccessExportRole {
  ref: string;
  key: string | null;
  systemKey: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  parent: string | null;
  adminAccess: boolean;
  appAccess: boolean;
}

export interface AccessExportPolicy {
  ref: string;
  key: string | null;
  name: string;
  icon: string | null;
  description: string | null;
  adminAccess: boolean;
  appAccess: boolean;
  enforceTfa: boolean;
  ipAllow: string[];
  ipDeny: string[];
  validFrom: string | null;
  validUntil: string | null;
  rules: Record<string, unknown>;
  permissions: AccessExportPermission[];
}

export interface AccessExportPermission {
  collection: string;
  action: PermissionAction;
  permissions: Record<string, unknown>;
  validation: Record<string, unknown>;
  presets: Record<string, unknown>;
  fields: string[];
}

export interface AccessExportBindings {
  rolePolicies: Array<{ role: string; policy: string; priority: number }>;
  userRoles: Array<{ userId: string; role: string; primary: boolean }>;
  userPolicies: Array<{ userId: string; policy: string; priority: number }>;
  apiKeyRoles: Array<{ apiKey: string; role: string; priority: number }>;
  apiKeyPolicies: Array<{ apiKey: string; policy: string; priority: number }>;
}

export interface AccessExportApiKey {
  ref: string;
  name: string;
  description: string | null;
  prefix: string;
  expiresAt: string | null;
  revokedAt: string | null;
  metadata: Record<string, unknown>;
}

export interface AccessImportIssue {
  code: string;
  message: string;
  path?: string;
}

export interface AccessImportDiffEntry {
  ref: string;
  status: "create" | "update" | "unchanged" | "delete";
}

export interface AccessImportDiffSection {
  create: number;
  update: number;
  unchanged: number;
  delete: number;
  entries: AccessImportDiffEntry[];
}

export interface AccessImportDiff {
  roles: AccessImportDiffSection;
  policies: AccessImportDiffSection;
  apiKeys: AccessImportDiffSection;
  bindings: {
    rolePolicies: AccessImportDiffSection;
    userRoles: AccessImportDiffSection;
    userPolicies: AccessImportDiffSection;
    apiKeyRoles: AccessImportDiffSection;
    apiKeyPolicies: AccessImportDiffSection;
  };
}

export interface AccessImportDryRunResult {
  dryRun: true;
  valid: boolean;
  errors: AccessImportIssue[];
  diff: AccessImportDiff;
  conflicts: AccessConflictReport;
}

export interface AccessImportSummary {
  mode: AccessImportMode;
  roles: AccessImportDiffSection;
  policies: AccessImportDiffSection;
  apiKeys: AccessImportDiffSection;
  bindings: AccessImportDiff["bindings"];
}

export interface AccessImportApplyResult
  extends Omit<AccessImportDryRunResult, "dryRun"> {
  dryRun: false;
  mode: AccessImportMode;
  applied: boolean;
  audit: {
    event: "access_import_applied";
    summary: AccessImportSummary;
  };
}

export interface AccessImportOptions {
  mode?: AccessImportMode;
}

export interface ApiKeyResource {
  id: string;
  siteId: string;
  name: string;
  description: string | null;
  prefix: string;
  createdBy: string | null;
  rotatedAt: string | null;
  rotatedBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  lastUsedUserAgent: string | null;
  metadata: Record<string, unknown>;
  /**
   * True for a client-embeddable `lbk_pub_…` key. Derived from the prefix
   * server-side, so it always matches the token the client actually holds.
   *
   * A publishable key is NOT a secret — treat its scope as fully public.
   */
  publishable: boolean;
  /** Origins the key may be used from in a browser. Empty = no constraint. */
  allowedOrigins: string[];
  createdAt: string;
  roles: Array<{ roleId: string; priority: number }>;
  policies: Array<{ policyId: string; priority: number }>;
}

export interface ApiKeyCreateInput {
  name: string;
  description?: string;
  expiresAt?: string | Date | null;
  metadata?: Record<string, unknown>;
  /** Mint a client-embeddable `lbk_pub_…` token. Defaults to false. */
  publishable?: boolean;
  /** Browser origins the key may be used from. Empty/omitted = no constraint. */
  allowedOrigins?: string[];
}

export interface ApiKeyRotateInput {
  expiresAt?: string | Date | null;
}

export interface ApiKeySecretResult extends ApiKeyResource {
  /** Plaintext token. Returned only by create/rotate responses. */
  token: string;
}

export interface ApiKeyRoleAttachment {
  apiKeyId: string;
  siteId: string;
  roleId: string;
  priority: number;
  createdAt?: string;
}

export interface ApiKeyPolicyAttachment {
  apiKeyId: string;
  siteId: string;
  policyId: string;
  priority: number;
  createdAt?: string;
}

export interface ShareResource {
  id: string;
  siteId: string;
  collection: string;
  itemId: string;
  roleId: string;
  validFrom: string | null;
  validUntil: string | null;
  maxUses: number | null;
  usedCount: number;
  revokedAt: string | null;
  revokedBy: string | null;
  createdBy: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ShareCreateInput {
  collection: string;
  itemId: string;
  roleId: string;
  password?: string;
  validFrom?: string | Date | null;
  validUntil?: string | Date | null;
  maxUses?: number | null;
}

export interface ShareSecretResult extends ShareResource {
  token: string;
  url: string;
}

export interface PresetResource {
  id: string;
  siteId: string;
  bookmark: string | null;
  collection: string;
  userId: string | null;
  roleId: string | null;
  layout: string;
  layoutQuery: Record<string, unknown>;
  layoutOptions: Record<string, unknown>;
  search: string | null;
  filter: Record<string, unknown>;
  icon: string | null;
  color: string | null;
  refreshInterval: number;
  createdAt: string;
}

export interface TranslationResource {
  id: string;
  siteId: string;
  language: string;
  namespace: string;
  key: string;
  value: string;
  status: string;
  updatedAt: string;
}

export interface SettingResource {
  id: string;
  siteId: string;
  key: string;
  value: Record<string, unknown>;
  scope: string;
  updatedAt: string;
}

/** A named parallel draft branch of a content item (content-versioning). */
export interface ContentVersion {
  id: string;
  siteId: string;
  itemId: string;
  collectionId: string;
  /** Stable slug, unique per item. */
  key: string;
  /** Human-readable label. */
  name: string;
  /** Snapshot of the item data for this branch. */
  data: Record<string, unknown>;
  /** Hash of main's data at snapshot time — detects divergence before promote. */
  hash: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** True when main's data changed since this version branched (list only). */
  mainChanged?: boolean;
}

/** One changed field between main and a version. */
export interface VersionFieldChange {
  field: string;
  main: unknown;
  version: unknown;
}

/** `GET …/versions/:key/compare` payload. */
export interface VersionCompare {
  main: Record<string, unknown>;
  version: Record<string, unknown>;
  changes: VersionFieldChange[];
}

/** Origin of a translation-memory entry. */
export type TmSource = "human" | "mt" | "imported";

/** A stored translation-memory pair for a language pair. */
export interface TmEntry {
  id: string;
  siteId: string;
  sourceLang: string;
  targetLang: string;
  sourceText: string;
  targetText: string;
  context: string | null;
  quality: number | null;
  source: TmSource;
  provider: string | null;
  hits: number;
  updatedAt: string;
}

/** A fuzzy-match suggestion surfaced from the TM store (score normalized to `similarity`). */
export interface TmSuggestion {
  targetText: string;
  /** Levenshtein similarity 0–100. */
  similarity: number;
  source: TmSource;
  entryId?: string;
}

/** Site (tenant) configuration row — identity, branding and theme defaults. */
export interface SiteResource {
  id: string;
  name: string;
  domain: string | null;
  displayTitle: string | null;
  siteUrl: string | null;
  descriptor: string | null;
  defaultLanguage: string;
  defaultAppearance: string;
  /** Default Studio save action: `stay` | `return` | `create_new`. */
  defaultSaveAction: string;
  branding: { logoUrl?: string; faviconUrl?: string; brandColor?: string };
  themeOverrides: {
    light?: Record<string, string>;
    dark?: Record<string, string>;
  };
  customCss: string | null;
  createdAt: string;
  updatedAt: string;
}

/** PATCH payload for `/api/v1/site`; every field optional. */
export type SiteConfigUpdate = Partial<
  Omit<SiteResource, 'id' | 'createdAt' | 'updatedAt'>
>;

/* ---------------- Custom domains ---------------- */

/** One DNS record the operator must publish, surfaced verbatim in the UI. */
export interface DomainVerificationRecord {
  /** `HTTP`: serve `value` at the URL in `name`. */
  type: 'CNAME' | 'TXT' | 'HTTP';
  name: string;
  value: string;
  purpose?: string;
}

/** A hostname registered for a site (free subdomain or custom domain). */
export interface DomainResource {
  id: string;
  hostname: string;
  kind: 'subdomain' | 'custom';
  isPrimary: boolean;
  /** `pending` until verified (serves nothing); `disabled` when switched off (HeoPress P04). */
  status: 'pending' | 'active' | 'disabled' | 'failed';
  statusReason: string | null;
  sslStatus: string | null;
  verificationMethod: 'dns_txt' | 'http_file';
  verificationExpiresAt: string | null;
  /** Set on a language entry domain: it keeps its own host. */
  entryLocale: string | null;
  verification: { records: DomainVerificationRecord[] };
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Body for `POST /api/v1/domains`. */
export interface DomainCreateInput {
  kind: 'subdomain' | 'custom';
  /** Full FQDN for `custom`; bare DNS label for `subdomain`. */
  hostname: string;
  verificationMethod?: 'dns_txt' | 'http_file';
  entryLocale?: string | null;
}

/** Body for `PATCH /api/v1/domains/:id`. */
export interface DomainUpdateInput {
  /** Switch off (`disabled`) or back on (`active`, only once verified). */
  status?: 'active' | 'disabled';
  /** Register (or clear) the domain as the site's entry for a language. */
  entryLocale?: string | null;
}

/* ---------------- Site content settings (HeoPress P05) ---------------- */

/** Whom a site speaks for (HeoPress P07): its structured data names it; empty fields are left out, never made up. */
export interface SiteIdentity {
  kind: 'organization' | 'person' | 'local_business';
  name: string;
  /** An absolute http(s) address, or empty. */
  logo: string;
  email: string;
  telephone: string;
  address: { streetAddress: string; addressLocality: string; addressRegion: string; postalCode: string; addressCountry: string };
  /** Official profiles: absolute addresses. */
  sameAs: string[];
}

/** `GET /api/v1/site/identity`: `identity` is null until set; `version` 0 then. */
export interface SiteIdentityResource {
  identity: SiteIdentity | null;
  version: number;
}

/** `PUT /api/v1/site/identity`: the identity (missing optional fields are empty) and the version it was read at. */
export type SiteIdentityInput = Pick<SiteIdentity, 'kind' | 'name'> & Partial<Omit<SiteIdentity, 'kind' | 'name'>> & { version: number };

/** `GET /api/v1/site/preset`: the site's content preset, null without one (HeoPress P07). */
export interface SitePresetResource {
  preset: string;
  version: number;
  installedAt: string;
  upgradedAt: string | null;
  /** What the last install or upgrade added and skipped (`reason`: why a field was left alone); null before it was kept. */
  report: {
    version: number;
    at: string;
    added: Array<{ collection: string; field?: string; relation?: string; permalink?: string; choices?: string[] }>;
    skipped: Array<{ collection: string; field?: string; relation?: string; reason: string }>;
    /** The shared schema caches of that install are still to be dropped (the worker retries). */
    cachesPending?: boolean;
  } | null;
}

/** `GET /api/v1/site/root-files`: a file served at the site's root (HeoPress P07). */
export interface SiteRootFileResource {
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  updatedAt: string;
  /** Only when one file is read. */
  content?: string;
}

/** A page an audit issue or link report names (HeoPress P07). */
export interface SitePageRef {
  itemId: string;
  collection: string;
  title: string;
  url: string | null;
}

/** `GET /api/v1/site/audit`: the site's audit issues the caller may see (HeoPress P07 tasks 5.1, 5.2). */
export interface SiteAuditResource {
  run: { lastRunAt: string | null; status: string | null; requested: boolean; truncated: boolean; error: string | null };
  rules: Array<{ id: string; severity: "error" | "warning" | "notice"; title: string; description: string }>;
  issues: Array<{
    id: string;
    rule: string;
    severity: "error" | "warning" | "notice";
    title: string;
    /** The rule's own details (the link, the value, the diagnostics). */
    evidence: Record<string, unknown>;
    /** The pages concerned that the caller may read. */
    pages: SitePageRef[];
    firstSeenAt: string;
    lastSeenAt: string;
  }>;
  total: number;
}

/** `GET /api/v1/site/audit/export`: the audit as a document for CI and agents (version 1; not wrapped in `data`). */
export interface SiteAuditExportResource extends Omit<SiteAuditResource, "issues"> {
  version: 1;
  siteId: string;
  generatedAt: string;
  issues: SiteAuditResource["issues"];
}

/** `GET /api/v1/site/links/report`: broken links and orphan pages (HeoPress P07 task 5.4). */
export interface SiteLinkReportResource {
  scan: { status: string; startedAt: string; finishedAt: string | null; processed: number; lastError: string | null } | null;
  broken: Array<{
    source: ({ kind: "item" } & SitePageRef) | { kind: "navigation"; linkId: string; label: string };
    field: string | null;
    position: number;
    href: string;
    anchorText: string;
    targetUrl: string;
    reason: "missing" | "unpublished" | "deleted";
  }>;
  brokenTotal: number;
  orphans: Array<SitePageRef & { locale: string; listing: boolean; navigation: number }>;
  orphansTotal: number;
  unchecked: number;
  truncated: boolean;
}

/** `GET /api/v1/site/links/impact/:itemId`: the pages that may be affected by a change of a page (HeoPress P07 task 5.5). */
export interface SiteLinkImpactResource {
  target: { itemId: string; collection: string; locale: string; path: string; url: string | null };
  links: Array<{
    depth: 1 | 2;
    source: ({ kind: "item" } & SitePageRef) | { kind: "navigation"; linkId: string; label: string };
    field: string | null;
    position: number;
    href: string;
    anchorText: string;
    /** For depth 2: the page of depth 1 it links to. */
    via?: string;
  }>;
  pages: number;
  truncated: boolean;
  limits: { depth: number; limit: number };
}

/** `GET /api/v1/site/ai-traffic`: the site's AI crawler reads and AI-referred visits, by day (HeoPress P07 task 6.2). */
export interface SiteAiTrafficResource {
  from: string;
  to: string;
  totals: { crawler: number; referral: number };
  byDay: Array<{ day: string; training: number; search: number; userFetch: number; referral: number }>;
  byAgent: Array<{ kind: "crawler" | "referral"; agent: string; operator: string; purpose: string | null; hits: number }>;
  topCrawled: Array<{ path: string; resource: string; hits: number }>;
  topLanding: Array<{ path: string; hits: number; sources: string[] }>;
}

/** A finding's severity in the reachability report (HeoPress P07 task 3.9). */
export type ReachabilitySeverity = "error" | "warning" | "notice";

/** The platform a site is deployed on: the reachability report's fix advice is written for it (HeoPress P07 task 3.9). */
export type ReachabilityPlatform = "vps" | "cloudflare" | "cloudflare-pages" | "vercel" | "netlify";

/**
 * `GET /api/v1/site/reachability`: the last online reachability check of the site's verified domains (HeoPress P07 task
 * 3.9) — what each address was expected to answer and answered, the simulated AI crawler requests (`simulated: true`:
 * made with the crawler's User-Agent, not by the crawler), AI crawler traffic hints, and advice for the platform.
 */
export interface SiteReachabilityResource {
  run: { requested: boolean; lastRunAt: string | null; status: string | null; error: string | null; platform: ReachabilityPlatform; hosts: string[] | null };
  report: {
    version: 1;
    platform: ReachabilityPlatform;
    startedAt: string;
    finishedAt: string;
    hosts: Array<{ hostname: string; primary: boolean; locale: string | null; reachable: boolean | null; skipped: string | null }>;
    checks: Array<{
      host: string;
      kind: string;
      url: string;
      expected: "public" | "absent";
      because: string;
      status: number | null;
      contentType: string | null;
      location: string | null;
      error: string | null;
      ok: boolean;
      skipped: boolean;
      code: string | null;
      severity: ReachabilitySeverity | null;
      detail: string;
      advice: string | null;
    }>;
    crawlers: Array<{
      host: string;
      crawler: string;
      userAgent: string;
      operator: string;
      purpose: string;
      simulated: true;
      allowedByRobots: boolean;
      status: number | null;
      outcome: "served" | "blocked" | "kept-out" | "inconclusive" | "skipped";
      ok: boolean;
      code: string | null;
      severity: ReachabilitySeverity | null;
      detail: string;
      advice: string | null;
    }>;
    traffic: Array<{ agent: string; operator: string; purpose: string; kind: "stopped" | "dropped"; activeDays: number; before: number; after: number; severity: "warning"; detail: string; advice: string | null }>;
    simulationNote: string;
    summary: { errors: number; warnings: number; passed: number; skipped: number };
    truncated: boolean;
  } | null;
  /** The domains a check may request: the site's verified domains that serve its pages. */
  hosts: Array<{ hostname: string; primary: boolean; locale: string | null }>;
  platforms: Array<{ id: ReachabilityPlatform; label: string }>;
}

/** `GET /api/v1/site/links/manual`: a registered navigation link (HeoPress P07 task 5.3). */
export interface SiteManualLinkResource {
  id: string;
  label: string;
  url: string;
  createdBy: string | null;
  createdAt: string;
}

/** A part of a contributed structured-data node left out, and why (HeoPress P07). */
export interface StructuredDataDiagnosticResource {
  code: string;
  /** `item`, `extension:<key>` or `core`. */
  source: string;
  message: string;
}

/** `GET /api/v1/site/structured-data`: what the site's structured-data contributions came to (HeoPress P07). */
export interface SiteStructuredDataResource {
  site: { nodes: Array<{ source: string; fragment: string; type: unknown }>; diagnostics: StructuredDataDiagnosticResource[] };
  items: Array<{ itemId: string; collection: string; locale: string; path: string; url: string | null; diagnostics: StructuredDataDiagnosticResource[] }>;
  itemsWithDiagnostics: number;
}

/** `GET /api/v1/site/content-settings`. */
export interface SiteContentSettingsResource {
  siteId: string;
  availableLocales: string[];
  timezone: string;
  siteType: string;
  trailingSlash: 'always' | 'never';
  localeStrategy: 'subdirectory' | 'subdomain' | 'domain';
  localePrefixMode: 'default_at_root' | 'all_prefixed';
  localePrefixes: Record<string, string>;
  permalinks: Record<string, string>;
  allowCrossSiteTranslations: boolean;
  /** Sponsored items carry a visible disclosure. */
  sponsorDisclosure: boolean;
  /** Links in sponsored items are marked `rel="sponsored"`. */
  sponsorRel: boolean;
  sponsorPolicyVersion: number;
  version: number;
}

/** Body for `PUT /api/v1/site/content-settings` (the whole settings, `version` as read). */
export type SiteContentSettingsInput = Omit<SiteContentSettingsResource, 'siteId' | 'sponsorPolicyVersion'> & {
  /** Required when the sponsor policy changes. */
  reason?: string;
  /** The sponsor switches turned off whose risk was shown and accepted. */
  riskAcknowledged?: Array<'disclosure' | 'rel'>;
};

/* ---------------- Editorial profile (HeoPress P05) ---------------- */

export interface EditorialProfileContent {
  audience: string;
  tone: string;
  glossary: Array<{ term: string; definition?: string; preferred?: string; avoid?: string[] }>;
  citationPolicy: string;
  structureRules: string[];
  qualityRules: string[];
  publishRules: string[];
  forbiddenTopics: string[];
}

/** One version of a site's editorial profile (`published`: the one in effect). */
export interface EditorialProfileVersion {
  version: number;
  status: 'draft' | 'published' | 'superseded';
  content: EditorialProfileContent;
  createdBy: string | null;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
}

/** A member of a translation group the caller may read (HeoPress P05). */
export interface TranslationGroupMember {
  itemId: string;
  siteId: string;
  collection: string;
  locale: string;
  role: 'source' | 'translation';
  internalOnly: boolean;
  status: string;
  version: number;
  title: string | null;
  /** Shared fields waiting to sync from the source, or null. */
  sharedSync: { status: 'pending' | 'blocked_permission' | 'blocked_hold'; fields: string[] } | null;
}

/**
 * A translation group as the caller sees it (HeoPress P05): members it may read in full; the others
 * only as the public sees them (`public`), or not at all.
 */
export interface TranslationGroupResource {
  id: string;
  version: number;
  sourceEpoch: number;
  sourceItemId: string | null;
  members: TranslationGroupMember[];
  public: Array<{ locale: string; url: string }>;
}

/** An item's translation state for one language of the site (HeoPress P05): computed, never set. */
export interface TranslationLocaleStatus {
  locale: string;
  state: 'missing' | 'draft' | 'in_review' | 'published' | 'stale';
  itemId: string | null;
}

/** An item's language switch entry (HeoPress P05): a public language version and its URL. */
export interface ItemAlternate {
  locale: string;
  url: string;
  current: boolean;
  /** Whether the member may be indexed (HeoPress P07): hreflang lists only these; a language switch may list all. */
  indexable: boolean;
}

/* ---------------- CDC ---------------- */

export type CdcConnectorType =
  | "debezium_kafka"
  | "materialized_engine"
  | "airbyte";

export type CdcPipelineStatus =
  | "active"
  | "paused"
  | "error"
  | "provisioning";

export type CdcDeploymentTarget = "docker_compose" | "cloudflare_workers";

export type CdcDeploymentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "rolled_back";

export interface CdcPipelineResource {
  id: string;
  siteId: string;
  pipelineName: string;
  connectorType: CdcConnectorType;
  status: CdcPipelineStatus;
  statusMessage: string | null;
  replicationTables: string[];
  config: Record<string, unknown>;
  lastSyncAt: string | null;
  lastSyncRecordCount: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CdcPipelineCreateInput {
  pipeline_name: string;
  cdc_connector_type: CdcConnectorType;
  source_database_connection: string;
  clickhouse_sink_connection: string;
  replication_tables: string[];
  intermediary_connection?: string;
  config?: Record<string, unknown>;
}

export interface CdcPipelinePatchInput {
  pipeline_name?: string;
  source_database_connection?: string;
  clickhouse_sink_connection?: string;
  intermediary_connection?: string | null;
  replication_tables?: string[];
  config?: Record<string, unknown>;
}

export interface CdcHealthCheckResult {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface CdcPipelineMetrics {
  pipelineId?: string;
  replicationLagMs: number;
  eventsPerSecond: number;
  errorCount: number;
  lastEventAt?: string | null;
  status?: string;
}

export interface CdcHealthMetricEntry {
  pipelineId: string;
  replicationLagMs: number;
  eventsPerSecond: number;
  errorCount: number;
  recordedAt: string;
}

export interface CdcDeploymentStep {
  id?: string;
  name: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  error?: string | Record<string, unknown>;
  [key: string]: unknown;
}

export interface CdcDeploymentResult {
  deploymentId: string;
  status: CdcDeploymentStatus;
  steps: CdcDeploymentStep[];
  completedAt: string;
  error?: {
    code?: string;
    description?: string;
    [key: string]: unknown;
  };
}

export interface CdcDeployInput {
  approach: CdcConnectorType;
  target: CdcDeploymentTarget;
  pipeline_id?: string;
  env?: Record<string, string>;
}

export interface CdcValidateEnvInput {
  approach: CdcConnectorType;
  target: CdcDeploymentTarget;
  env: Record<string, string>;
}

export interface CdcEnvValidationResult {
  valid: boolean;
  invalidFields: Array<{
    key: string;
    reason: string;
  }>;
}

export interface CdcRollbackResult {
  deploymentId: string;
  status: CdcDeploymentStatus;
  steps: CdcDeploymentStep[];
  rolledBackAt?: string;
  error?: string | Record<string, unknown>;
}

/* -------- Change Feed (first-party outbox+relay; distinct from the
 * ClickHouse CDC pipelines above). Mirrors packages/contracts/schemas/cdc-feed.ts
 * and the serialized SubscriptionRecord/delivery shapes. -------- */

export type CdcOperation = "create" | "update" | "delete";
export type CdcActorType = "user" | "api_key" | "agent" | "system";
export type CdcSource = "api" | "agent" | "flow" | "system";
export type CdcPayloadMode = "reference" | "snapshot";
export type CdcSubscriptionKind = "pull" | "webhook" | "extension";
export type CdcSubscriptionStatus = "active" | "paused" | "dead" | "stale";

/** A change-feed event envelope (schemaVersion 1). `id` is the idempotency key. */
export interface CdcEventEnvelope {
  id: string;
  type: string;
  schemaVersion: number;
  siteId: string;
  collection: string;
  itemId: string;
  operation: CdcOperation;
  occurredAt: string;
  actor: { type: CdcActorType; id?: string };
  source: CdcSource;
  changedFields?: string[];
  /** Present only in snapshot payload mode; pii/phi already masked. */
  data?: Record<string, unknown> | null;
  /** This event's keyset token — ack/resume marker. */
  cursor: string;
}

export interface CdcFeedPage {
  data: CdcEventEnvelope[];
  meta: { nextCursor: string | null; hasMore: boolean };
}

export interface CdcFeedReadParams {
  cursor?: string;
  collections?: string[];
  operations?: CdcOperation[];
  limit?: number;
  /** Long-poll budget in seconds (0/omitted = return immediately; server caps at 25). */
  wait?: number;
}

export interface CdcSubscriptionResource {
  id: string;
  siteId: string;
  name: string;
  kind: CdcSubscriptionKind;
  collections: string[];
  operations: CdcOperation[];
  payloadMode: CdcPayloadMode;
  cursor: string | null;
  status: CdcSubscriptionStatus;
  webhookId: string | null;
  extensionName: string | null;
  consecutiveFailures: number;
  lastDeliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
  lag: { events: number; behindMs: number | null };
}

export interface CdcSubscriptionCreateInput {
  name: string;
  kind: CdcSubscriptionKind;
  collections?: string[];
  operations?: CdcOperation[];
  payload_mode?: CdcPayloadMode;
  /** Required when kind=webhook (webhook must have a secret). */
  webhook_id?: string;
  /** Required when kind=extension. */
  extension_name?: string;
}

export interface CdcSubscriptionPatchInput {
  name?: string;
  collections?: string[];
  operations?: CdcOperation[];
  payload_mode?: CdcPayloadMode;
  /** Admin flip only between active/paused; dead/stale exit via replay. */
  status?: "active" | "paused";
}

/** Provide exactly one of cursor or occurredAfter (within retention). */
export interface CdcReplayInput {
  cursor?: string;
  occurredAfter?: string;
}

export interface CdcDeliveryResource {
  id: string;
  subscriptionId: string;
  eventIdFrom: string | null;
  eventIdTo: string | null;
  eventCount: number;
  attempt: number;
  status: "success" | "failed";
  httpStatus: number | null;
  errorMessage: string | null;
  durationMs: number;
  createdAt: string;
}

export interface UserResource {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
  status: string;
  lastSeenAt: string | null;
  roleId: string | null;
  joinedAt: string;
}

export interface TeamResource {
  id: string;
  siteId: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export interface TeamMemberResource {
  teamId: string;
  userId: string;
  addedAt: string;
}

export interface FolderResource {
  id: string;
  siteId: string;
  name: string;
  parent: string | null;
  createdAt: string;
}

export interface FileResource {
  id: string;
  siteId: string;
  storage: string;
  filenameDisk: string;
  filenameDownload: string;
  mime: string;
  filesize: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  folder: string | null;
  metadata: Record<string, unknown>;
  uploadedBy: string | null;
  createdAt: string;
}

export interface UploadTypeCatalogueEntry {
  mime: string;
  extensions: string[];
  label: string;
  note?: string;
}

export interface UploadConfigResource {
  /** Maximum accepted upload size, in bytes. */
  maxBytes: number;
  /** Allowed MIME types (the enforced allowlist). */
  allowedMimeTypes: string[];
  /** Extensions derived from the allowlist, for the file picker `accept`. */
  allowedExtensions: string[];
  /** Full catalogue of selectable types (label + extensions per MIME). */
  catalogue: UploadTypeCatalogueEntry[];
}

export interface WebhookResource {
  id: string;
  siteId: string;
  name: string;
  url: string;
  actions: string[];
  collections: string[];
  headers: Record<string, string>;
  status: string;
  secret: string | null;
  createdAt: string;
}

export interface ActivityResource {
  id: string;
  siteId: string;
  action: string;
  userId: string | null;
  collection: string | null;
  itemId: string | null;
  ip: string | null;
  userAgent: string | null;
  comment: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ExtensionResource {
  id: string;
  siteId: string | null;
  key: string | null;
  name: string;
  version: string;
  type: string;
  enabled: boolean;
  bundleUrl: string;
  manifest: Record<string, unknown>;
  /** The capabilities the admin approved; the sandbox grants only these. */
  capabilities: string[];
  /** The capabilities the installed version requests (HeoPress P12). */
  requestedCapabilities?: string[];
  /** `approved`, or `reconfirm` for a plugin migrated from the pre-P12 model that an admin must confirm. */
  permissionsStatus?: "approved" | "reconfirm";
  /** An upgrade waiting for the admin to approve the capabilities it adds. */
  pendingUpgrade?: ExtensionPendingUpgrade | null;
  marketplaceSlug?: string | null;
  installedBy: string | null;
  installedAt: string;
}

export interface ExtensionPendingUpgrade {
  version: string;
  requestedCapabilities: string[];
  diff: { added: string[]; removed: string[]; unchanged: string[] };
  requestedAt: string;
}

export interface ExtensionUpgradeResult {
  status: "upgraded" | "pending-approval";
  extension: ExtensionResource;
  diff: { added: string[]; removed: string[]; unchanged: string[] };
}

/** A plugin's collection on the site (HeoPress P12 task 2.1): `<namespace>__<collection>`, kept while its plugin is off. */
export interface PluginCollectionResource {
  id: string;
  name: string;
  namespace: string;
  plugin: string;
  label: string | null;
  items: number;
  /** The last export; deleting the namespace's data needs one made after the last item change. */
  export: { at: string; digest: string; items: number } | null;
}

/** An export of a namespace's plugin collections, with fields and every item (`heopress-plugin-collections@1`). */
export interface PluginCollectionsExport {
  format: "heopress-plugin-collections@1";
  siteId: string;
  namespace: string;
  plugin: string;
  exportedAt: string;
  digest: string;
  collections: Array<{
    name: string;
    label: string | null;
    fields: Array<Record<string, unknown>>;
    items: Array<Record<string, unknown>>;
  }>;
}

/** A plugin route that a site path already answers (HeoPress P12 task 2.2): enabling is refused with these. */
export interface ExtensionRouteConflict {
  route: string;
  path: string;
  reason: "system-path" | "locale-prefix" | "content" | "redirect" | "permalink" | "plugin";
  with?: string;
}

/* ---------------- AI Copilot (POST-GA1) ---------------- */

export type AIChatStatus = "executed" | "pending_approval" | "denied";

export interface AIChatResponse {
  status: AIChatStatus;
  message: string;
  conversationId: string;
  pendingId: string | null;
  result: Record<string, unknown> | null;
}

export interface AIConversation {
  id: string;
  siteId: string;
  userId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface AIMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls: Array<Record<string, unknown>> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export type AIApprovalStatus = "pending" | "approved" | "rejected";

export interface AIApproval {
  id: string;
  siteId: string;
  userId: string | null;
  conversationId: string | null;
  toolName: string;
  toolArgs: Record<string, unknown>;
  status: AIApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface AIFieldSuggestion {
  type: string;
  interface: string;
  confidence: number;
}

export interface AIContentAssistResult {
  content: string;
  tokensUsed: number;
}

/* ---------------- Flows Automation (POST-GA2) ---------------- */

export interface FlowNode {
  id: string;
  key: string;
  options?: Record<string, unknown>;
  next?: string | null;
  onError?: string | null;
}

export interface FlowGraph {
  entry?: string | null;
  nodes: FlowNode[];
}

export type FlowStatus = "active" | "inactive" | "draft";
export type FlowTriggerType = "webhook" | "event" | "schedule" | "manual";

export interface FlowResource {
  id: string;
  siteId: string;
  name: string;
  description: string | null;
  status: FlowStatus;
  triggerType: FlowTriggerType;
  triggerOptions: Record<string, unknown>;
  graph: FlowGraph;
  createdAt: string;
  updatedAt: string;
}

export type FlowRunStatus = "running" | "success" | "error";

export interface FlowRun {
  id: string;
  flowId: string;
  siteId: string;
  status: FlowRunStatus;
  input: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface FlowRunResult {
  runId: string;
  status: "success" | "error";
  steps: Array<Record<string, unknown>>;
  error: string | null;
}

/* ---------------- Marketplace (POST-GA3) ---------------- */

export interface MarketplaceExtension {
  id: string;
  name: string;
  slug: string;
  version: string;
  type: string;
  bundleUrl: string;
  /** Base64-encoded Ed25519 detached signature of SHA-256(bundle). */
  signature: string;
  keyId: string;
  manifest: Record<string, unknown>;
  capabilities: string[];
  publishedAt: string;
  verified: boolean;
}

export interface ListMarketplaceExtensionsParams {
  type?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface MarketplaceListResponse {
  data: MarketplaceExtension[];
  meta: { total: number; limit: number; offset: number };
}

/* ---------------- Materialized Collections (POST-GA4) ---------------- */

export type MaterializeRefreshStrategy = "auto" | "cron" | "manual";

export interface MaterializeProjection {
  fields: string[];
  orderBy?: string | null;
}

export interface MaterializedCollection {
  id: string;
  siteId: string;
  collection: string;
  target: string;
  refreshStrategy: MaterializeRefreshStrategy;
  refreshCron: string | null;
  projection: MaterializeProjection;
  filter: Record<string, unknown>;
  lastRefreshedAt: string | null;
  rowCount: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaterializeRefreshResult {
  rowsInserted: number;
  refreshedAt: string;
}

export interface MaterializeDataResponse {
  data: Array<Record<string, unknown>>;
  meta: { total: number; limit: number; offset: number };
}

/** Deployment integrations (spec: deployment-integrations). Token never serialized. */
export interface DeploymentTargetResource {
  id: string;
  provider: "vercel" | "netlify" | "cloudflare-pages";
  name: string;
  projectId: string;
  defaultBranch: string | null;
  productionUrl: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentResource {
  id: string;
  siteId: string;
  targetId: string;
  provider: string;
  providerDeploymentId: string | null;
  status: "queued" | "building" | "ready" | "error" | "canceled";
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  url: string | null;
  triggeredBy: string | null;
  triggerSource: "manual" | "auto" | "agent";
  errorMessage: string | null;
  logExcerpt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

/** Static deployments of an Astro site (HeoPress P11 tasks 4.3–4.5). */
export type StaticPlatform = "vps" | "cloudflare-pages" | "vercel" | "netlify";
export type StaticFeature = "noindex" | "markdown-canonical" | "redirect-301" | "gone-410" | "feeds" | "search" | "preview" | "analytics";

export interface StaticDeployResource {
  id: string;
  targetId: string | null;
  provider: StaticPlatform;
  kind: "deploy" | "rollback";
  generation: number;
  revision: number | null;
  status: "requested" | "uploading" | "succeeded" | "failed" | "refused";
  providerDeploymentId: string | null;
  url: string | null;
  error: string | null;
  log: string | null;
  warnings: string[] | null;
  reachability: {
    status: "passed" | "issues" | "skipped" | "failed";
    detail?: string;
    summary?: { errors: number; warnings: number; passed: number; skipped: number };
    issues?: Array<{ url: string; code: string | null; severity: string | null; detail: string; advice: string | null }>;
  } | null;
  rollbackOf: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface StaticSiteResource {
  enabled: boolean;
  theme: string | null;
  deployTargetId: string | null;
  platform: StaticPlatform;
  publishedRevision: number;
  activeGeneration: number | null;
  activeRevision: number | null;
  deployedGeneration: number | null;
  deployedRevision: number | null;
  /** The successful deploy a rollback would put back, if any. */
  rollbackCandidate: { id: string; generation: number; revision: number | null } | null;
  support: Record<StaticPlatform, Record<StaticFeature, { support: "yes" | "degraded" | "no"; note?: string }>>;
  deploys: StaticDeployResource[];
}

/** One entry's outcome in a bulk request (`items(...).bulk`). */
export interface BulkItemResult<TRow = unknown> {
  /** Position of the entry in the request. */
  index: number;
  id: string | null;
  status: "succeeded" | "unchanged" | "blocked" | "conflict" | "failed";
  /** Error or reason code, e.g. ITEM_HELD, VERSION_CONFLICT, ALREADY_PUBLISHED. */
  code?: string;
  message?: string;
  item?: TRow;
}
