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
