export interface FailureOptions {
  cause?: unknown;
  code?: string;
}

export class TransientFailure extends Error {
  readonly cause?: unknown;
  readonly code?: string;

  constructor(message: string, opts?: FailureOptions) {
    super(message);
    this.name = "TransientFailure";
    this.cause = opts?.cause;
    this.code = opts?.code;
  }
}

export class PermanentFailure extends Error {
  readonly cause?: unknown;
  readonly code?: string;

  constructor(message: string, opts?: FailureOptions) {
    super(message);
    this.name = "PermanentFailure";
    this.cause = opts?.cause;
    this.code = opts?.code;
  }
}

export function isTransient(err: unknown): err is TransientFailure {
  return err instanceof TransientFailure;
}

export function isPermanent(err: unknown): err is PermanentFailure {
  return err instanceof PermanentFailure;
}
