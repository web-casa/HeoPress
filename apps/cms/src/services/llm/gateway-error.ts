/** A model gateway error with a safe code (HeoPress P04 task 7.4). */
export class LlmGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'LlmGatewayError';
  }
}
