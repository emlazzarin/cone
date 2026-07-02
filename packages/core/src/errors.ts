// Typed errors: the stable machine-readable code travels with the error from
// its throw site, so CLI/MCP surfaces never have to classify prose (message
// text remains for humans). Codes are part of the agent contract (SKILL.md).
export class ConeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConeError';
  }
}
