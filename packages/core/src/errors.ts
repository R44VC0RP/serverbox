export type ServerBoxErrorCode =
  | "INVALID_CONFIG"
  | "MISSING_AUTH"
  | "MISSING_DAYTONA_API_KEY"
  | "INSTANCE_NOT_FOUND"
  | "INSTANCE_NOT_RUNNING"
  | "SANDBOX_NOT_FOUND"
  | "CREATE_FAILED"
  | "BOOTSTRAP_FAILED"
  | "HEALTH_CHECK_FAILED"
  | "DAYTONA_API_ERROR"
  | "STORE_ERROR"
  | "UNSUPPORTED_OPERATION";

export class ServerBoxError extends Error {
  public readonly code: ServerBoxErrorCode;
  public readonly details?: unknown;

  constructor(code: ServerBoxErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ServerBoxError";
    this.code = code;
    this.details = details;
  }

  static wrap(
    code: ServerBoxErrorCode,
    error: unknown,
    fallbackMessage: string
  ): ServerBoxError {
    if (error instanceof ServerBoxError) {
      return error;
    }

    if (error instanceof Error) {
      return new ServerBoxError(code, `${fallbackMessage}: ${error.message}`, error);
    }

    return new ServerBoxError(code, fallbackMessage, error);
  }
}
