/**
 * Plugin private storage (HeoPress P12 task 3.7, spec extensions/runtime-extensions "插件私有存储").
 *
 * Documents of one plugin on one site, in the namespaces its manifest declares — scan results, translation-state caches,
 * form submissions. Not content: no versions, no publishing, never in public output. Isolation is structural: the
 * service is bound to `(site, plugin)` by the host and every statement carries both, so a plugin cannot name another
 * plugin's or another site's documents. Queries may only filter on a declared index (`indexCovers`). Disabling a plugin
 * keeps its storage; `exportAll` gives everything before a deliberate purge.
 */
import { and, asc, count, desc, eq, gt, sql } from 'drizzle-orm';
import { pluginStorage, type Database } from '@heopress/database';
import { STORAGE_LIMITS, indexCovers } from '@heopress/contracts/extensions';
import { runSiteTransaction } from '../../services/rls-transaction';

export class PluginStorageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 413 = 400,
  ) {
    super(message);
    this.name = 'PluginStorageError';
  }
}

/** The namespaces a manifest declares: `storage: { <ns>: { indexes: [[field, …], …] } }`. */
export type DeclaredStorage = Record<string, { indexes?: string[][] }>;

export function declaredStorageOf(manifest: unknown): DeclaredStorage {
  const storage = (manifest as { storage?: unknown } | null)?.storage;
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) return {};
  return storage as DeclaredStorage;
}

export interface StoredDocument {
  id: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StorageQuery {
  /** Equality on scalar fields; the fields must be covered by a declared index. */
  where?: Record<string, string | number | boolean | null>;
  limit?: number;
  /** `id` of the last document of the previous page. */
  after?: string;
  /** `recent` (last updated first) or `id` (default). */
  order?: 'id' | 'recent';
}

type Row = typeof pluginStorage.$inferSelect;

function toDocument(r: Row): StoredDocument {
  return { id: r.docId, data: r.data, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

/** One declared namespace of one plugin on one site. */
export class PluginStorageCollection {
  constructor(
    private readonly db: Database,
    private readonly siteId: string,
    private readonly extensionName: string,
    readonly namespace: string,
    private readonly indexes: readonly string[][],
  ) {}

  private scope() {
    return and(
      eq(pluginStorage.siteId, this.siteId),
      eq(pluginStorage.extensionName, this.extensionName),
      eq(pluginStorage.namespace, this.namespace),
    );
  }

  private checkId(id: string): void {
    if (typeof id !== 'string' || !STORAGE_LIMITS.idPattern.test(id)) {
      throw new PluginStorageError('INVALID_ID', 'A document id is 1–128 characters: letters, digits, _ . : -.');
    }
  }

  async get(id: string): Promise<StoredDocument | null> {
    this.checkId(id);
    const [row] = await this.db.select().from(pluginStorage).where(and(this.scope(), eq(pluginStorage.docId, id))).limit(1);
    return row ? toDocument(row) : null;
  }

  async put(id: string, data: Record<string, unknown>): Promise<StoredDocument> {
    this.checkId(id);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new PluginStorageError('INVALID_DOCUMENT', 'A document is a JSON object.');
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json, 'utf8') > STORAGE_LIMITS.documentBytes) {
      throw new PluginStorageError('DOCUMENT_TOO_LARGE', `A document is at most ${STORAGE_LIMITS.documentBytes} bytes.`, 413);
    }
    const value = JSON.parse(json) as Record<string, unknown>;
    const [row] = await runSiteTransaction(this.db, this.siteId, (tx) =>
      tx
        .insert(pluginStorage)
        .values({ siteId: this.siteId, extensionName: this.extensionName, namespace: this.namespace, docId: id, data: value })
        .onConflictDoUpdate({
          target: [pluginStorage.siteId, pluginStorage.extensionName, pluginStorage.namespace, pluginStorage.docId],
          set: { data: value, updatedAt: new Date() },
        })
        .returning(),
    );
    return toDocument(row!);
  }

  async delete(id: string): Promise<boolean> {
    this.checkId(id);
    const rows = await runSiteTransaction(this.db, this.siteId, (tx) =>
      tx.delete(pluginStorage).where(and(this.scope(), eq(pluginStorage.docId, id))).returning({ id: pluginStorage.docId }),
    );
    return rows.length > 0;
  }

  private filter(where: StorageQuery['where']) {
    const fields = Object.keys(where ?? {});
    if (!indexCovers(this.indexes, fields)) {
      throw new PluginStorageError(
        'INDEX_REQUIRED',
        `Querying ${this.namespace} by ${fields.join(', ')} needs a declared index on those fields.`,
      );
    }
    for (const [k, v] of Object.entries(where ?? {})) {
      if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
        throw new PluginStorageError('INVALID_QUERY', `The value of ${k} must be a string, number, boolean or null.`);
      }
    }
    return fields.length > 0 ? sql`${pluginStorage.data} @> ${JSON.stringify(where)}::jsonb` : undefined;
  }

