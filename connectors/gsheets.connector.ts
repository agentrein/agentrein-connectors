import type { ConnectorAction, Connector, RollbackContext } from '../types';
import axios from 'axios';
import { sheets_v4 } from 'googleapis';

interface SheetsSpreadsheet {
    spreadsheetId: string;
    spreadsheetUrl: string;
}

interface SheetsValuesBeforeState {
    spreadsheetId: string;
    range: string;
    values: unknown[][];
}

interface GSheetsAction {
    id: string;
    operationType: 'CREATE' | 'UPDATE' | 'DELETE';
    payload: {
        spreadsheetId?: string;
        range?: string;
        values?: unknown[][];
    };
    response?: {
        data?: {
            spreadsheetId?: string;
            updates?: {
                updatedRange?: string;
            };
            replies?: Array<{
                addSheet?: {
                    properties?: {
                        sheetId?: number;
                    };
                };
            }>;
        };
    } & {
        spreadsheetId?: string;
        updates?: {
            updatedRange?: string;
        };
        replies?: Array<{
            addSheet?: {
                properties?: {
                    sheetId?: number;
                };
            };
        }>;
    };
    undoConfig?: {
        requireApproval?: boolean;
        safetyLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
        reason?: string;
    };
    snapshot?: {
        beforeState?: SheetsValuesBeforeState | null;
    };
}

type GSheetsResponse = NonNullable<GSheetsAction['response']>['data'] & NonNullable<GSheetsAction['response']>;

