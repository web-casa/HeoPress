/**
 * Codemod `lumibase-to-heopress` (HeoPress P13 task 2.2): a plugin written for the LumiBase Extension SDK (0.x, before
 * the HeoPress fork) to the HeoPress 1.0 plugin API. The breaking changes, as listed in the release notes:
 *
 * | Change | Converted |
 * |---|---|
 * | `@lumibase/extension-sdk` → `@heopress/extension-sdk`, `@lumibase/sdk` → `@heopress/sdk` (imports, re-exports, `import()`, `require()`, `import('…')` types, `declare module`) | yes |
 * | the same packages in `package.json`, at the 1.0 range | yes |
 * | manifest file `lumibase-extension.json` → `heopress-extension.json` | yes |
 * | manifest `compatibleWith` → `heopress` (same value) | yes |
 * | a HeoPress range that excludes 1.0 (e.g. `^0.26.0`) | reported: test on 1.0, then widen it |
 * | other `@lumibase/*` packages (core internals) | reported: plugins may depend on the Extension SDK only |
 * | `LUMIBASE_*` environment variables | reported: plugins get no environment; use settings or secrets |
 * | a `lumibase-` plugin name | reported: renaming changes the plugin's identity on every site |
 * | a module name built at run time (`import(\`@lumibase/${x}\`)`) | reported |
 */
import ts from 'typescript';
import { satisfiesVersionRange } from '@heopress/contracts/extensions';
import { lineOf, type Codemod, type Finding, type TextEdit } from './framework';

/** The HeoPress plugin API this codemod targets. */
const TARGET_VERSION = '1.0.0';
/** The range written for the renamed SDK packages. */
const TARGET_SDK_RANGE = '^1.0.0-0';

const RENAMED: Record<string, string> = {
  '@lumibase/extension-sdk': '@heopress/extension-sdk',
  '@lumibase/sdk': '@heopress/sdk',
};

/** The new name of a module specifier, null when it is not a renamed package (a subpath keeps its subpath). */
function renamedSpecifier(spec: string): string | null {
  for (const [from, to] of Object.entries(RENAMED)) {
    if (spec === from) return to;
    if (spec.startsWith(`${from}/`)) return to + spec.slice(from.length);
  }
  return null;
}

function isOtherLumibase(spec: string): boolean {
  return spec.startsWith('@lumibase/') && renamedSpecifier(spec) === null;
}

function moduleSpecifiers(sf: ts.SourceFile): Array<ts.StringLiteralLike> {
  const out: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      out.push(node.moduleReference.expression);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      out.push(node.name);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      out.push(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const arg = node.arguments[0];
      if ((isImport || isRequire) && arg && ts.isStringLiteralLike(arg)) out.push(arg);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export const lumibaseToHeopress: Codemod = {
  id: 'lumibase-to-heopress',
  title: 'LumiBase Extension SDK → HeoPress 1.0 plugin API',
  from: 'LumiBase Extension SDK 0.x (`@lumibase/extension-sdk`, `lumibase-extension.json`)',
  to: `HeoPress ${TARGET_VERSION} (\`@heopress/extension-sdk\`, \`heopress-extension.json\`)`,

  renameFiles(rel) {
    return rel === 'lumibase-extension.json' ? 'heopress-extension.json' : null;
  },

  source({ sourceFile }) {
    const edits: TextEdit[] = [];
    const findings: Finding[] = [];
    for (const lit of moduleSpecifiers(sourceFile)) {
      const next = renamedSpecifier(lit.text);
      // Replace inside the quotes only: the quote style stays.
      if (next) edits.push({ start: lit.getStart(sourceFile) + 1, end: lit.getEnd() - 1, text: next });
      else if (isOtherLumibase(lit.text)) {
        findings.push({
          line: lineOf(sourceFile, lit.getStart(sourceFile)),
          message: `imports ${lit.text}, a LumiBase core package`,
          steps: 'Plugins depend on @heopress/extension-sdk only: use the plugin context (ctx.items, ctx.media, ctx.storage, ctx.settings, ctx.secrets) or copy the helper into the plugin.',
        });
      }
    }
    const visit = (node: ts.Node): void => {
      // `import(\`@lumibase/${x}\`)`, `require(prefix + name)`: the module is chosen at run time.
      if (ts.isCallExpression(node)) {
        const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
        const arg = node.arguments[0];
        if ((isImport || isRequire) && arg && !ts.isStringLiteralLike(arg) && arg.getText(sourceFile).includes('lumibase')) {
          findings.push({
            line: lineOf(sourceFile, arg.getStart(sourceFile)),
            message: 'loads a LumiBase module whose name is built at run time',
            steps: 'Import @heopress/extension-sdk (or the module you need) with a literal name.',
          });
        }
      }
      // `process.env.LUMIBASE_X`, `process.env['LUMIBASE_X']`, or the name as a string.
      if (ts.isPropertyAccessExpression(node) && node.name.text.startsWith('LUMIBASE_') && node.expression.getText(sourceFile).endsWith('env')) {
        findings.push(envFinding(sourceFile, node, node.name.text));
      } else if (ts.isStringLiteralLike(node) && /^LUMIBASE_[A-Z0-9_]+$/.test(node.text)) {
        findings.push(envFinding(sourceFile, node, node.text));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { edits, findings };
  },

  manifest(manifest) {
    const findings: Finding[] = [];
    // `compatibleWith` is the LumiBase name of `heopress`: same meaning, rename in place.
    let next: Record<string, unknown> = manifest;
    if ('compatibleWith' in manifest && !('heopress' in manifest)) {
      next = Object.fromEntries(Object.entries(manifest).map(([k, v]) => [k === 'compatibleWith' ? 'heopress' : k, v]));
    }
    const range = next.heopress;
    if (typeof range === 'string' && !satisfiesVersionRange(TARGET_VERSION, range)) {
      findings.push({
        line: 0,
        message: `declares HeoPress ${range}, which excludes ${TARGET_VERSION}: install and upgrade are refused`,
        steps: `Test the plugin on HeoPress ${TARGET_VERSION}, then set "heopress" to a range that includes it (e.g. "^1.0.0").`,
      });
    }
    if (typeof next.name === 'string' && next.name.startsWith('lumibase-')) {
      findings.push({
        line: 0,
        message: `plugin name "${next.name}" carries the LumiBase prefix`,
        steps: 'Choose a new name only together with a migration of its installs (the name is its identity on every site); the heopress- prefix is reserved for official plugins.',
      });
    }
    return { manifest: next, findings };
  },

  packageJson(pkg) {
    const findings: Finding[] = [];
    const next: Record<string, unknown> = { ...pkg };
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg[field];
      if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
      const out: Record<string, unknown> = {};
      for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
        const renamed = RENAMED[name];
        if (renamed && !(renamed in (deps as Record<string, unknown>))) out[renamed] = TARGET_SDK_RANGE;
        else {
          out[name] = range;
          if (name.startsWith('@lumibase/') && !renamed) {
            findings.push({
              line: 0,
              message: `${field} has ${name}, a LumiBase core package`,
              steps: 'Remove it once the code no longer imports it (see the source findings).',
            });
          }
        }
      }
      next[field] = out;
    }
    return { pkg: next, findings };
  },
};

function envFinding(sf: ts.SourceFile, node: ts.Node, name: string): Finding {
  return {
    line: lineOf(sf, node.getStart(sf)),
    message: `reads the environment variable ${name}`,
    steps: 'Plugins get no environment in HeoPress: declare a setting (manifest admin.settings, read with ctx.settings.all()) or a secret (capability secrets:<name>, read with ctx.secrets.get()).',
  };
}
