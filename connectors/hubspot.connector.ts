import type { ConnectorAction, Connector, RollbackContext } from '../types';
import { Client as HubSpotClient } from '@hubspot/api-client';

interface HubSpotContact {
    id: string;
    properties: Record<string, string>;
}

interface HubSpotDeal {
    id: string;
    properties: Record<string, string>;
}

interface HubSpotCompany {
    id: string;
    properties: Record<string, string>;
}

interface HubSpotTicket {
    id: string;
    properties: Record<string, string>;
}

interface HubSpotEngagement {
    id: string;
    properties: Record<string, string>;
}

type HubSpotCrmObject = HubSpotContact | HubSpotDeal | HubSpotCompany | HubSpotTicket | HubSpotEngagement;

interface HubSpotAction {
    id: string;
    operationType: 'CREATE' | 'UPDATE' | 'DELETE';
    payload: Record<string, unknown>;
    response?: {
        data?: HubSpotCrmObject;
    } & HubSpotCrmObject;
    undoConfig?: {
        requireApproval?: boolean;
        safetyLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
        reason?: string;
    };
    snapshot?: {
        beforeState?: HubSpotCrmObject | null;
    };
}

function getRollbackErrorMessage(action: HubSpotAction, orgId: string, reason: string): string {
    return `[hubspotConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: ${reason}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFoundError(err: unknown): boolean {
    if (isRecord(err) && typeof err.code === 'number') {
        return err.code === 404;
    }
    return false;
}

function getResponse(action: HubSpotAction, orgId: string): HubSpotCrmObject {
    const response = action.response?.data ?? action.response;
    if (!response) {
        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing response'));
    }
    return response;
}

type SnapshotConnectorAction = ConnectorAction & {
    resourceUrlResolver?: (apiName: string, payload: Record<string, unknown>) => string | null;
};

function getHubSpotObjectUrl(
    objectType: 'contacts' | 'deals' | 'companies' | 'tickets' | 'engagements',
    payload: Record<string, unknown>,
): string | null {
    return typeof payload.id === 'string'
        ? `https://api.hubapi.com/crm/v3/objects/${objectType}/${payload.id}`
        : null;
}

