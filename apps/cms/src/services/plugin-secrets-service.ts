/**
 * Plugin secrets (HeoPress v1.2, spec extensions/plugin-secrets).
 *
 * A plugin declares named values in its manifest (`secrets:<name>`) and reads them at run time through
 * `ctx.secrets.get('<name>')`. This module is the store behind that reader and behind the site administrator's
 * endpoints:
 *
 * - the value is sealed with the runtime KEK through the existing envelope encryption (`services/crypto/secret-vault`),
 *   with the AAD `plugin-secret|<site>|<plugin>|<name>` — a ciphertext copied onto another plugin or site does not open;
 * - the row is keyed by `(site, plugin, name)` and nothing else, so a reinstall of the same plugin finds its secrets;
 * - no read path selects the ciphertext except {@link PluginSecretsService.resolve}, and no path returns or logs the
 *   plaintext: setting and deleting answer with the name and a `configured` flag only.
 */
import { and, eq } from 'drizzle-orm';
import { pluginSecrets, type Database } from '@heopress/database';
import type { KeyProvider } from '@heopress/runtime';
import { parseCapability } from '@heopress/contracts/extensions';
import { AuditLogger } from '../modules/audit/logger';
import { inSiteScope } from './site-scope';
import { runSiteTransaction } from './rls-transaction';
import { openSecret, sealSecret } from './crypto/secret-vault';

/** The largest value the API accepts (characters). API keys are far shorter; the bound keeps a request finite. */
export const PLUGIN_SECRET_MAX_CHARS = 8192;

/** The AAD a plugin secret's envelope is bound to. Must match the string used when the row was sealed. */
export function pluginSecretAad(siteId: string, plugin: string, name: string): string {
  return `plugin-secret|${siteId}|${plugin}|${name}`;
}

/** One row as the admin API sees it: never the ciphertext, never the value. */
export interface PluginSecretView {
  name: string;
  configured: boolean;
  /** Whether the plugin's manifest still declares `secrets:<name>` (a stored value for a dropped name can be removed). */
  declared: boolean;
}

/** A refused operation, with what the route answers. */
export class PluginSecretError extends Error {
  constructor(
    readonly code: 'INVALID_SECRET_NAME' | 'INVALID_SECRET' | 'SECRETS_UNAVAILABLE' | 'SECRET_NOT_FOUND',
    message: string,
    readonly status: 400 | 404 | 503,
  ) {
    super(message);
    this.name = 'PluginSecretError';
  }
}

interface PluginSecretActor {
  userId?: string | null;
  email?: string | null;
}

export interface PluginSecretsServiceDeps {
  db: Database;
  siteId: string;
  /** The plugin's name (the `extensions.name` the manifest declared), bound by the caller. */
  plugin: string;
  /** The runtime key provider; absent → the store cannot seal or open and refuses both (fail closed). */
  keys?: KeyProvider;
  actor?: PluginSecretActor;
}

/** Whether `name` is a legal `secrets:<name>` target (the same grammar the install path approved). */
export function isValidSecretName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && !('error' in parseCapability(`secrets:${name}`));
}

export class PluginSecretsService {
  constructor(private readonly deps: PluginSecretsServiceDeps) {}

  private get keys(): KeyProvider {
    if (!this.deps.keys) {
      throw new PluginSecretError('SECRETS_UNAVAILABLE', 'Plugin secrets are not available: no encryption key is configured.', 503);
    }
    return this.deps.keys;
  }

  /**
   * The declared names and whether each has a value, plus any stored name the manifest no longer declares.
   * The query selects `name` only, so a serialization mistake cannot carry a value or a fragment of one.
   */
  async list(declaredNames: readonly string[]): Promise<PluginSecretView[]> {
    const rows = await inSiteScope(this.deps.db, this.deps.siteId)
      .select({ name: pluginSecrets.name })
      .from(pluginSecrets)
      .where(and(eq(pluginSecrets.siteId, this.deps.siteId), eq(pluginSecrets.extensionName, this.deps.plugin)));
    const configured = new Set(rows.map((r) => r.name));
    const declared = new Set(declaredNames);
    const names = [...new Set([...declaredNames, ...configured])].sort();
    return names.map((name) => ({ name, configured: configured.has(name), declared: declared.has(name) }));
  }

