/**
 * The MCP tool catalog of the agent endpoint (HeoPress P10 tasks 2.1–2.5; spec agents/mcp-access "工具约束",
 * agents/site-scope; P10 tasks 4.1–4.4, agents/content-branches).
 *
 * Self-contained on purpose (no imports, erasable TypeScript only): `scripts/mcp-tool-reference.mjs` loads this file
 * directly with Node's type stripping to generate the 《MCP 工具参考》 and to check it in CI, so the reference can never
 * drift from what the server lists.
 *
 * Every tool declares:
 * - `group`: the tool group a grant must include (`read`, `content`, `publish`, `settings`, `theme`);
 * - `scope`: `site` (a required `siteId`), `instance` (`scope: { instance: true }`), `plan` (`scope: { planId }`) or
 *   `sites` (`scope` with exactly one of `siteIds` / `instance` / `planId`); there is no implicit "all sites";
 * - `effect`: `read`, `create` (explicit scope + `idempotencyKey`, no version of what does not exist yet), `update`
 *   (an existing resource: `expectedVersion` required) or `plan` (the batch-plan entry point);
 * - `planOnly`: a high-risk operation that is never written directly — the call is refused and pointed to
 *   `plans_submit`, even for a single site.
 */

export const TOOL_GROUPS = ['read', 'content', 'publish', 'settings', 'theme'] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

type ToolScope = 'site' | 'instance' | 'plan' | 'sites';
type ToolEffect = 'read' | 'create' | 'update' | 'plan';

export interface McpToolDefinition {
  name: string;
  title: string;
  group: ToolGroup;
  scope: ToolScope;
  effect: ToolEffect;
  planOnly?: boolean;
  /** English description (sent to clients). */
  description: string;
  /** zh-CN description (the generated reference). */
  descriptionZh: string;
  inputSchema: Record<string, unknown>;
}

const siteId = { type: 'string', description: 'The one site this call acts on. Required; there is no default site.' };
const expectedVersion = { type: 'integer', minimum: 1, description: 'The version you read; a stale version is a conflict.' };
const idempotencyKey = {
  type: 'string',
  minLength: 1,
  maxLength: 255,
  description: 'Unique per intended create; retrying with the same key and arguments returns the first result.',
};
const collection = { type: 'string', description: 'Collection name, e.g. "articles".' };
const itemId = { type: 'string', description: 'Item id.' };
const instanceScope = {
  type: 'object',
  description: 'Instance scope: { "instance": true }.',
  properties: { instance: { const: true } },
  required: ['instance'],
  additionalProperties: false,
};

