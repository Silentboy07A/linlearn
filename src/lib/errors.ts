// src/lib/errors.ts

export class BasePlatformError extends Error {
  public code: string;
  public status: number;

  constructor(message: string, code = "INTERNAL_ERROR", status = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CommandBlockedError extends BasePlatformError {
  constructor(message = "Command blocked due to security risk rules", reason?: string) {
    super(reason ? `${message}: ${reason}` : message, "COMMAND_BLOCKED", 403);
  }
}

export class PromptInjectionError extends BasePlatformError {
  constructor(message = "Suspicious input pattern flagged by prompt firewall") {
    super(message, "PROMPT_INJECTION_DETECTED", 400);
  }
}

export class RateLimitExceededError extends BasePlatformError {
  constructor(message = "Too many requests. Please slow down.") {
    super(message, "RATE_LIMIT_EXCEEDED", 429);
  }
}

export class VMInitializationError extends BasePlatformError {
  constructor(message = "Failed to initialize the virtual machine runtime") {
    super(message, "VM_INIT_FAILURE", 500);
  }
}

export class EvaluationFailedError extends BasePlatformError {
  constructor(message = "Evaluation pipeline failed to execute successfully") {
    super(message, "EVALUATION_FAILURE", 500);
  }
}

export class AbuseDetectedError extends BasePlatformError {
  constructor(message = "Request flagged by abuse detection system") {
    super(message, "ABUSE_DETECTED", 403);
  }
}