  /** Set or rotate one value; the row keeps its identity and the audit records the name only. */
  async set(name: string, value: string, declaredNames: readonly string[] = []): Promise<PluginSecretView> {
    if (!isValidSecretName(name)) {
      throw new PluginSecretError('INVALID_SECRET_NAME', 'A secret name is 1–64 characters: letters, digits, "_" or "-".', 400);
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new PluginSecretError('INVALID_SECRET', 'A secret value is required.', 400);
    }
    if (value.length > PLUGIN_SECRET_MAX_CHARS) {
      throw new PluginSecretError('INVALID_SECRET', `A secret value is at most ${PLUGIN_SECRET_MAX_CHARS} characters.`, 400);
    }
    const sealed = await sealSecret(this.keys, value, pluginSecretAad(this.deps.siteId, this.deps.plugin, name));
    const now = new Date();
    const setByUserId = this.deps.actor?.userId ?? null;
    await runSiteTransaction(this.deps.db, this.deps.siteId, (tx) =>
      tx
        .insert(pluginSecrets)
        .values({
          siteId: this.deps.siteId,
          extensionName: this.deps.plugin,
          name,
          secretCiphertext: sealed.ciphertext,
          keyId: sealed.keyId,
          setByUserId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [pluginSecrets.siteId, pluginSecrets.extensionName, pluginSecrets.name],
          set: { secretCiphertext: sealed.ciphertext, keyId: sealed.keyId, setByUserId, updatedAt: now },
        }),
    );
    await this.audit('plugin_secret_set', name);
    return { name, configured: true, declared: declaredNames.includes(name) };
  }

  /** Delete one value; `false` when it was not configured. A refusal is not a write, so it writes no audit event. */
  async delete(name: string): Promise<boolean> {
    if (!isValidSecretName(name)) {
      throw new PluginSecretError('INVALID_SECRET_NAME', 'A secret name is 1–64 characters: letters, digits, "_" or "-".', 400);
    }
    const deleted = await runSiteTransaction(this.deps.db, this.deps.siteId, (tx) =>
      tx
        .delete(pluginSecrets)
        .where(
          and(
            eq(pluginSecrets.siteId, this.deps.siteId),
            eq(pluginSecrets.extensionName, this.deps.plugin),
            eq(pluginSecrets.name, name),
          ),
        )
        .returning({ name: pluginSecrets.name }),
    );
    if (deleted.length === 0) return false;
    await this.audit('plugin_secret_deleted', name);
    return true;
  }

  /**
   * The value a plugin reads at run time, or `null` when the site has not configured that name.
   *
   * A missing row and an unopenable row are deliberately different: `null` means "configure the secret", while a
   * `DecryptionError` means the stored row does not belong to this site/plugin/name (or its KEK is gone). Returning
   * `null` for the latter would hide a moved or corrupted row behind a "forgot to configure it" message.
   */
  async resolve(name: string): Promise<string | null> {
    const [row] = await inSiteScope(this.deps.db, this.deps.siteId)
      .select({ secretCiphertext: pluginSecrets.secretCiphertext })
      .from(pluginSecrets)
      .where(
        and(
          eq(pluginSecrets.siteId, this.deps.siteId),
          eq(pluginSecrets.extensionName, this.deps.plugin),
          eq(pluginSecrets.name, name),
        ),
      )
      .limit(1);
    if (!row) return null;
    return openSecret(this.keys, row.secretCiphertext, pluginSecretAad(this.deps.siteId, this.deps.plugin, name));
  }

  /** One audit entry per successful write: the site, the plugin and the name, never the value. */
  private async audit(event: 'plugin_secret_set' | 'plugin_secret_deleted', name: string): Promise<void> {
    await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
      event,
      actorEmail: this.deps.actor?.email ?? null,
      ip: null,
      userAgent: null,
      requestId: null,
      metadata: { siteId: this.deps.siteId, extensionName: this.deps.plugin, secretName: name },
    });
  }
}