function object(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'sites_list',
    title: 'List authorized sites',
    group: 'read',
    scope: 'instance',
    effect: 'read',
    description: 'Lists the sites this authorization covers and you can still access. Never lists other sites.',
    descriptionZh: '列出本授权覆盖且当前仍有权限的站点；不会列出其他站点。',
    inputSchema: object({ scope: instanceScope }, ['scope']),
  },
  {
    name: 'site_get',
    title: 'Read a site',
    group: 'read',
    scope: 'site',
    effect: 'read',
    description: 'Reads one site’s name, default language and branding.',
    descriptionZh: '读取一个站点的名称、默认语言与品牌设置。',
    inputSchema: object({ siteId }, ['siteId']),
  },
  {
    name: 'content_query',
    title: 'Query content',
    group: 'read',
    scope: 'site',
    effect: 'read',
    description: 'Lists items of one collection on one site, filtered by your permissions there.',
    descriptionZh: '列出一个站点某个集合的条目，按你在该站点的权限过滤。',
    inputSchema: object(
      {
        siteId,
        collection,
        filter: { type: 'object', description: 'Filter, e.g. { "status": { "_eq": "draft" } }.' },
        sort: { type: 'string', description: 'Comma-separated fields, "-" for descending.' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        offset: { type: 'integer', minimum: 0 },
        status: { type: 'string' },
      },
      ['siteId', 'collection'],
    ),
  },
  {
    name: 'content_get',
    title: 'Read an item',
    group: 'read',
    scope: 'site',
    effect: 'read',
    description: 'Reads one item with its version (use it as expectedVersion when changing the item).',
    descriptionZh: '读取一个条目及其版本号（修改时作为 expectedVersion 传回）。',
    inputSchema: object({ siteId, collection, id: itemId }, ['siteId', 'collection', 'id']),
  },
  {
    name: 'content_create',
    title: 'Create a draft',
    group: 'content',
    scope: 'site',
    effect: 'create',
    description: 'Creates a draft item on one site. Needs an idempotencyKey; never publishes.',
    descriptionZh: '在一个站点新建草稿条目；必须带 idempotencyKey，不会发布。',
    inputSchema: object(
      { siteId, collection, data: { type: 'object', description: 'Field values.' }, idempotencyKey },
      ['siteId', 'collection', 'data', 'idempotencyKey'],
    ),
  },
  {
    name: 'content_update',
    title: 'Update an item',
    group: 'content',
    scope: 'site',
    effect: 'update',
    description: 'Changes fields of one item on one site against the version you read. Does not change its status.',
    descriptionZh: '按读取时的版本修改一个站点上一个条目的字段；不改变发布状态。',
    inputSchema: object(
      { siteId, collection, id: itemId, expectedVersion, data: { type: 'object', description: 'Changed field values.' } },
      ['siteId', 'collection', 'id', 'expectedVersion', 'data'],
    ),
  },
  {
    name: 'content_publish',
    title: 'Publish an item',
    group: 'publish',
    scope: 'site',
    effect: 'update',
    description: 'Publishes one item on one site against the version you read; holds and publish checks still apply.',
    descriptionZh: '按读取时的版本发布一个站点上的一个条目；Hold 与发布检查照常生效。',
    inputSchema: object({ siteId, collection, id: itemId, expectedVersion }, ['siteId', 'collection', 'id', 'expectedVersion']),
  },
  {
    name: 'content_delete',
    title: 'Delete an item (plan only)',
    group: 'content',
    scope: 'site',
    effect: 'update',
    planOnly: true,
    description: 'Deleting is high risk: this tool never deletes directly and answers PLAN_REQUIRED; submit a plan with plans_submit.',
    descriptionZh: '删除属于高危操作：本工具从不直接删除，返回 PLAN_REQUIRED，请用 plans_submit 提交计划。',
    inputSchema: object({ siteId, collection, id: itemId, expectedVersion }, ['siteId', 'collection', 'id', 'expectedVersion']),
  },
  {
    name: 'branch_create',
    title: 'Create a content branch',
    group: 'content',
    scope: 'site',
    effect: 'create',
    description:
      'Starts a branch of one item: a private copy to edit without touching the item, based on the item as it is now. Needs an idempotencyKey (the same key returns the same branch). Returns the branch key and its revision.',
    descriptionZh: '为一个条目创建内容分支：基于条目当前内容的私有副本，修改不会影响条目本身。必须带 idempotencyKey（同一键返回同一分支）；返回分支键与分支版本。',
    inputSchema: object(
      { siteId, collection, id: itemId, name: { type: 'string', minLength: 1, maxLength: 200, description: 'A label people see in Studio.' }, idempotencyKey },
      ['siteId', 'collection', 'id', 'name', 'idempotencyKey'],
    ),
  },
  {
    name: 'branch_get',
    title: 'Read a content branch',
    group: 'read',
    scope: 'site',
    effect: 'read',
    description: 'Reads a branch: its data, its revision (use it as expectedVersion when changing or merging it), its state and the item version it is based on.',
    descriptionZh: '读取分支：数据、分支版本（修改或合并时作为 expectedVersion）、状态及其基于的条目版本。',
    inputSchema: object({ siteId, collection, id: itemId, branch: { type: 'string', description: 'The branch key.' } }, ['siteId', 'collection', 'id', 'branch']),
  },
  {
    name: 'branch_update',
    title: 'Change a content branch',
    group: 'content',
    scope: 'site',
    effect: 'update',
    description: 'Changes fields of a branch against the branch revision you read (expectedVersion). The item itself does not change.',
    descriptionZh: '按读取时的分支版本（expectedVersion）修改分支中的字段；条目本身不变。',
    inputSchema: object(
      {
        siteId,
        collection,
        id: itemId,
        branch: { type: 'string', description: 'The branch key.' },
        expectedVersion: { ...expectedVersion, description: 'The branch revision you read.' },
        data: { type: 'object', description: 'Changed field values.' },
      },
      ['siteId', 'collection', 'id', 'branch', 'expectedVersion', 'data'],
    ),
  },
  {
    name: 'branch_diff',
    title: 'Diff a content branch',
    group: 'read',
    scope: 'site',
    effect: 'read',
    description:
      'Field- and block-level differences: what the branch changed and what the item changed since the branch was made, and the conflicts a merge would have now (the same field or block changed on both sides), with the versions to merge against.',
    descriptionZh: '字段与区块级差异：分支改了什么、分支创建后条目本身改了什么，以及此刻合并会出现的冲突（两边改了同一字段或区块），并给出合并所需的版本号。',
    inputSchema: object({ siteId, collection, id: itemId, branch: { type: 'string', description: 'The branch key.' } }, ['siteId', 'collection', 'id', 'branch']),
  },
  {
    name: 'branch_merge',
    title: 'Merge a content branch',
    group: 'content',
    scope: 'site',
    effect: 'update',
    description:
      'Merges a branch with the item, checking both versions at once: a change to the item or the branch after you compared is a conflict (MERGE_STALE). Changes to different fields or blocks merge; the same field or block changed on both sides fails with the conflict list (MERGE_CONFLICT) — a person chooses in Studio. The result is a pending revision, never live: a person promotes it, and Hold and the publish checks apply.',
    descriptionZh:
      '合并分支与条目，同时校验两个版本：比较之后条目或分支又被修改即为冲突（MERGE_STALE）。不同字段或区块自动合并；两边修改同一字段或区块则失败并列出冲突（MERGE_CONFLICT），由人在后台选择。结果只是待发布修订，不会直接上线：由人提升，Hold 与发布检查照常生效。',
    inputSchema: object(
      {
        siteId,
        collection,
        id: itemId,
        branch: { type: 'string', description: 'The branch key.' },
        expectedVersion: { ...expectedVersion, description: 'The branch revision you compared.' },
        expectedMainVersion: { type: 'integer', minimum: 1, description: 'The item version you compared against (branch_diff mainVersion).' },
      },
      ['siteId', 'collection', 'id', 'branch', 'expectedVersion', 'expectedMainVersion'],
    ),
  },
  {
    name: 'media_upload_from_url',
    title: 'Upload an image from a URL',
    group: 'content',
    scope: 'site',
    effect: 'create',
    description: 'Fetches an image from a host on the site’s allowlist (through the SSRF guard) and stores it on that site.',
    descriptionZh: '从站点白名单中的主机抓取图片（经 SSRF 防护）并存入该站点。',
    inputSchema: object(
      { siteId, url: { type: 'string', format: 'uri', description: 'https URL of the image.' }, idempotencyKey },
      ['siteId', 'url', 'idempotencyKey'],
    ),
  },
  {
    name: 'seo_audit_issues',
    title: 'Site audit issues',
    group: 'read',
    scope: 'site',
    effect: 'read',
    description: 'The site audit’s issue list, as the audit page shows it to you.',
    descriptionZh: '站点审计问题清单，与后台审计页对你显示的内容一致。',
    inputSchema: object({ siteId, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, ['siteId']),
  },
  {
    name: 'seo_link_impact',
    title: 'Link change impact',
    group: 'read',
    scope: 'site',
    effect: 'read',
    description: 'Pages that may be affected when an item is unpublished, deleted or moved (from the link graph).',
    descriptionZh: '条目下线、删除或移动时可能受影响的页面（来自链接图）。',
    inputSchema: object(
      { siteId, itemId, depth: { type: 'integer', minimum: 1, maximum: 2 }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
      ['siteId', 'itemId'],
    ),
  },
  {
    name: 'translation_status',
    title: 'Translation status',
    group: 'read',
    scope: 'site',
    effect: 'read',
    description: 'An item’s translation status per language of the site (missing, stale, current).',
    descriptionZh: '条目在站点各语言下的翻译状态（缺失、过期、最新）。',
    inputSchema: object({ siteId, collection, id: itemId }, ['siteId', 'collection', 'id']),
  },
  {
    name: 'site_update_seo_settings',
    title: 'Update SEO / GEO settings',
    group: 'settings',
    scope: 'site',
    effect: 'update',
    description: 'Changes one site’s SEO / GEO settings against the version read (site administrators).',
    descriptionZh: '按读取时的版本修改一个站点的 SEO / GEO 设置（站点管理员）。',
    inputSchema: object(
      { siteId, expectedVersion, settings: { type: 'object', description: 'The settings to change.' } },
      ['siteId', 'expectedVersion', 'settings'],
    ),
  },
  {
    name: 'themes_list',
    title: 'List themes',
    group: 'read',
    scope: 'site',
    effect: 'read',
    description: 'The site’s themes and their versions.',
    descriptionZh: '站点的主题及其版本。',
    inputSchema: object({ siteId }, ['siteId']),
  },
  {
    name: 'theme_activate',
    title: 'Activate a theme (plan only)',
    group: 'theme',
    scope: 'site',
    effect: 'update',
    planOnly: true,
    description: 'Publishing a theme site-wide is high risk: this tool answers PLAN_REQUIRED; submit a plan with plans_submit.',
    descriptionZh: '全站主题发布属于高危操作：本工具返回 PLAN_REQUIRED，请用 plans_submit 提交计划。',
    inputSchema: object(
      { siteId, themeVersionId: { type: 'string' }, expectedVersion },
      ['siteId', 'themeVersionId', 'expectedVersion'],
    ),
  },
  {
    name: 'sites_create',
    title: 'Create a site',
    group: 'settings',
    scope: 'instance',
    effect: 'create',
    description:
      'Creates a site (instance administrators). Needs the instance scope and an idempotencyKey. The new site is not added to this authorization.',
    descriptionZh: '新建站点（实例管理员）；需要实例范围与 idempotencyKey。新站点不会自动加入本授权。',
    inputSchema: object(
      {
        scope: instanceScope,
        id: { type: 'string', description: 'The new site id: lowercase letters, digits, "-" and "_".' },
        name: { type: 'string' },
        defaultLanguage: { type: 'string' },
        idempotencyKey,
      },
      ['scope', 'id', 'name', 'idempotencyKey'],
    ),
  },
  {
    name: 'plans_submit',
    title: 'Submit a batch plan',
    group: 'read',
    scope: 'sites',
    effect: 'plan',
    description:
      'The only way to change two or more sites, or to run a high-risk operation (content_delete, theme_activate). Resolves the scope to a fixed list of site ids (sites created later never join), assigns the risk tier (>10 sites preview, >25 canary, >50 or high-risk highest) and returns the plan id and hash. Only a person approves and runs it in Studio; no tool approves. Plan operations: content_create, content_update, content_publish, content_delete, site_update_seo_settings, theme_activate.',
    descriptionZh:
      '修改两个及以上站点或执行高危操作（content_delete、theme_activate）的唯一入口。范围被解析并固化为站点 ID 清单（之后新建的站点不会加入），并分级（>10 站预览、>25 站金丝雀、>50 站或高危为最高级），返回计划 ID 与哈希。只能由人在后台审批与执行，没有任何审批工具。可用操作：content_create、content_update、content_publish、content_delete、site_update_seo_settings、theme_activate。',
    inputSchema: object(
      {
        scope: {
          type: 'object',
          description: 'Exactly one of { "siteIds": [...] } or { "instance": true } (every site this authorization covers).',
          properties: { siteIds: { type: 'array', items: { type: 'string' }, minItems: 1 }, instance: { const: true } },
          additionalProperties: false,
        },
        operation: { type: 'string', description: 'The tool to run on each site, e.g. "content_update".' },
        arguments: { type: 'object', description: 'Arguments shared by every site, without siteId.' },
        perSite: {
          type: 'object',
          description:
            'Per-site arguments keyed by site id, merged over `arguments`: the resource id and its expectedVersion (theme_activate: themeVersionId and expectedActiveVersionId).',
          additionalProperties: { type: 'object' },
        },
      },
      ['scope', 'operation'],
    ),
  },
  {
    name: 'plans_revise',
    title: 'Revise a plan',
    group: 'read',
    scope: 'plan',
    effect: 'plan',
    description:
      'Changes a plan you submitted that has not started: its sites (an explicit list), shared arguments or per-site arguments. The plan hash changes and every earlier approval stops counting; a person must approve it again.',
    descriptionZh: '修改你提交且尚未开始执行的计划：站点（显式清单）、共享参数或逐站参数。计划哈希随之改变，此前的审批全部失效，须由人重新审批。',
    inputSchema: object(
      {
        scope: { type: 'object', properties: { planId: { type: 'string' } }, required: ['planId'], additionalProperties: false },
        siteIds: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'The new, complete site list.' },
        arguments: { type: 'object' },
        perSite: { type: 'object', additionalProperties: { type: 'object' } },
      },
      ['scope'],
    ),
  },
  {
    name: 'plans_get',
    title: 'Read a plan',
    group: 'read',
    scope: 'plan',
    effect: 'read',
    description: 'Reads a batch plan you submitted: its status, risk tier, approvals and per-site results (succeeded, conflict, forbidden, failed, cancelled).',
    descriptionZh: '读取你提交的批量计划：状态、风险等级、审批情况与逐站结果（成功、冲突、无权限、失败、已取消）。',
    inputSchema: object(
      {
        scope: {
          type: 'object',
          properties: { planId: { type: 'string' } },
          required: ['planId'],
          additionalProperties: false,
        },
      },
      ['scope'],
    ),
  },
];

/** A tool by name. */
export function toolByName(name: string): McpToolDefinition | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}

