// Available on npm: @agentrein/types
// npm install @agentrein/types

export type OperationType = "CREATE" | "UPDATE" | "DELETE";

export type SafetyLevel = "LOW" | "MEDIUM" | "HIGH";

export type RollbackType = "API_CALL" | "CORRECTION_MESSAGE" | "NONE";

export interface RollbackContext {
  client: unknown;
  orgId?: string;
  // The client is typed as unknown here. Each connector casts it to the
  // appropriate SDK type internally.
  // e.g. const client = context.client as Octokit;
}

export interface RollbackStrategy {
  type: RollbackType;
  execute: (action: unknown, context: RollbackContext, idempotencyKey?: string) => Promise<void>;
  requires: string[];
}

export interface ConnectorAction {
  apiName: string;
  intentTag?: string;
  captureBeforeState: boolean;
  operationType: OperationType;
  safetyLevel: SafetyLevel;
  rollback: RollbackStrategy;
}

export interface Connector {
  connector: string;
  actions: ConnectorAction[];
}
