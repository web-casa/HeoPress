#!/usr/bin/env node
/**
 * Official Skills check (HeoPress P10 task 5.1; spec agents/skills-pack "官方 Skills 与工具兼容").
 *
 * Every `skills/<id>/SKILL.md` declares, in its front matter, `heopress.minVersion` and `heopress.mcpTools`.
 * The check fails when a declared tool, or a tool-shaped name in backticks in the body, is not in the agent MCP tool
 * catalog (`apps/cms/src/services/agent-access/mcp-tool-catalog.ts`), when `minVersion` is missing or newer than this
 * release, or when one of the five official Skills is missing. Run in `pnpm check:all` (`pnpm skills:check`).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const OFFICIAL_SKILLS = ['site-management', 'news-research', 'translation-editing', 'seo-geo-editing', 'theme-design'];

/** Minimal front matter parser for the fixed shape the Skills use. */
export function parseSkill(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) return null;
  const [, head, body] = m;
  const name = /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? null;
  const minVersion = /^\s+minVersion:\s*(\S+)\s*$/m.exec(head)?.[1] ?? null;
  const toolsBlock = /^\s+mcpTools:\s*\n((?:\s+-\s+.*\n?)*)/m.exec(head)?.[1] ?? '';
  const mcpTools = [...toolsBlock.matchAll(/-\s+([^\s#]+)/g)].map((x) => x[1]);
  const bodyTools = [...new Set([...body.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((x) => x[1]))];
  return { name, minVersion, mcpTools, bodyTools };
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v ?? '');
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** semver comparison (prerelease identifiers compared field by field). */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`invalid version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const ps = x.pre.split('.');
  const qs = y.pre.split('.');
  for (let i = 0; i < Math.max(ps.length, qs.length); i++) {
    if (ps[i] === undefined) return -1;
    if (qs[i] === undefined) return 1;
    const pn = /^\d+$/.test(ps[i]);
    const qn = /^\d+$/.test(qs[i]);
    if (pn && qn && Number(ps[i]) !== Number(qs[i])) return Number(ps[i]) - Number(qs[i]);
    if (pn !== qn) return pn ? -1 : 1;
    if (ps[i] !== qs[i]) return ps[i] < qs[i] ? -1 : 1;
  }
  return 0;
}

/** @param skills {Record<string, string>} id → SKILL.md text; @returns error strings */
export function findSkillErrors(skills, toolNames, currentVersion, required = OFFICIAL_SKILLS) {
  const known = new Set(toolNames);
  const errors = [];
  for (const id of required) if (!(id in skills)) errors.push(`skills/${id}: official Skill is missing`);
  for (const [id, text] of Object.entries(skills)) {
    const where = `skills/${id}/SKILL.md`;
    const s = parseSkill(text);
    if (!s) {
      errors.push(`${where}: missing front matter`);
      continue;
    }
    if (!s.name) errors.push(`${where}: missing name`);
    if (!s.minVersion || !parseVersion(s.minVersion)) errors.push(`${where}: missing or invalid heopress.minVersion`);
    else if (compareVersions(s.minVersion, currentVersion) > 0) errors.push(`${where}: minVersion ${s.minVersion} is newer than ${currentVersion}`);
    if (s.mcpTools.length === 0) errors.push(`${where}: declares no heopress.mcpTools`);
    for (const t of s.mcpTools) if (!known.has(t)) errors.push(`${where}: declared MCP tool "${t}" does not exist`);
    for (const t of s.bodyTools) if (!known.has(t)) errors.push(`${where}: referenced MCP tool "${t}" does not exist`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { MCP_TOOLS } = await import(pathToFileURL(path.join(root, 'apps/cms/src/services/agent-access/mcp-tool-catalog.ts')).href);
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const dir = path.join(root, 'skills');
  const skills = {};
  for (const id of existsSync(dir) ? readdirSync(dir) : []) {
    const f = path.join(dir, id, 'SKILL.md');
    if (existsSync(f)) skills[id] = readFileSync(f, 'utf8');
  }
  const errors = findSkillErrors(skills, MCP_TOOLS.map((t) => t.name), version);
  if (errors.length) {
    for (const e of errors) console.error(`[skills] ${e}`);
    process.exit(1);
  }
  console.log(`[skills] ok (${Object.keys(skills).length} skills)`);
}
