/**
 * Errors thrown by ItemService, in a module of their own so that helpers
 * ItemService uses (the publish guard) can throw them without an import
 * cycle. Re-exported from `item-service`.
 */

export class ItemServiceError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'ItemServiceError';
  }
}

/**
 * The update named a version the item has moved past (HeoPress P04, spec
 * content/write-concurrency). Nothing was written. `changedFields` lists the
 * data fields changed since the caller's version, as far as revisions record
 * them; status-only changes (scheduler, editorial workflow) add no field.
 */
export class VersionConflictError extends ItemServiceError {
  constructor(
    public readonly currentVersion: number,
    public readonly changedFields: string[],
  ) {
    super(
      'VERSION_CONFLICT',
      `The item changed since the version you read (now version ${currentVersion}). Read it again, re-apply your change and retry with the new version.`,
      409,
    );
    this.name = 'VersionConflictError';
  }
}

/** An update without the version it is based on (428 Precondition Required). */
export function versionRequired(): ItemServiceError {
  return new ItemServiceError(
    'VERSION_REQUIRED',
    'Updates must name the item version they are based on: send If-Match: "<version>" or expectedVersion.',
    428,
  );
}

/**
 * A late AI result (HeoPress P04, spec content/write-concurrency "晚到的 AI
 * 结果不覆盖人工修改"): the agent's write was based on a version a person has
 * since edited. It is not written back; the result is recorded as superseded.
 */
export class AiResultSupersededError extends VersionConflictError {
  constructor(currentVersion: number, changedFields: string[]) {
    super(currentVersion, changedFields);
    this.code = 'AI_RESULT_SUPERSEDED';
    this.message = `A person edited this item after the AI task read it (now version ${currentVersion}); the AI result was not written back.`;
    this.name = 'AiResultSupersededError';
  }
}
