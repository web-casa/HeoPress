#!/usr/bin/env -S npx tsx
// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * `heopress` CLI dispatcher. Routes subcommands to script files.
 *
 * Usage:
 *   heopress typegen --site <siteId> --out ./types.ts
 *   heopress access export --site <siteId> --out access.json
 *   heopress upgrade check|run|status|rollback
 */

export {};

const [, , subcommand, ...rest] = process.argv;

if (!subcommand) {
  console.error('Usage: heopress <subcommand> [args]');
  console.error('Subcommands:');
  console.error('  typegen  Generate TypeScript types from a CMS site schema');
  console.error('  config   Import / export / diff site configuration');
  console.error('  access   Import / export access manifests');
  console.error('  migrations  Show migration version or run migration preflight');
  console.error('  reindex  Rebuild search indexes from the database');
  console.error('  vectors  Vector spaces: convert JSONB embeddings, switch or roll back a site model');
  console.error('  preset   Site network preset: upgrade a site (or all) — only adds');
  console.error('  import   Site import: bundle schema, Astro conversion, dry run, import, activation, URL comparison');
  console.error('  backup   Backups: run, list, verify, drill, prune, restore; single-site export and import as a new site');
  console.error('  upgrade  Upgrade this instance: check, run, status, rollback (backup, rehearsal, write freeze)');
  process.exit(1);
}

switch (subcommand) {
  case 'typegen': {
    process.argv = [process.argv[0] ?? 'node', process.argv[1] ?? 'heopress', ...rest];
    await import('./typegen.js');
    break;
  }
  case 'config': {
    process.argv = [process.argv[0] ?? 'node', process.argv[1] ?? 'heopress', ...rest];
    await import('./config-cli.js');
    break;
  }
  case 'access': {
    const accessCli = await import('./access-cli.js');
    process.exit(await accessCli.runAccessCli(accessCli.parseAccessArgs(rest)));
    break;
  }
  case 'migrations': {
    process.argv = [process.argv[0] ?? 'node', process.argv[1] ?? 'heopress', ...rest];
    await import('./migrations-cli.js');
    break;
  }
  case 'reindex': {
    process.argv = [process.argv[0] ?? 'node', process.argv[1] ?? 'heopress', ...rest];
    await import('./reindex.js');
    break;
  }
  case 'preset': {
    process.argv = [process.argv[0] ?? 'node', process.argv[1] ?? 'heopress', ...rest];
    await import('./preset-cli.js');
    break;
  }
  case 'import': {
    process.argv = [process.argv[0] ?? 'node', process.argv[1] ?? 'heopress', ...rest];
    await import('./import-cli.js');
    break;
  }
  case 'backup': {
    process.argv = [process.argv[0] ?? 'node', process.argv[1] ?? 'heopress', ...rest];
    await import('./backup-cli.js');
    break;
  }
  case 'upgrade': {
    const upgradeCli = await import('./upgrade-cli.js');
    process.exit(await upgradeCli.runUpgradeCli(rest));
    break;
  }
  case 'vectors': {
    process.argv = [process.argv[0] ?? 'node', process.argv[1] ?? 'heopress', ...rest];
    await import('./vectors-cli.js');
    break;
  }
  default:
    console.error(`Unknown subcommand: ${subcommand}`);
    process.exit(1);
}
