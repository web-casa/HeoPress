/**
 * The extension-point test matrix (HeoPress P12 task 9.1; ADR-0015, ADR-0017): for each of the nine extension points,
 * the tests that back each of its five cells. `extension-matrix.test.ts` checks that every cell has a test, that every
 * test named here exists in its file, and that a handoff carrying the matrix (after `MATRIX_MARKER`) shows this table.
 */
import { EXTENSION_POINTS, type ExtensionPoint } from '@heopress/contracts/extensions';

export const MATRIX_CELLS = ['declared', 'undeclared', 'cross-site', 'isolation', 'version'] as const;
export type MatrixCell = (typeof MATRIX_CELLS)[number];

/** What each cell asks (the column headings of the table). */
const CELL_TITLES: Record<MatrixCell, string> = {
  declared: '声明的使用生效',
  undeclared: '未声明的使用被拒',
  'cross-site': '跨站访问被拒',
  isolation: '插件异常被隔离',
  version: '契约版本不匹配被拒',
};

/** A test: its file (from the repository root) and its exact name. */
export interface MatrixTest {
  file: string;
  test: string;
}

const CMS = 'apps/cms/src/__tests__';
export const MATRIX_FILE = `${CMS}/extension-matrix.db.integration.test.ts`;
const CONTENT = `${CMS}/content-extensions.db.integration.test.ts`;
const CONTENT_UNIT = 'apps/cms/src/extensions/__tests__/content-extensions.test.ts';
const PIPELINE = `${CMS}/pipeline-extensions.db.integration.test.ts`;
const PIPELINE_DECL = `${CMS}/pipeline-declarations.test.ts`;
const PIPELINE_MANIFEST = 'apps/cms/src/extensions/__tests__/pipeline-manifest.test.ts';
const GATE = `${CMS}/quality-gate.db.integration.test.ts`;
const RUNTIME = `${CMS}/plugin-runtime.db.integration.test.ts`;
const PANELS = `${CMS}/plugin-panels.db.integration.test.ts`;
const SANDBOX = 'apps/cms/src/extensions/__tests__/sandbox.test.ts';
const CAPS = 'apps/cms/src/extensions/__tests__/capability-model.test.ts';
const ASTRO = `${CMS}/astro-engine.db.integration.test.ts`;
const GLOSSARY = `${CMS}/glossary-plugin.db.integration.test.ts`;
const PRE_PUBLISH = 'apps/cms/src/extensions/__tests__/pre-publish-manifest.test.ts';
const STEPS = 'apps/site-astro/src/__tests__/build-steps.test.ts';

const t = (file: string, test: string): MatrixTest => ({ file, test });
const m = (test: string): MatrixTest => t(MATRIX_FILE, test);
const EVENTS_ISOLATION =
  "9.1 events × isolation: a failing subscription is retried at its own position; other plugins' and sites' subscriptions carry on; a throwing declared hook is a recorded veto; a subscriber that does not load blocks nothing";
/** The contract-version cell every point shares (install, upgrade and approval refused). */
const version = (point: ExtensionPoint) => m(`9.1 ${point} × version: a manifest for another HeoPress version is refused at install, upgrade and approval`);