export const hubspotConnector: Connector = {
    connector: 'hubspot',
    actions: [
        // ─── Pre-existing Actions ─────────────────────────────────────────────
        {
            apiName: 'hubspot.contacts.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: () => null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as HubSpotAction;
                    const contact = getResponse(action, orgId) as HubSpotContact;
                    if (!contact.id) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing contact id'));
                    }

                    const client = context.client as HubSpotClient;
                    // NOTE: HubSpot DELETE v3 performs an archive (soft delete), not a
                    // permanent delete. Permanent deletion requires a separate API with
                    // elevated permissions. This is intentional and safe.
                    try {
                        await client.crm.contacts.basicApi.archive(contact.id);
                    } catch (err) {
                        if (isNotFoundError(err)) {
                            return;
                        }
                        console.error(`[hubspotConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['hubspot.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'hubspot.contacts.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getHubSpotObjectUrl('contacts', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as HubSpotAction;
                    const beforeState = action.snapshot?.beforeState as HubSpotContact | null | undefined;
                    if (!beforeState) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing beforeState'));
                    }

                    if (!beforeState.id) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing contact id'));
                    }

                    const client = context.client as HubSpotClient;
                    // PATCH restores only the changed properties — leaves all other fields
                    // untouched. This is a surgical rollback, not a full overwrite.
                    try {
                        await client.crm.contacts.basicApi.update(
                            beforeState.id,
                            { properties: beforeState.properties },
                        );
                    } catch (err) {
                        if (isNotFoundError(err)) {
                            return;
                        }
                        console.error(`[hubspotConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['hubspot.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'hubspot.deals.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: () => null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as HubSpotAction;
                    const deal = getResponse(action, orgId) as HubSpotDeal;
                    if (!deal.id) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing deal id'));
                    }

                    const client = context.client as HubSpotClient;
                    // NOTE: HubSpot DELETE v3 performs an archive (soft delete), not a
                    // permanent delete. This is intentional and safe.
                    try {
                        await client.crm.deals.basicApi.archive(deal.id);
                    } catch (err) {
                        if (isNotFoundError(err)) {
                            return;
                        }
                        console.error(`[hubspotConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['hubspot.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'hubspot.deals.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getHubSpotObjectUrl('deals', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as HubSpotAction;
                    const beforeState = action.snapshot?.beforeState as HubSpotDeal | null | undefined;
                    if (!beforeState) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing beforeState'));
                    }

                    if (!beforeState.id) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing deal id'));
                    }

                    const client = context.client as HubSpotClient;
                    // PATCH restores only the changed properties — surgical rollback.
                    try {
                        await client.crm.deals.basicApi.update(
                            beforeState.id,
                            { properties: beforeState.properties },
                        );
                    } catch (err) {
                        if (isNotFoundError(err)) {
                            return;
                        }
                        console.error(`[hubspotConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['hubspot.accessToken'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 1: CREATE actions ──────────────────────────────────────────
        {
            apiName: 'hubspot.companies.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: () => null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as HubSpotAction;
                    const company = getResponse(action, orgId) as HubSpotCompany;
                    if (!company.id) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing company id'));
                    }

                    const client = context.client as HubSpotClient;
                    // NOTE: HubSpot DELETE v3 performs an archive (soft delete), not a
                    // permanent delete. Permanent deletion requires a separate API with
                    // elevated permissions. This is intentional and safe.
                    try {
                        await client.crm.companies.basicApi.archive(company.id);
                    } catch (err) {
                        if (isNotFoundError(err)) {
                            return;
                        }
                        console.error(`[hubspotConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['hubspot.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'hubspot.tickets.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: () => null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as HubSpotAction;
                    const ticket = getResponse(action, orgId) as HubSpotTicket;
                    if (!ticket.id) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing ticket id'));
                    }

                    const client = context.client as HubSpotClient;
                    // NOTE: HubSpot DELETE v3 performs an archive (soft delete), not a
                    // permanent delete. Permanent deletion requires a separate API with
                    // elevated permissions. This is intentional and safe.
                    try {
                        await client.crm.tickets.basicApi.archive(ticket.id);
                    } catch (err) {
                        if (isNotFoundError(err)) {
                            return;
                        }
                        console.error(`[hubspotConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['hubspot.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'hubspot.engagements.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: () => null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as HubSpotAction;
                    const engagement = getResponse(action, orgId) as HubSpotEngagement;
                    if (!engagement.id) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing engagement id'));
                    }

                    const client = context.client as HubSpotClient;
                    // NOTE: HubSpot DELETE v3 performs an archive (soft delete), not a
                    // permanent delete. This is intentional and safe.
                    try {
                        await client.crm.objects.basicApi.archive('engagements', engagement.id);
                    } catch (err) {
                        if (isNotFoundError(err)) {
                            return;
                        }
                        console.error(`[hubspotConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['hubspot.accessToken'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 1-variant: Composite-key CREATE ─────────────────────────────
        {
            apiName: 'hubspot.associations.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: () => null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as HubSpotAction;
                    const fromObjectType = typeof action.payload.fromObjectType === 'string' ? action.payload.fromObjectType : undefined;
                    const fromObjectId = typeof action.payload.fromObjectId === 'string' ? action.payload.fromObjectId : undefined;
                    const toObjectType = typeof action.payload.toObjectType === 'string' ? action.payload.toObjectType : undefined;
                    const toObjectId = typeof action.payload.toObjectId === 'string' ? action.payload.toObjectId : undefined;

                    if (!fromObjectType || !fromObjectId || !toObjectType || !toObjectId) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing association composite key fields in payload'));
                    }

                    const client = context.client as HubSpotClient;
                    // Composite-key resource — the payload's (fromObjectType, fromObjectId, toObjectType, toObjectId, associationTypeId) tuple IS the resource's natural identifier; there is no separate server-generated ID to read from the response.
                    try {
                        await client.crm.associations.v4.basicApi.archive(fromObjectType, fromObjectId, toObjectType, toObjectId);
                    } catch (err) {
                        if (isNotFoundError(err)) {
                            return;
                        }
                        console.error(`[hubspotConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['hubspot.accessToken'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 2: UPDATE snapshot-restore actions ─────────────────────────
        {
            apiName: 'hubspot.companies.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getHubSpotObjectUrl('companies', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as HubSpotAction;
                    const beforeState = action.snapshot?.beforeState as HubSpotCompany | null | undefined;
                    if (!beforeState) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing beforeState'));
                    }

                    if (!beforeState.id) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing company id'));
                    }

                    const client = context.client as HubSpotClient;
                    // PATCH restores only the changed properties — surgical rollback.
                    try {
                        await client.crm.companies.basicApi.update(
                            beforeState.id,
                            { properties: beforeState.properties },
                        );
                    } catch (err) {
                        if (isNotFoundError(err)) {
                            return;
                        }
                        console.error(`[hubspotConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['hubspot.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'hubspot.tickets.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getHubSpotObjectUrl('tickets', payload),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as HubSpotAction;
                    const beforeState = action.snapshot?.beforeState as HubSpotTicket | null | undefined;
                    if (!beforeState) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing beforeState'));
                    }

                    if (!beforeState.id) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing ticket id'));
                    }

                    const client = context.client as HubSpotClient;
                    // PATCH restores only the changed properties — surgical rollback.
                    try {
                        await client.crm.tickets.basicApi.update(
                            beforeState.id,
                            { properties: beforeState.properties },
                        );
                    } catch (err) {
                        if (isNotFoundError(err)) {
                            return;
                        }
                        console.error(`[hubspotConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['hubspot.accessToken'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 3: Toggle actions ──────────────────────────────────────────
        {
            apiName: 'hubspot.contactLists.addContact',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                typeof payload.listId === 'string' ? `https://api.hubapi.com/crm/v3/lists/${payload.listId}` : null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as HubSpotAction;
                    const listId = typeof action.payload.listId === 'string' ? action.payload.listId : (typeof action.payload.id === 'string' ? action.payload.id : undefined);
                    const contactId = typeof action.payload.contactId === 'string' ? action.payload.contactId : (typeof action.payload.recordId === 'string' ? action.payload.recordId : undefined);

                    if (!listId) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing listId'));
                    }
                    if (!contactId) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing contactId'));
                    }

                    const client = context.client as HubSpotClient;
                    // Target HubSpot v3 CRM List Memberships API (client.crm.lists.membershipsApi) matching n8n's list membership management behavior.
                    try {
                        await client.crm.lists.membershipsApi.remove(listId, [contactId]);
                    } catch (err) {
                        if (isNotFoundError(err)) {
                            return;
                        }
                        console.error(`[hubspotConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['hubspot.accessToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'hubspot.contactLists.removeContact',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                typeof payload.listId === 'string' ? `https://api.hubapi.com/crm/v3/lists/${payload.listId}` : null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as HubSpotAction;
                    const listId = typeof action.payload.listId === 'string' ? action.payload.listId : (typeof action.payload.id === 'string' ? action.payload.id : undefined);
                    const contactId = typeof action.payload.contactId === 'string' ? action.payload.contactId : (typeof action.payload.recordId === 'string' ? action.payload.recordId : undefined);

                    if (!listId) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing listId'));
                    }
                    if (!contactId) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing contactId'));
                    }

                    const client = context.client as HubSpotClient;
                    // Target HubSpot v3 CRM List Memberships API (client.crm.lists.membershipsApi) matching n8n's list membership management behavior.
                    try {
                        await client.crm.lists.membershipsApi.add(listId, [contactId]);
                    } catch (err) {
                        if (isNotFoundError(err)) {
                            return;
                        }
                        console.error(`[hubspotConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['hubspot.accessToken'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 4: No safe rollback (safetyLevel: HIGH, rollback: NONE) ────
        {
            apiName: 'hubspot.contacts.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getHubSpotObjectUrl('contacts', payload),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'HubSpot does not expose a general-purpose unarchive/restore API for this object type — deleted records may be recoverable manually via HubSpot\'s UI within its retention window, but no automatic rollback is available',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'hubspot.companies.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getHubSpotObjectUrl('companies', payload),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'HubSpot does not expose a general-purpose unarchive/restore API for this object type — deleted company records may be recoverable manually via HubSpot\'s UI within its retention window, but no automatic rollback is available',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'hubspot.deals.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getHubSpotObjectUrl('deals', payload),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'HubSpot does not expose a general-purpose unarchive/restore API for this object type — deleted deal records may be recoverable manually via HubSpot\'s UI within its retention window, but no automatic rollback is available',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'hubspot.tickets.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getHubSpotObjectUrl('tickets', payload),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'HubSpot does not expose a general-purpose unarchive/restore API for this object type — deleted ticket records may be recoverable manually via HubSpot\'s UI within its retention window, but no automatic rollback is available',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'hubspot.engagements.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) => getHubSpotObjectUrl('engagements', payload),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'HubSpot does not expose a general-purpose unarchive/restore API for this object type — deleted engagement records may be recoverable manually via HubSpot\'s UI within its retention window, but no automatic rollback is available',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
    ],
};
