#!/usr/bin/env node
/**
 * The 《MCP 工具参考》 (HeoPress P10 task 2.3): generated from the tool catalog the agent MCP endpoint lists
 * (`apps/cms/src/services/agent-access/mcp-tool-catalog.ts`, loaded with Node's type stripping), written to
 * `docs/zh-CN/agents/mcp-tools.md`. `--check` (in `pnpm check:all`) fails when the committed file differs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalog = path.join(root, 'apps/cms/src/services/agent-access/mcp-tool-catalog.ts');
const target = path.join(root, 'docs/zh-CN/agents/mcp-tools.md');

const { renderToolReference } = await import(pathToFileURL(catalog).href);
const generated = renderToolReference();

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = '';
  }
  if (current !== generated) {
    console.error(`[mcp-tool-reference] ${path.relative(root, target)} is out of date with the tool catalog. Run: pnpm docs:mcp-tools`);
    process.exit(1);
  }
  console.log('[mcp-tool-reference] ok');
} else {
  writeFileSync(target, generated);
  console.log(`[mcp-tool-reference] wrote ${path.relative(root, target)}`);
}
