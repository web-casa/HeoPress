/**
 * Extension points of the content pipeline (HeoPress P09 task 1.1): the `run gate` and `propose publish` operations
 * call whatever is installed here. Slice 3 installs the quality gate, slice 4 the auto-publish decision; until then
 * the gate answers `pending` and every proposal goes to the review queue. Neither default can publish, and a
 * production's output is always a draft: publishing only ever happens through the auto-publish rules (slice 4) or a
 * person.
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

const pendingGate: QualityGateRunner = {
  async run(req) {
    return { status: 'pending', itemVersion: req.itemVersion, checks: [], reason: 'quality_gate_not_installed' };
  },
};

const reviewQueue: PublishProposer = {
  async propose(req) {
    return { decision: 'review_queue', reason: req.gate?.status === 'passed' ? 'auto_publish_not_installed' : 'gate_not_passed', itemVersion: req.itemVersion };
  },
};

let gate: QualityGateRunner = pendingGate;
let proposer: PublishProposer = reviewQueue;

export function setQualityGateRunner(runner: QualityGateRunner | null): void {
  gate = runner ?? pendingGate;
}

export function setPublishProposer(next: PublishProposer | null): void {
  proposer = next ?? reviewQueue;
}

export const qualityGateRunner = (): QualityGateRunner => gate;
export const publishProposer = (): PublishProposer => proposer;
