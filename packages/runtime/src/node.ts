// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
// @heopress/runtime/node — entry point for Node/Docker processes.
//
export { createRuntime } from './factory';
export { runScheduledSlot, scheduledJob } from './leader-lock';
export type { ScheduledJobFn, ScheduledJobGate, ScheduledJobOptions, ScheduledJobReport, ScheduledJobResult, ScheduledRunOutcome } from './leader-lock';
export { installQueueSchema } from './adapters/postgres/queue';
export {
  DefiniteFailure,
  OutcomeUnknown,
  performExternalAction,
  resolveExternalAction,
} from './external-actions';
export type {
  ExternalActionRef,
  ExternalActionResult,
  ExternalActionTarget,
  RemoteStatus,
} from './external-actions';
export {
  OutboundBlockedError,
  outboundBlockOf,
  outboundFetch,
  parseTrustedEndpoints,
  trustedEndpointsFromEnv,
} from './outbound/fetch';
export type { OutboundFetchOptions, OutboundPurpose, TrustedEndpoints } from './outbound/fetch';
export { classifyAddress } from './outbound/address';
export type { AddressClass } from './outbound/address';
export { PgVectorStore, VectorDimensionError, VectorSearchUnavailableError, spaceIdFor } from './vector/store';
export type {
  VectorCandidate,
  VectorCandidateCache,
  VectorEntryInput,
  VectorPurpose,
  VectorQuery,
  VectorQueryResult,
  VectorSpace,
} from './vector/store';
export { convertJsonbEmbeddings } from './vector/convert';
export type { ConversionReport } from './vector/convert';