/** The generated reference (zh-CN), one section per tool. */
export function renderToolReference(): string {
  const groupZh: Record<ToolGroup, string> = { read: '只读', content: '内容编辑', publish: '发布', settings: '站点设置', theme: '主题' };
  const scopeZh: Record<ToolScope, string> = {
    site: '单站（必填 `siteId`）',
    instance: '实例（`scope: { instance: true }`）',
    plan: '计划（`scope: { planId }`）',
    sites: '显式站点清单或实例（`scope.siteIds` / `scope.instance`，二选一）',
  };
  const effectZh: Record<ToolEffect, string> = {
    read: '只读',
    create: '新建（必填 `idempotencyKey`，不要求版本）',
    update: '修改已有资源（必填 `expectedVersion`）',
    plan: '批量计划入口',
  };
  const lines = [
    '<!-- 本文件由 `pnpm docs:mcp-tools` 根据 apps/cms/src/services/agent-access/mcp-tool-catalog.ts 生成，请勿手改。 -->',
    '',
    '# MCP 工具参考',
    '',
    '端点：`POST /api/v1/agents/mcp`（Streamable HTTP，JSON-RPC 2.0）。认证与授权见 [MCP 授权](./mcp-authorization.md)。',
    '',
    '| 工具 | 工具组 | 范围 | 类型 |',
    '|---|---|---|---|',
    ...MCP_TOOLS.map((t) => `| \`${t.name}\` | ${groupZh[t.group]} | ${scopeZh[t.scope]} | ${t.planOnly ? '仅计划（高危）' : effectZh[t.effect]} |`),
    '',
  ];
  for (const t of MCP_TOOLS) {
    lines.push(`## \`${t.name}\``, '', t.descriptionZh, '');
    lines.push(`- 工具组：${groupZh[t.group]}`);
    lines.push(`- 范围：${scopeZh[t.scope]}`);
    lines.push(`- 类型：${t.planOnly ? '仅计划（高危，直接调用返回 `PLAN_REQUIRED`）' : effectZh[t.effect]}`);
    lines.push('', '```json', JSON.stringify(t.inputSchema, null, 2), '```', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
