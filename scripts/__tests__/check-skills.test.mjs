import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, findSkillErrors, parseSkill } from '../check-skills.mjs';

const skill = (tools, body = '') => `---\nname: s\ndescription: d\nheopress:\n  minVersion: 1.0.0-rc.4\n  mcpTools:\n${tools.map((t) => `    - ${t}`).join('\n')}\n---\n\n# S\n${body}\n`;

test('parses declared tools and tool names referenced in the body', () => {
  const s = parseSkill(skill(['sites_list', 'plans_submit'], 'Use `site_get` with `siteId`.'));
  assert.deepEqual(s.mcpTools, ['sites_list', 'plans_submit']);
  assert.deepEqual(s.bodyTools, ['site_get']);
  assert.equal(s.minVersion, '1.0.0-rc.4');
});

test('a renamed tool fails and names the Skill and the missing tool', () => {
  const tools = ['sites_list', 'site_get'];
  assert.deepEqual(findSkillErrors({ a: skill(['sites_list']) }, tools, '1.0.0-rc.4', ['a']), []);
  const errors = findSkillErrors({ a: skill(['sites_list', 'site_read']), b: skill(['site_get'], 'call `sites_enumerate`') }, tools, '1.0.0-rc.4', ['a', 'b']);
  assert.deepEqual(errors, ['skills/a/SKILL.md: declared MCP tool "site_read" does not exist', 'skills/b/SKILL.md: referenced MCP tool "sites_enumerate" does not exist']);
});

test('a missing official Skill, missing tools or a too-new minVersion fail', () => {
  assert.match(findSkillErrors({}, [], '1.0.0', ['x'])[0], /skills\/x: official Skill is missing/);
  assert.match(findSkillErrors({ a: skill([]) }, [], '1.0.0', ['a']).join(), /declares no/);
  assert.match(findSkillErrors({ a: skill(['t_x']) }, ['t_x'], '1.0.0-rc.3', ['a']).join(), /newer than/);
});

test('compares prerelease versions', () => {
  assert.ok(compareVersions('1.0.0-rc.4', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0-rc.10', '1.0.0-rc.4') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});
