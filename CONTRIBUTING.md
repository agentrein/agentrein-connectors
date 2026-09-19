# Contributing to AgentRein Connectors

Thank you for contributing to `agentrein-connectors`. This repository contains the canonical connector definitions used by the AgentRein execution engine to audit, gate, and roll back AI agent tool calls.

---

## Repository Architecture & Sync Mechanism

This repository is the single source of truth for all connector code.

- **Sync Policy**: Code changes must **only** be made inside this repository (`agentrein-connectors`).
- **Read-Only Mirror**: The backend path `backend/src/core/registry/connectors/` is a read-only mirror maintained by `.github/workflows/sync-connectors.yml`.
- **Direct Edits Forbidden**: Direct modifications to the backend copy will cause repository drift and will be overwritten by the next automated sync workflow.

---

## Core Type Contracts

All action definitions must conform strictly to the interfaces exported by `types/index.ts`. Contributor pull requests should avoid editing `types/index.ts` unless a genuine type-level gap is confirmed.

```typescript
export type OperationType = "CREATE" | "UPDATE" | "DELETE";
export type SafetyLevel = "LOW" | "MEDIUM" | "HIGH";
export type RollbackType = "API_CALL" | "CORRECTION_MESSAGE" | "NONE";

export interface RollbackContext {
  client: unknown; // cast to the connector's SDK type internally
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
```

*Note: `OperationType`, `SafetyLevel`, and `RollbackType` are string-literal unions, not runtime enums. Do not write `OperationType.CREATE`; use literal strings like `'CREATE'`.*

---

## Naming Conventions

All `apiName` definitions must strictly follow a flat three-segment dot notation:

```
provider.resource.action
```

### Rules
1. **Segment Count**: Exactly three dot-separated segments (`provider.resource.action`).
2. **Compound Sub-Resources**: Represent nested resources using camelCase within the second segment (e.g., `github.issueComments.create`, NOT `github.issues.comments.create`).
3. **Composite-Key Exception**: For resources identified by composite tuples rather than a single entity ID (e.g., Slack reactions/stars requiring `channel` + `ts` + `emoji`), read identifiers directly from `action.payload` rather than `action.response`. Include an inline code comment explicitly documenting this exception.

---

## Action Classification System

Every action added to a connector must be categorized into one of four operational groups:

| Group | `operationType` | `captureBeforeState` | Rollback Mechanism |
|---|---|---|---|
| **1 — Create** | `CREATE` | `false` | Inverse action (e.g., hard/soft deletion). The resource identifier MUST be read from `action.response`, never `action.payload`. |
| **2 — Update/Delete** | `UPDATE` or `DELETE` | `true` | Snapshot restore using `action.snapshot?.beforeState`. Throw a missing state error if absent. Mutable version keys (e.g., file `sha`) must be re-read from `action.response` or `snapshot.afterState`. |
| **3 — Toggle** | `UPDATE` (usually) | `false` | Self-sufficient inverse operation (e.g., lock↔unlock, archive↔unarchive). Does not require state capture. Both directions must be independently verified for reversibility against official SDK behavior. |
| **4 — Non-Reversible** | Varies | `false` | Destructive, financial, or non-compensable actions. Set `safetyLevel: 'HIGH'` and `rollback: { type: 'NONE', execute: async () => { throw new Error('<reason>'); } }`. |

---

## Implementation Rules

All action implementations must comply with the following standards:

1. **Resource URL Resolvers**: Every action (including Group 1 `CREATE` operations) must implement a `resourceUrlResolver` to support audit log navigation. Resolvers must be null-safe and return `null` on missing or invalid parameters without throwing exceptions.
2. **Standard Error Formatting**: Thrown rollback errors must match this exact format string:
   ```typescript
   `[${connectorName}Connector] rollback failed \vert{} action:${id} | org: ${orgId} \vert{} op:${op} | reason: ...`
   ```
3. **Idempotent 404 Handling**: API `404 Not Found` responses encountered during rollback execution must be swallowed silently to ensure idempotency when a resource has already been deleted.
4. **No Ambiguous Endpoint Fallbacks**: Do not attempt multiple endpoints or speculative fallback routines (e.g., try endpoint A, catch error, try endpoint B). Select a single deterministic endpoint and document the rationale in an inline comment.
5. **Independence of Safety and Reversibility**: `safetyLevel: 'HIGH'` and `rollback.type: 'NONE'` are distinct concepts. High-risk operations that are fully reversible must remain compensable; do not classify reversible actions as Group 4 merely to force approval gating.
6. **No Probabilistic Undo Logic**: Never implement heuristic, probabilistic, or AI-driven decision steps inside a rollback execution block.
7. **Type Narrowing for Shared Helpers**: When updating shared helper functions, do not widen parameter types (e.g., widening `'Account' | 'Contact'` to `string`) in a way that weakens compile-time safety elsewhere. Write narrowly-scoped helper functions instead.
8. **Shared Helper Regression Verification**: If a new action requires modifying an existing shared helper, you must verify that all pre-existing call sites function identically under the updated signature.

---

## Verification & Quality Assurance

PRs will not be merged without strict type verification:

1. **Compiler Check**: Run the full project TypeScript check from the repository root:
   ```bash
   npx tsc --noEmit
   ```
   *Do not pass `--skipLibCheck` or target individual files.*
2. **Dependency Presence**: Verify that `typescript` is explicitly listed under `devDependencies` in `package.json` before relying on `npx tsc`.
3. **SDK Verification Evidence**: Any claim that an SDK method or endpoint behavior was verified must be substantiated in the PR description with a literal quoted code snippet from the corresponding `.d.ts` declaration file, including the relative file path. Bare assertions of verification are not accepted.

---

## Workflow: Proposing or Modifying Connectors

### Adding an Action to an Existing Connector
1. Locate the file in `connectors/<connectorName>.connector.ts`.
2. Add the action adhering to the 3-segment naming convention and 4-Group classification.
3. Verify type correctness via `npx tsc --noEmit`.

### Proposing a New Connector
1. Copy `examples/custom-connector.example.ts` to `connectors/<newconnector>.connector.ts`.
2. Implement actions and type definitions using official SDKs.
3. Confirm the new connector file is included in whatever mechanism sync-connectors.yml uses to copy files into the backend (currently a directory-level cp -r, no index file required on this side).
4. Update the **Supported Connectors** table in `README.md`.
5. After the automated sync PR merges into the backend repo, a maintainer must complete the manual backend-registration step (see connector-expansion-framework.md, Step 4.5) — registering the connector in backend/src/core/registry/index.ts and backend/src/core/connectors.ts. The sync alone does not make a new connector usable.

---

## Documentation Updates

Following the merge of any PR that introduces new actions or connectors:
- Update action counts and endpoint entries in `docs/sdk/connectors.mdx`.
- Update per-connector metrics in `docs/sdk/supported-integrations.mdx` if applicable.
- Do not rephrase existing documentation wording outside the scope of your addition.
