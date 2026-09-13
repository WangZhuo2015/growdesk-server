export class DatabaseError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode = 500) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class IdempotencyKeyReusedError extends DatabaseError {
  constructor(commandId: string) {
    super(
      `Idempotency key reused with different payload for command: ${commandId}`,
      "IDEMPOTENCY_KEY_REUSED",
      409
    );
  }
}

export class ConcurrencyConflictError extends DatabaseError {
  constructor(message = "Concurrency conflict: resource version has changed") {
    super(message, "CONCURRENCY_CONFLICT", 409);
  }
}

export class RecordNotFoundError extends DatabaseError {
  constructor(entityType: string, entityId: string) {
    super(
      `${entityType} with ID ${entityId} was not found`,
      "RECORD_NOT_FOUND",
      404
    );
  }
}

export class ScopeMismatchError extends DatabaseError {
  constructor(message: string) {
    super(message, "SCOPE_MISMATCH", 400);
  }
}

export class FamilyAccessDeniedError extends DatabaseError {
  constructor(familyId: string) {
    super(
      `Access denied to family: ${familyId}`,
      "FAMILY_ACCESS_DENIED",
      403
    );
  }
}

export class BabyAccessDeniedError extends DatabaseError {
  constructor(babyId: string, code = "BABY_ACCESS_DENIED") {
    super(
      `Access denied to baby: ${babyId} (${code})`,
      code,
      403
    );
  }
}

export class BadRequestError extends DatabaseError {
  constructor(message: string, code = "BAD_REQUEST") {
    super(message, code, 400);
  }
}

export class FencingTokenMismatchError extends DatabaseError {
  constructor(message = "Fencing token mismatch: task has been claimed by another worker or lease has expired") {
    super(message, "FENCING_TOKEN_MISMATCH", 409);
  }
}
