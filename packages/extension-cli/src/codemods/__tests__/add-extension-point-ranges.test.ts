/**
 * Codemod `add-extension-point-ranges` (HeoPress P14 task 7.3; spec extensions/extension-point-versions "用迁移工具补全"):
 * a manifest that only declares the overall HeoPress range gets the current contract-version range for every extension
 * point it requests and for `context`; existing ranges are never changed and the transformation is deterministic.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCodemods } from '..';
import { addExtensionPointRanges } from '../add-extension-point-ranges';

const FIXTURES = path.resolve(__dirname, '../__fixtures__');
const ROOT = path.resolve(__dirname, '../../../../..');

let dir: string;

/** Copy one fixture manifest in under the name the codemod reads. */
function useManifest(fixture: string): void {
  copyFileSync(path.join(FIXTURES, fixture, 'heopress-extension.json.fixture'), path.join(dir, 'heopress-extension.json'));
}

const manifest = () => JSON.parse(readFileSync(path.join(dir, 'heopress-extension.json'), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'heopress-point-ranges-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('codemod add-extension-point-ranges', () => {
  it('adds the current range for each requested point and context', () => {
    useManifest('manifest-without-point-ranges');
    const report = runCodemods(dir, [addExtensionPointRanges], { write: true });
    expect(report.changed).toEqual([{ file: 'heopress-extension.json', codemods: ['add-extension-point-ranges'] }]);
    expect(report.manual).toEqual([]);
    expect(manifest()).toMatchObject({
      // The rest of the manifest is untouched.
      name: 'acme-seo-notes',
      heopress: '^1.0.0',
      // Two requested points, in table order, then context.
      extensionPoints: { events: '^1.0.0', jobs: '^1.0.0', context: '^1.0.0' },
    });
  });

  it('keeps every existing range and only fills the gaps', () => {
    useManifest('manifest-with-existing-point-ranges');
    runCodemods(dir, [addExtensionPointRanges], { write: true });
    expect(manifest().extensionPoints).toEqual({ events: '^0.9.0', jobs: '^1.0.0', context: '^0.8.0' });
  });

  it('is deterministic and a second run changes nothing', () => {
    useManifest('manifest-without-point-ranges');
    const dry = runCodemods(dir, [addExtensionPointRanges]);
    expect(dry.written).toBe(false);
    expect(manifest().extensionPoints).toBeUndefined();

    runCodemods(dir, [addExtensionPointRanges], { write: true });
    const once = readFileSync(path.join(dir, 'heopress-extension.json'), 'utf8');
    const again = runCodemods(dir, [addExtensionPointRanges], { write: true });
    expect(again.changed).toEqual([]);
    expect(readFileSync(path.join(dir, 'heopress-extension.json'), 'utf8')).toBe(once);
  });

  it.each([
    ['packages/plugin-glossary/heopress-extension.json'],
    ['examples/plugin-template/heopress-extension.json'],
  ])('the repository manifest %s is the codemod output (run the codemod when a plugin adds a point)', (rel) => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8')) as Record<string, unknown>;
    const result = addExtensionPointRanges.manifest!(manifest);
    expect(result.findings).toEqual([]);
    // Unchanged: the shipped manifest already declares every range the codemod would add.
    expect(result.manifest).toEqual(manifest);
  });

  it('reports a range for a point the plugin does not request and leaves it in place for a person', () => {
    useManifest('manifest-without-point-ranges');
    const current = manifest();
    // A range for a point no capability requests: the manifest rule refuses it, and the codemod says so.
    writeFileSync(
      path.join(dir, 'heopress-extension.json'),
      `${JSON.stringify({ ...current, extensionPoints: { routes: '^1.0.0' } }, null, 2)}\n`,
    );
    const report = runCodemods(dir, [addExtensionPointRanges], { write: true });
    expect(report.manual.map((m) => m.message)).toEqual([
      '"extensionPoints.routes" declares a range for a point the plugin does not request',
    ]);
    expect(report.manual[0]!.steps).toContain('ext:routes');
  });
});
