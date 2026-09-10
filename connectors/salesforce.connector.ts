import type { ConnectorAction, Connector, RollbackContext } from '../types';
import { Connection as SalesforceConnection } from 'jsforce';

interface SalesforceContact {
    id: string;
    fields: Record<string, unknown>;
}

interface SalesforceOpportunity {
    id: string;
    fields: Record<string, unknown>;
}

interface SalesforceAccount {
    id: string;
    fields: Record<string, unknown>;
}

interface SalesforceLead {
    id: string;
    fields: Record<string, unknown>;
}

interface SalesforceCase {
    id: string;
    fields: Record<string, unknown>;
}

interface SalesforceCustomObject {
    id: string;
    fields: Record<string, unknown>;
}

interface SalesforceAttachment {
    id: string;
    fields: Record<string, unknown>;
}

interface SalesforceTask {
    id: string;
    fields: Record<string, unknown>;
}

interface SalesforceDocument {
    id: string;
    fields: Record<string, unknown>;
}

interface SalesforceNote {
    id: string;
    fields: Record<string, unknown>;
}

interface SalesforceCaseComment {
    id: string;
    fields: Record<string, unknown>;
}

interface SalesforceCampaignMember {
    id: string;
    fields: Record<string, unknown>;
}

type SalesforceRecord =
    | SalesforceContact
    | SalesforceOpportunity
    | SalesforceAccount
    | SalesforceLead
    | SalesforceCase
    | SalesforceCustomObject
    | SalesforceAttachment
    | SalesforceTask
    | SalesforceDocument
    | SalesforceNote
    | SalesforceCaseComment
    | SalesforceCampaignMember;

interface SalesforceAction {
    id: string;
    operationType: 'CREATE' | 'UPDATE' | 'DELETE';
    payload: Record<string, unknown>;
    response?: {
        data?: SalesforceRecord;
    } & SalesforceRecord;
    undoConfig?: {
        requireApproval?: boolean;
        safetyLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
        reason?: string;
    };
    snapshot?: {
        beforeState?: SalesforceRecord | null;
    };
}

type SalesforceResponse = SalesforceRecord;