  async query(q: StorageQuery = {}): Promise<{ documents: StoredDocument[]; next: string | null }> {
    const limit = Math.min(STORAGE_LIMITS.pageSize.max, Math.max(1, Math.floor(q.limit ?? STORAGE_LIMITS.pageSize.default)));
    const recent = q.order === 'recent';
    const rows = await this.db
      .select()
      .from(pluginStorage)
      .where(and(this.scope(), this.filter(q.where), !recent && q.after ? gt(pluginStorage.docId, q.after) : undefined))
      .orderBy(recent ? desc(pluginStorage.updatedAt) : asc(pluginStorage.docId))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return { documents: page.map(toDocument), next: !recent && rows.length > limit ? page[page.length - 1]!.docId : null };
  }

  async count(where?: StorageQuery['where']): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(pluginStorage).where(and(this.scope(), this.filter(where)));
    return Number(row?.n ?? 0);
  }
}

/** The private storage of one plugin on one site. */
export class PluginStorage {
  constructor(
    private readonly db: Database,
    readonly siteId: string,
    readonly extensionName: string,
    private readonly declared: DeclaredStorage,
  ) {}

  get namespaces(): string[] {
    return Object.keys(this.declared);
  }

  /** A declared namespace; another name is refused (it could only be another plugin's or nobody's). */
  collection(namespace: string): PluginStorageCollection {
    const decl = this.declared[namespace];
    if (!decl || !Object.prototype.hasOwnProperty.call(this.declared, namespace)) {
      throw new PluginStorageError('UNDECLARED_NAMESPACE', `"${namespace}" is not a storage namespace this plugin declares.`, 403);
    }
    return new PluginStorageCollection(this.db, this.siteId, this.extensionName, namespace, decl.indexes ?? []);
  }

  /** Every document of the plugin on the site, by namespace (also namespaces a newer manifest no longer declares). */
  async exportAll(): Promise<{ plugin: string; siteId: string; exportedAt: string; namespaces: Record<string, StoredDocument[]> }> {
    const rows = await this.db
      .select()
      .from(pluginStorage)
      .where(and(eq(pluginStorage.siteId, this.siteId), eq(pluginStorage.extensionName, this.extensionName)))
      .orderBy(asc(pluginStorage.namespace), asc(pluginStorage.docId));
    const namespaces: Record<string, StoredDocument[]> = {};
    for (const r of rows) (namespaces[r.namespace] ??= []).push(toDocument(r));
    return { plugin: this.extensionName, siteId: this.siteId, exportedAt: new Date().toISOString(), namespaces };
  }

  /** Delete every document of the plugin on the site (a deliberate, separate operation; export first). */
  async purge(): Promise<number> {
    const rows = await runSiteTransaction(this.db, this.siteId, (tx) =>
      tx
        .delete(pluginStorage)
        .where(and(eq(pluginStorage.siteId, this.siteId), eq(pluginStorage.extensionName, this.extensionName)))
        .returning({ id: pluginStorage.docId }),
    );
    return rows.length;
  }
}
