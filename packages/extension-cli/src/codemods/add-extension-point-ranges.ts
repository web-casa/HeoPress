/**
 * Codemod `add-extension-point-ranges` (HeoPress P14 task 7.3, spec extensions/extension-point-versions
 * "用迁移工具补全"): a manifest that only declares the overall HeoPress version gets the current contract-version range
 * for every extension point it requests and for the plugin host API (`context`).
 *
 * | Change | Converted |
 * |---|---|
 * | a requested `ext:<point>` without a range in `extensionPoints` | yes: `^<current point version>` |
 * | no `context` range | yes: `^<current host API version>` |
 * | an existing range | never changed (a range pinned to an older point is the author's decision) |
 * | a range for a point the plugin does not request | reported: remove it, the manifest rule refuses it |
 * | `extensionPoints` that is not an object | reported |
 *
 * The result is deterministic: the same manifest always produces the same `extensionPoints`, and running the codemod
 * again changes nothing.
 */
import { EXTENSION_POINTS, EXTENSION_POINT_VERSIONS, type ExtensionPoint } from '@heopress/contracts/extensions';
import type { Codemod, Finding } from './framework';

/** The range written for a current contract version (`^1.0.0`). */
const extensionPointRange = (version: string): string => `^${version}`;

function requestedPoints(capabilities: unknown): ExtensionPoint[] {
  if (!Array.isArray(capabilities)) return [];
  const list = capabilities.filter((c): c is string => typeof c === 'string');
  return EXTENSION_POINTS.filter((point) => list.includes(`ext:${point}`));
}

export const addExtensionPointRanges: Codemod = {
  id: 'add-extension-point-ranges',
  title: 'Declare the contract-version range of every used extension point',
  from: 'a manifest with only the overall HeoPress version range',
  to: 'a manifest declaring `extensionPoints` for every used extension point and `context`',

  manifest(manifest) {
    const findings: Finding[] = [];
    const declared = manifest.extensionPoints;
    if (declared !== undefined && (declared === null || typeof declared !== 'object' || Array.isArray(declared))) {
      return {
        manifest,
        findings: [
          {
            line: 0,
            message: '"extensionPoints" is not an object',
            steps: 'Make it an object such as { "events": "^1.0.0", "context": "^1.0.0" }, then run the codemod again.',
          },
        ],
      };
    }
    const existing = (declared ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...existing };
    const requested = requestedPoints(manifest.capabilities);
    const requestedKeys = new Set<string>(requested);

    for (const point of requested) {
      if (typeof next[point] === 'string') continue;
      next[point] = extensionPointRange(EXTENSION_POINT_VERSIONS[point]);
    }
    if (typeof next.context !== 'string') next.context = extensionPointRange(EXTENSION_POINT_VERSIONS.context);

    for (const key of Object.keys(next)) {
      if (key === 'context' || (EXTENSION_POINTS as readonly string[]).includes(key)) continue;
      findings.push({
        line: 0,
        message: `"extensionPoints" declares "${key}", which is not an extension point or "context"`,
        steps: 'Remove it; a manifest may only declare ranges for the points it requests and for "context".',
      });
    }
    for (const [point, range] of Object.entries(next)) {
      if (!requestedKeys.has(point) && point !== 'context') {
        findings.push({
          line: 0,
          message: `"extensionPoints.${point}" declares a range for a point the plugin does not request`,
          steps: `Add the "ext:${point}" capability if the plugin uses it, otherwise remove the range.`,
        });
      }
      if (typeof range !== 'string') {
        findings.push({
          line: 0,
          message: `"extensionPoints.${point}" is not a version range`,
          steps: 'Write a semver range such as "^1.0.0".',
        });
      }
    }

    const changed = JSON.stringify(next) !== JSON.stringify(existing);
    return { manifest: changed ? { ...manifest, extensionPoints: next } : manifest, findings };
  },
};