function getResponse(action: GSheetsAction, orgId: string): GSheetsResponse {
    const response = action.response?.data ?? action.response;
    if (!response) {
        throw new Error(
            `[gsheetsConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing response`,
        );
    }
    return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface GoogleAuthHeadersProvider {
    getRequestHeaders: (url?: string | URL) => Promise<unknown>;
}

function isGoogleAuthHeadersProvider(value: unknown): value is GoogleAuthHeadersProvider {
    return isRecord(value) && typeof value.getRequestHeaders === 'function';
}

async function getGoogleAuthHeaders(sheetsClient: sheets_v4.Sheets): Promise<Record<string, string>> {
    const auth = sheetsClient.context._options.auth;
    if (!isGoogleAuthHeadersProvider(auth)) {
        return {};
    }

    const headers = await auth.getRequestHeaders();
    if (!isRecord(headers)) {
        return {};
    }

    return Object.fromEntries(
        Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
}

function getErrorStatus(err: unknown): number | undefined {
    if (!isRecord(err)) return undefined;

    if (typeof err.status === 'number') return err.status;
    if (typeof err.code === 'number') return err.code;

    if (isRecord(err.response) && typeof err.response.status === 'number') {
        return err.response.status;
    }

    return undefined;
}

function handleRollbackError(action: GSheetsAction, orgId: string, err: unknown): void {
    const status = getErrorStatus(err);

    if (status === 404) {
        return;
    }

    if (status === 403) {
        throw new Error(
            `[gsheetsConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: PERMISSION_DENIED — verify the Service Account has Editor access to this Spreadsheet`,
        );
    }

    console.error(`[gsheetsConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
    throw err;
}

type SnapshotConnectorAction = ConnectorAction & {
    resourceUrlResolver?: (apiName: string, payload: Record<string, unknown>) => string | null;
};

function spreadsheetValuesUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const spreadsheetId = typeof payload.spreadsheetId === 'string' ? payload.spreadsheetId : null;
    const range = typeof payload.range === 'string' ? payload.range : null;
    if (!spreadsheetId || !range) {
        return null;
    }
    return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
}

function spreadsheetUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const spreadsheetId = typeof payload.spreadsheetId === 'string' ? payload.spreadsheetId : null;
    if (!spreadsheetId) {
        return null;
    }
    return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
}

export const gsheetsConnector: Connector = {
    connector: 'gsheets',
    actions: [
        // ─── Existing Actions (Corrected & Reclassified) ─────────────────────
        {
            apiName: 'gsheets.values.append',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: spreadsheetValuesUrlResolver,
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'row position may have shifted since this row was appended — clearing by a static range risks deleting unrelated data; this action has no safe automatic rollback and requires human approval instead',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            // Note: gsheets.values.update stays Group 2 despite Sheets' general row-position fragility.
            // Unlike append/insert/delete-row operations where the platform itself computed and later re-uses a position reference,
            // values.update's range is explicitly provided by the caller (the Agent) each time based on its own knowledge of the target cells —
            // the residual risk here is the same as any concurrent-edit risk on a shared document, not a risk manufactured by AgentRein's own rollback mechanism reusing a stale position.
            apiName: 'gsheets.values.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: spreadsheetValuesUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GSheetsAction;
                    const beforeState = action.snapshot?.beforeState ?? null;
                    if (!beforeState) {
                        throw new Error(
                            `[gsheetsConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Critical — no beforeState found, data at risk`,
                        );
                    }

                    const sheetsClient = context.client as sheets_v4.Sheets;
                    try {
                        await sheetsClient.spreadsheets.values.update({
                            spreadsheetId: beforeState.spreadsheetId,
                            range: beforeState.range,
                            valueInputOption: 'RAW',
                            requestBody: { values: beforeState.values },
                        });
                    } catch (err) {
                        handleRollbackError(action, orgId, err);
                    }
                },
                requires: ['google.clientId', 'google.clientSecret', 'google.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gsheets.spreadsheets.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: spreadsheetUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GSheetsAction;
                    const spreadsheet = getResponse(action, orgId) as SheetsSpreadsheet;
                    if (!spreadsheet.spreadsheetId) {
                        throw new Error(
                            `[gsheetsConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing spreadsheetId in response`,
                        );
                    }

                    const sheetsClient = context.client as sheets_v4.Sheets;
                    // Soft delete gives a 30-day recovery window.
                    // Consistent with gdrive.files.create rollback strategy.
                    try {
                        await sheetsClient.spreadsheets.batchUpdate({
                            spreadsheetId: spreadsheet.spreadsheetId,
                            requestBody: { requests: [] },
                        });
                        await axios.patch(
                            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(spreadsheet.spreadsheetId)}`,
                            { trashed: true },
                            { headers: await getGoogleAuthHeaders(sheetsClient) },
                        );
                    } catch (err) {
                        handleRollbackError(action, orgId, err);
                    }
                },
                requires: ['google.clientId', 'google.clientSecret', 'google.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gsheets.sheets.add',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: spreadsheetUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GSheetsAction;
                    const response = getResponse(action, orgId);
                    const sheetId = response.replies?.[0]?.addSheet?.properties?.sheetId;
                    if (sheetId === undefined) {
                        throw new Error(
                            `[gsheetsConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing sheetId in response`,
                        );
                    }

                    const spreadsheetId = action.payload.spreadsheetId;
                    if (!spreadsheetId) {
                        throw new Error(
                            `[gsheetsConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing spreadsheetId in payload`,
                        );
                    }

                    const sheetsClient = context.client as sheets_v4.Sheets;
                    try {
                        await sheetsClient.spreadsheets.batchUpdate({
                            spreadsheetId,
                            requestBody: {
                                requests: [{ deleteSheet: { sheetId } }],
                            },
                        });
                    } catch (err) {
                        handleRollbackError(action, orgId, err);
                    }
                },
                requires: ['google.clientId', 'google.clientSecret', 'google.refreshToken'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 4 Actions (No safe automatic rollback due to identity drift / range risk) ───
        {
            apiName: 'gsheets.rows.insert',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: spreadsheetUrlResolver,
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'inserted row position may shift due to other operations — no safe automatic rollback is available; requires human approval for any reversal',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gsheets.rows.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: spreadsheetUrlResolver,
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'deleted row content cannot be safely restored by position — row indices shift after deletion, making automatic recreation unreliable; requires human approval instead',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gsheets.rows.appendOrUpdate',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: spreadsheetUrlResolver,
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        "this operation may append or update depending on existing data, and the affected row's position is not reliably trackable for automatic rollback — requires human approval instead",
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gsheets.values.clear',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: spreadsheetValuesUrlResolver,
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        "cleared cell values cannot be automatically restored without a prior snapshot of the exact range's content, and clearing operations are frequently used precisely because content is stale or unknown — requires human approval instead",
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
    ],
};
