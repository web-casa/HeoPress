/**
 * Extension points of the content pipeline (HeoPress P09 task 1.1): the `run gate` and `propose publish` operations
 * call whatever is installed here. The quality gate (`quality-gate/quality-gate.ts`) and the auto-publish decision
 * (`auto-publish/auto-publish.ts`) are built in: with nothing installed the pipeline runs them; one installed here
 * replaces it (tests, an embedding host). A production's output is always a draft: publishing only ever happens
 * through the auto-publish rules or a person.
 */

interface GateRequest {
  siteId: string;
  productionId: string;
  collection: string;
  itemId: string;
  /** The item version checked: a result is bound to it and lapses when the content changes. */
  itemVersion: number;
}

export interface GateOutcome {
  /** `passed` | `blocked` | `needs_review` | `pending` (no gate installed yet). */
  status: 'passed' | 'blocked' | 'needs_review' | 'pending';
  itemVersion: number;
  checks: Array<{ rule: string; status: 'passed' | 'blocked' | 'needs_review' | 'warning'; score?: number; evidence?: unknown }>;
  reason?: string;
  /** The stored gate result (`lumibase_quality_gate_results`), when the built-in gate made it. */
  resultId?: string;
  score?: number;
}

export interface QualityGateRunner {
  run(req: GateRequest): Promise<GateOutcome>;
}

interface PublishProposalRequest extends GateRequest {
  gate: GateOutcome | null;
}

export interface PublishProposal {
  /** `review_queue`: a person decides. Later slices add `veto_window`, `scheduled` (cadence), `published`. */
  decision: 'review_queue' | 'veto_window' | 'scheduled' | 'published';
  reason: string;
  itemVersion: number;
}

export interface PublishProposer {
  propose(req: PublishProposalRequest): Promise<PublishProposal>;
}

const reviewQueue: PublishProposer = {
  async propose(req) {
    return { decision: 'review_queue', reason: req.gate?.status === 'passed' ? 'auto_publish_not_installed' : 'gate_not_passed', itemVersion: req.itemVersion };
  },
};

/**
 * Plugin gate checks (HeoPress P12 task 4.2): the site's registered checks by rule (`ext:<namespace>:<id>`). Installed by
 * the process that loads plugins (`serve.ts`); without it a declared plugin check counts as `needs_review`.
 */
export type PluginGateChecks = (siteId: string) => Promise<ReadonlyMap<string, GateCheckFn>>;

/** The read-only view of a draft a plugin gate check receives (a frozen copy: changing it changes nothing). */
export interface GateCheckSubject {
  siteId: string;
  collection: string;
  itemId: string;
  itemVersion: number;
  /** `translate` | `rewrite` | `write` | … (the production's mode). */
  mode: string;
  locale: string | null;
  title: string;
  bodyHtml: string;
  fields: Record<string, unknown>;
  sources: Array<{ id: string; kind: string; url: string | null; licenceStatus: string | null; usageMode: string | null }>;
}

/** A plugin gate check: `{ verdict: 'passed' | 'blocked' | 'needs_review', evidence?, score?, suggestions? }`. */
export type GateCheckFn = (subject: Readonly<GateCheckSubject>) => Promise<unknown> | unknown;

let pluginGateChecks: PluginGateChecks | null = null;

export function setPluginGateChecks(next: PluginGateChecks | null): void {
  pluginGateChecks = next;
}

export const installedPluginGateChecks = (): PluginGateChecks | null => pluginGateChecks;

let gate: QualityGateRunner | null = null;
let proposer: PublishProposer = reviewQueue;

export function setQualityGateRunner(runner: QualityGateRunner | null): void {
  gate = runner;
}

export function setPublishProposer(next: PublishProposer | null): void {
  proposer = next ?? reviewQueue;
}

/** The installed gate runner; null: the pipeline runs the built-in quality gate. */
export const qualityGateRunner = (): QualityGateRunner | null => gate;
export const publishProposer = (): PublishProposer => proposer;
/** The proposer installed here, or null: the pipeline uses the built-in auto-publish rules (`auto-publish/`). */
export const installedPublishProposer = (): PublishProposer | null => (proposer === reviewQueue ? null : proposer);