export const EXTENSION_MATRIX: Record<ExtensionPoint, Record<MatrixCell, MatrixTest[]>> = {
  collections: {
    declared: [t(CONTENT, '2.1: enabling installs the namespaced collection on this site only; items go through the mainline write path')],
    undeclared: [
      m('9.1 collections × undeclared: collections without ext:collections are refused at install and never installed from a row'),
      t(CONTENT_UNIT, 'each extension point needs its capability'),
    ],
    'cross-site': [m('9.1 collections × cross-site: a plugin reads its collection on its own site only, through its job on that site')],
    isolation: [m("9.1 collections × isolation: a plugin whose enable fails installs nothing; other plugins' collections and the site's content stay as they were")],
    version: [version('collections')],
  },
  routes: {
    declared: [
      t(CONTENT, "2.3: Classic serves the item and list routes with the plugin's templates; both are indexable sitemap entries"),
      t(CONTENT, '2.3: Astro builds the plugin pages from the page data; Classic and Astro say the same'),
    ],
    undeclared: [m('9.1 routes × undeclared: routes without ext:routes are refused at install; revoking ext:routes withdraws the pages')],
    'cross-site': [m("9.1 routes × cross-site: a plugin's routes exist on its own site only; another site's content at the same path is no conflict")],
    isolation: [
      m("9.1 routes × isolation: a plugin page that fails to render answers 500 alone; the site's other pages, other plugins and other sites are served"),
      t(CONTENT_UNIT, "task 9.1: an item route's Classic template places {% item_body %} exactly once, like the theme's item page (else every page of it would fail to render)"),
      t(CONTENT, '2.2: enabling is refused, with the conflicting paths listed: another plugin, existing content, a system path, a language prefix'),
    ],
    version: [version('routes')],
  },
  'source-adapters': {
    declared: [
      t(PIPELINE, 'a plugin source type is offered; its sources start with the default terms; the address must be a declared host'),
      t(PIPELINE, 'the adapter only discovers: its links are normalised, de-duplicated and become ordinary fetch jobs'),
    ],
    undeclared: [
      m('9.1 source-adapters × undeclared: an adapter declared without ext:source-adapters is neither offered nor loaded'),
      t(PIPELINE, 'an adapter reaching a host it did not declare fails the run as blocked; the refusal is recorded'),
    ],
    'cross-site': [m('9.1 source-adapters × cross-site: another site neither offers nor runs the adapter')],
    isolation: [m('9.1 source-adapters × isolation: a failing adapter fails its own run only; one that never loads fails in bounded time; others run')],
    version: [version('source-adapters')],
  },
  'gate-checks': {
    declared: [
      t(GATE, 'a core block stays blocked when the plugin check passes: plugin checks only add to the core checks'),
      t(GATE, 'enabling a plugin check makes an earlier pass stale; with only passing plugin checks the draft passes'),
    ],
    undeclared: [
      m('9.1 gate-checks × undeclared: checks declared without ext:gate-checks are neither part of the policy nor loaded'),
      t(PIPELINE_DECL, 'a plugin takes part when enabled, approved and holding the point capability'),
    ],
    'cross-site': [m("9.1 gate-checks × cross-site: a plugin's checks are part of its own site's gate only")],
    isolation: [
      t(GATE, "9.1 gate-checks × isolation: a check that throws and a plugin that does not load count as needs_review; the gate runs on and another plugin's check still decides"),
      t(GATE, 'the plugin check sees a frozen copy; a missing, slow or verdict-less check counts as needs_review; a plugin block blocks'),
    ],
    version: [version('gate-checks')],
  },
  jobs: {
    declared: [
      t(RUNTIME, 'runs one instance at a time per site, plugin and job'),
      t(RUNTIME, 'continues a long scan in batches from its saved progress, also after a run was cut short'),
    ],
    undeclared: [
      t(RUNTIME, 'a job on an undeclared extension point is never registered'),
      t(SANDBOX, 'refuses registering on an undeclared extension point; declared ones still work'),
    ],
    'cross-site': [
      m('9.1 jobs × cross-site: a job reads its own site only; a run for a site it is not installed on does not start'),
      t(RUNTIME, 'isolates plugins and sites, needs declared indexes, survives disabling'),
    ],
    isolation: [
      m('9.1 jobs × isolation: a failing job is recorded and retried alone; a plugin that never loads does not stall the scheduler for other plugins and sites'),
      t(RUNTIME, 'a run over its duration or request limit is terminated, not extended'),
      t(SANDBOX, 'a factory that never finishes fails the load within the load limit (P12 task 9.1)'),
    ],
    version: [version('jobs')],
  },
  endpoints: {
    declared: [
      t(RUNTIME, "accepts a form from the site's static deployment, refuses a foreign or missing origin"),
      t(RUNTIME, 'accepts a signed callback once; a forged or replayed one is refused'),
    ],
    undeclared: [
      t(RUNTIME, 'a disabled plugin or one without ext:endpoints has no endpoints'),
      t(SANDBOX, 'drops an exported handler without ext:endpoints but keeps the declared hooks'),
    ],
    'cross-site': [t(RUNTIME, "never reaches another site's data: the host decides the site, storage is per site")],
    isolation: [
      m('9.1 endpoints × isolation: a handler that throws answers 500 for its own endpoint; one that never loads answers 404 in bounded time; the others serve'),
      t(RUNTIME, 'answers 429 over the rate limit and 413 over the body limit'),
    ],
    version: [version('endpoints')],
  },
  events: {
    declared: [
      t(RUNTIME, 'a subscription that was off continues from its position, at least once, own collections only'),
      t(RUNTIME, 'a pre-publish hook can only veto: veto, an edit attempt and a timeout leave the item as it was'),
      t(GLOSSARY, 'after an article is published, its terms link to their pages and the references are recorded'),
    ],
    undeclared: [
      m('9.1 events × undeclared: a pre-publish hook needs ext:events and a manifest declaration; undeclared hooks and subscriptions are refused at load and recorded; publishing does not ask them'),
      t(RUNTIME, 'an undeclared pre-publish hook is refused at load and recorded, never run; the rest of the plugin works'),
      t(PRE_PUBLISH, 'needs ext:events and unique names'),
    ],
    'cross-site': [
      t(RUNTIME, 'a subscription that was off continues from its position, at least once, own collections only'),
      t(RUNTIME, 'fails closed: a plugin declaring pre-publish hooks whose bundle does not load blocks publishing until it is disabled'),
      m(EVENTS_ISOLATION),
    ],
    isolation: [
      m(EVENTS_ISOLATION),
      t(RUNTIME, 'a subscriber-only plugin whose bundle does not load never blocks publishing; it catches up once it loads'),
      t(RUNTIME, 'fails closed only on the collections the declared hooks cover'),
      t(RUNTIME, 'a declared hook the loaded plugin did not register refuses the publish (it cannot be asked)'),
      t(GLOSSARY, 'declares no pre-publish hook: with a bundle that does not load, publishing goes on'),
    ],
    version: [version('events')],
  },
  'admin-panels': {
    declared: [
      t(PANELS, 'lists the declarative pages and widgets of the active site only'),
      t(PANELS, 'settings: declared keys of the declared type, per site'),
    ],
    undeclared: [
      t(PANELS, 'no panel without ext:admin-panels, while disabled, or awaiting re-confirmation'),
      t(CAPS, 'refuses invalid capabilities, admin pages without ext:admin-panels, bad ranges, hosts with a scheme'),
    ],
    'cross-site': [
      t(PANELS, 'lists the declarative pages and widgets of the active site only'),
      t(PANELS, "an untrusted plugin's own frontend is not offered; a trusted one's is"),
    ],
    isolation: [
      m("9.1 admin-panels × isolation: a plugin with broken declarations does not take the other plugins' panels down"),
      t(PANELS, "an untrusted plugin's own frontend is not offered; a trusted one's is"),
    ],
    version: [version('admin-panels'), m('9.1 admin-panels × version: an official plugin whose listing needs a newer HeoPress is not auto-installed')],
  },
  'build-steps': {
    declared: [
      t(ASTRO, 'P12 task 4.3: once the operator marks a plugin as trusted its build steps run; a timed-out step fails the build and the live version stays'),
      t(STEPS, 'reads the page data and the built pages, writes its assets; its environment holds no CMS secret'),
    ],
    undeclared: [
      t(ASTRO, 'P12 task 4.3: a plugin the operator did not mark as trusted never runs build steps; the build records them as skipped'),
      t(PIPELINE_MANIFEST, 'each kind needs its extension point capability'),
    ],
    'cross-site': [m("9.1 build-steps × cross-site: a trusted plugin's steps run in its own site's build only")],
    isolation: [
      t(ASTRO, 'P12 task 4.3: once the operator marks a plugin as trusted its build steps run; a timed-out step fails the build and the live version stays'),
      t(STEPS, 'a step past its time is killed; the first failure stops the rest'),
      t(STEPS, 'a request to another host fails the step, whatever the step does with the error, and names the host'),
    ],
    version: [version('build-steps')],
  },
};

/** The line that precedes the matrix table in a handoff. */
export const MATRIX_MARKER = '<!-- extension-matrix: generated from apps/cms/src/__tests__/helpers/extension-matrix.ts -->';

const short = (file: string) => file.replace(/^apps\/cms\/src\/(__tests__\/)?/, '').replace(/^apps\//, '').replace(/\.test\.ts$/, '');
const cellText = (tests: MatrixTest[]) => tests.map((x) => `\`${short(x.file)}\` › ${x.test.replaceAll('|', '\\|')}`).join('<br>');

/** The matrix as a Markdown table: one row per extension point, one column per cell. */
export function renderMatrixTable(): string {
  const head = `| 扩展点 | ${MATRIX_CELLS.map((c) => `${CELL_TITLES[c]}`).join(' | ')} |`;
  const sep = `|${'---|'.repeat(MATRIX_CELLS.length + 1)}`;
  const rows = EXTENSION_POINTS.map((p) => `| \`ext:${p}\` | ${MATRIX_CELLS.map((c) => cellText(EXTENSION_MATRIX[p][c])).join(' | ')} |`);
  return [head, sep, ...rows].join('\n');
}