function getResponse(action: SalesforceAction, orgId: string): SalesforceResponse {
    const response = action.response?.data ?? action.response;
    if (!response) {
        throw new Error(
            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing response`,
        );
    }
    return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorStatus(err: unknown): number | undefined {
    if (isRecord(err) && typeof err.errorCode === 'string') {
        if (err.errorCode === 'NOT_FOUND') return 404;
    }
    if (isRecord(err) && typeof err.statusCode === 'number') {
        return err.statusCode;
    }
    return undefined;
}

function handleSalesforceRollbackError(action: SalesforceAction, orgId: string, err: unknown): void {
    if (getErrorStatus(err) === 404) {
        return;
    }

    console.error(`[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
    throw err;
}

type SnapshotConnectorAction = ConnectorAction & {
    resourceUrlResolver?: (apiName: string, payload: Record<string, unknown>) => string | null;
};

function getSalesforceResourceUrl(
    resource: 'Account' | 'Contact' | 'Opportunity' | 'Lead' | 'Case' | 'Attachment' | 'Task' | 'Document' | 'Note' | 'CaseComment' | 'CampaignMember',
    payload: Record<string, unknown>,
): string | null {
    const id = typeof payload.id === 'string' ? payload.id : null;
    const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
    if (!id || !instanceUrl) {
        return null;
    }
    return `${instanceUrl}/services/data/v58.0/sobjects/${resource}/${id}`;
}

function getSalesforceCustomObjectResourceUrl(
    objectApiName: string,
    payload: Record<string, unknown>,
): string | null {
    const id = typeof payload.id === 'string' ? payload.id : null;
    const instanceUrl = process.env.SALESFORCE_INSTANCE_URL;
    if (!id || !instanceUrl) {
        return null;
    }
    return `${instanceUrl}/services/data/v58.0/sobjects/${objectApiName}/${id}`;
}

export const salesforceConnector: Connector = {
    connector: 'salesforce',
    actions: [
        {
            apiName: 'salesforce.contacts.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            // Salesforce DELETE is permanent (hard delete), not soft.
            // Engine will open Human Gate automatically for HIGH safety actions.
            safetyLevel: 'HIGH',
            resourceUrlResolver: () => null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const contact = getResponse(action, orgId) as SalesforceContact;
                    if (!contact.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing contact id in response`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject('Contact').delete(contact.id);
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.contacts.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Contact', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const beforeState = action.snapshot?.beforeState as SalesforceContact | null | undefined;
                    if (!beforeState) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    if (!beforeState.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing contact id in beforeState`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    // PATCH restores only the changed fields — surgical rollback,
                    // not a full overwrite. Leaves all other fields untouched.
                    try {
                        await client.sobject('Contact').update({
                            Id: beforeState.id,
                            ...beforeState.fields,
                        });
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.opportunities.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            // Salesforce DELETE is permanent (hard delete), not soft.
            // Engine will open Human Gate automatically for HIGH safety actions.
            safetyLevel: 'HIGH',
            resourceUrlResolver: () => null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const opportunity = getResponse(action, orgId) as SalesforceOpportunity;
                    if (!opportunity.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing opportunity id in response`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject('Opportunity').delete(opportunity.id);
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.opportunities.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Opportunity', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const beforeState = action.snapshot?.beforeState as SalesforceOpportunity | null | undefined;
                    if (!beforeState) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    if (!beforeState.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing opportunity id in beforeState`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    // PATCH restores only the changed fields — surgical rollback.
                    try {
                        await client.sobject('Opportunity').update({
                            Id: beforeState.id,
                            ...beforeState.fields,
                        });
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.accounts.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Account', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const account = getResponse(action, orgId) as SalesforceAccount;
                    if (!account.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing account id in response`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject('Account').delete(account.id);
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.accounts.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Account', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const beforeState = action.snapshot?.beforeState as SalesforceAccount | null | undefined;
                    if (!beforeState) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    if (!beforeState.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing account id in beforeState`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    // PATCH restores only the changed fields — surgical rollback,
                    // not a full overwrite. Leaves all other fields untouched.
                    try {
                        await client.sobject('Account').update({
                            Id: beforeState.id,
                            ...beforeState.fields,
                        });
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.accounts.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            // Salesforce DELETE is permanent (hard delete), not soft.
            // Policy engine falls back to REQUIRE_APPROVAL (Human Gate) for HIGH safety actions.
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Account', payload),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'Salesforce DELETE is permanent (hard delete), not soft — no compensating rollback exists for salesforce.accounts.delete.',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.contacts.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            // Salesforce DELETE is permanent (hard delete), not soft.
            // Policy engine falls back to REQUIRE_APPROVAL (Human Gate) for HIGH safety actions.
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Contact', payload),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'Salesforce DELETE is permanent (hard delete), not soft — no compensating rollback exists for salesforce.contacts.delete.',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.leads.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Lead', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const lead = getResponse(action, orgId) as SalesforceLead;
                    if (!lead.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing lead id in response`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject('Lead').delete(lead.id);
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.leads.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Lead', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const beforeState = action.snapshot?.beforeState as SalesforceLead | null | undefined;
                    if (!beforeState) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    if (!beforeState.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing lead id in beforeState`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    // PATCH restores only the changed fields — surgical rollback,
                    // not a full overwrite. Leaves all other fields untouched.
                    try {
                        await client.sobject('Lead').update({
                            Id: beforeState.id,
                            ...beforeState.fields,
                        });
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.leads.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            // Salesforce DELETE is permanent (hard delete), not soft.
            // Policy engine falls back to REQUIRE_APPROVAL (Human Gate) for HIGH safety actions.
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Lead', payload),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'Salesforce DELETE is permanent (hard delete), not soft — no compensating rollback exists for salesforce.leads.delete.',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.opportunities.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            // Salesforce DELETE is permanent (hard delete), not soft.
            // Policy engine falls back to REQUIRE_APPROVAL (Human Gate) for HIGH safety actions.
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Opportunity', payload),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'Salesforce DELETE is permanent (hard delete), not soft — no compensating rollback exists for salesforce.opportunities.delete.',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.cases.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Case', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const caseRecord = getResponse(action, orgId) as SalesforceCase;
                    if (!caseRecord.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing case id in response`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject('Case').delete(caseRecord.id);
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.cases.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Case', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const beforeState = action.snapshot?.beforeState as SalesforceCase | null | undefined;
                    if (!beforeState) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    if (!beforeState.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing case id in beforeState`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    // PATCH restores only the changed fields — surgical rollback,
                    // not a full overwrite. Leaves all other fields untouched.
                    try {
                        await client.sobject('Case').update({
                            Id: beforeState.id,
                            ...beforeState.fields,
                        });
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.cases.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            // Salesforce DELETE is permanent (hard delete), not soft.
            // Policy engine falls back to REQUIRE_APPROVAL (Human Gate) for HIGH safety actions.
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Case', payload),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'Salesforce DELETE is permanent (hard delete), not soft — no compensating rollback exists for salesforce.cases.delete.',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.customObjects.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => {
                const objectApiName = typeof payload.objectApiName === 'string' ? payload.objectApiName : 'CustomObject';
                return getSalesforceCustomObjectResourceUrl(objectApiName, payload);
            },
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const objectApiName = typeof action.payload?.objectApiName === 'string' ? action.payload.objectApiName : null;
                    if (!objectApiName) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing objectApiName in payload`,
                        );
                    }

                    const customObject = getResponse(action, orgId) as SalesforceCustomObject;
                    if (!customObject.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing customObject id in response`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject(objectApiName).delete(customObject.id);
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.customObjects.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => {
                const objectApiName = typeof payload.objectApiName === 'string' ? payload.objectApiName : 'CustomObject';
                return getSalesforceCustomObjectResourceUrl(objectApiName, payload);
            },
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const objectApiName = typeof action.payload?.objectApiName === 'string' ? action.payload.objectApiName : null;
                    if (!objectApiName) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing objectApiName in payload`,
                        );
                    }

                    const beforeState = action.snapshot?.beforeState as SalesforceCustomObject | null | undefined;
                    if (!beforeState) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    if (!beforeState.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing customObject id in beforeState`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject(objectApiName).update({
                            Id: beforeState.id,
                            ...beforeState.fields,
                        });
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.customObjects.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            // Salesforce DELETE is permanent (hard delete), not soft.
            // Policy engine falls back to REQUIRE_APPROVAL (Human Gate) for HIGH safety actions.
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => {
                const objectApiName = typeof payload.objectApiName === 'string' ? payload.objectApiName : 'CustomObject';
                return getSalesforceCustomObjectResourceUrl(objectApiName, payload);
            },
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'Salesforce DELETE is permanent (hard delete), not soft — no compensating rollback exists for salesforce.customObjects.delete.',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.attachments.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Attachment', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const attachment = getResponse(action, orgId) as SalesforceAttachment;
                    if (!attachment.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing attachment id in response`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject('Attachment').delete(attachment.id);
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.attachments.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Attachment', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const beforeState = action.snapshot?.beforeState as SalesforceAttachment | null | undefined;
                    if (!beforeState) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    if (!beforeState.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing attachment id in beforeState`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject('Attachment').update({
                            Id: beforeState.id,
                            ...beforeState.fields,
                        });
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.attachments.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            // Salesforce DELETE is permanent (hard delete), not soft.
            // Policy engine falls back to REQUIRE_APPROVAL (Human Gate) for HIGH safety actions.
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Attachment', payload),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'Salesforce DELETE is permanent (hard delete), not soft — no compensating rollback exists for salesforce.attachments.delete.',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.tasks.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Task', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const task = getResponse(action, orgId) as SalesforceTask;
                    if (!task.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing task id in response`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject('Task').delete(task.id);
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.tasks.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Task', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const beforeState = action.snapshot?.beforeState as SalesforceTask | null | undefined;
                    if (!beforeState) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    if (!beforeState.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing task id in beforeState`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject('Task').update({
                            Id: beforeState.id,
                            ...beforeState.fields,
                        });
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.tasks.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            // Salesforce DELETE is permanent (hard delete), not soft.
            // Policy engine falls back to REQUIRE_APPROVAL (Human Gate) for HIGH safety actions.
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Task', payload),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'Salesforce DELETE is permanent (hard delete), not soft — no compensating rollback exists for salesforce.tasks.delete.',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.documents.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Document', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const doc = getResponse(action, orgId) as SalesforceDocument;
                    if (!doc.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing document id in response`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject('Document').delete(doc.id);
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.notes.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            // Generic sub-resource — ParentId in payload determines which record this note is attached to (Account/Contact/Lead/Opportunity); the Note record itself has its own id and resourceUrl, per locked decision to avoid per-parent aliasing.
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('Note', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const note = getResponse(action, orgId) as SalesforceNote;
                    if (!note.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing note id in response`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject('Note').delete(note.id);
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.caseComments.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('CaseComment', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const caseComment = getResponse(action, orgId) as SalesforceCaseComment;
                    if (!caseComment.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing caseComment id in response`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject('CaseComment').delete(caseComment.id);
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'salesforce.campaignMembers.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            // Generic sub-resource — ContactId or LeadId in payload determines target member; the CampaignMember record itself has its own id and resourceUrl, per locked decision to avoid per-parent aliasing.
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getSalesforceResourceUrl('CampaignMember', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SalesforceAction;
                    const member = getResponse(action, orgId) as SalesforceCampaignMember;
                    if (!member.id) {
                        throw new Error(
                            `[salesforceConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing campaignMember id in response`,
                        );
                    }

                    const client = context.client as SalesforceConnection;
                    try {
                        await client.sobject('CampaignMember').delete(member.id);
                    } catch (err) {
                        handleSalesforceRollbackError(action, orgId, err);
                    }
                },
                requires: ['salesforce.accessToken'],
            },
        } as SnapshotConnectorAction,
    ],
};
