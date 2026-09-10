import type { ConnectorAction, Connector, RollbackContext } from '../types';
import { Client as NotionClient } from '@notionhq/client';

interface NotionPage {
    id: string;
    properties: Record<string, unknown>;
    parent: Record<string, unknown>;
    url: string;
}

interface NotionBlock {
    id: string;
    type: string;
    [key: string]: unknown;
}

interface NotionBlockAppendResult {
    results: NotionBlock[];
}

interface NotionAction {
    id: string;
    operationType: 'CREATE' | 'UPDATE' | 'DELETE';
    payload: Record<string, unknown>;
    response?: {
        data?: NotionPage & NotionBlockAppendResult;
    } & (NotionPage & NotionBlockAppendResult);
    undoConfig?: {
        requireApproval?: boolean;
        safetyLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
        reason?: string;
    };
    snapshot?: {
        beforeState?: NotionPage | null;
    };
}

type NotionResponse = NotionPage & NotionBlockAppendResult;

function getResponse(action: NotionAction, orgId: string): NotionResponse {
    const response = action.response?.data ?? action.response;
    if (!response) {
        throw new Error(
            `[notionConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing response`,
        );
    }
    return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorStatus(err: unknown): number | undefined {
    if (isRecord(err) && typeof err.status === 'number') {
        return err.status;
    }
    return undefined;
}

function handleNotionRollbackError(action: NotionAction, orgId: string, err: unknown): void {
    if (getErrorStatus(err) === 404) {
        return;
    }

    console.error(`[notionConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
    throw err;
}

type SnapshotConnectorAction = ConnectorAction & {
    resourceUrlResolver?: (apiName: string, payload: Record<string, unknown>) => string | null;
};

export const notionConnector: Connector = {
    connector: 'notion',
    actions: [
        {
            apiName: 'notion.pages.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: () => null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as NotionAction;
                    const page = getResponse(action, orgId) as NotionPage;
                    if (!page.id) {
                        throw new Error(
                            `[notionConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing page id in response`,
                        );
                    }

                    const client = context.client as NotionClient;
                    try {
                        await client.pages.update({
                            page_id: page.id,
                            in_trash: true,
                        });
                    } catch (err) {
                        handleNotionRollbackError(action, orgId, err);
                    }
                },
                requires: ['notion.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'notion.pages.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                typeof payload.id === 'string' ? `https://api.notion.com/v1/pages/${payload.id}` : null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as NotionAction;
                    const beforeState = action.snapshot?.beforeState ?? null;
                    if (!beforeState) {
                        throw new Error(
                            `[notionConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    if (!beforeState.id) {
                        throw new Error(
                            `[notionConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing page id in beforeState`,
                        );
                    }

                    const client = context.client as NotionClient;
                    try {
                        await client.pages.update({
                            page_id: beforeState.id,
                            properties: beforeState.properties as Parameters<typeof client.pages.update>[0]['properties'],
                        });
                    } catch (err) {
                        handleNotionRollbackError(action, orgId, err);
                    }
                },
                requires: ['notion.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'notion.database_items.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: () => null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as NotionAction;
                    const page = getResponse(action, orgId) as NotionPage;
                    if (!page.id) {
                        throw new Error(
                            `[notionConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing page id in response`,
                        );
                    }

                    const client = context.client as NotionClient;
                    try {
                        await client.pages.update({
                            page_id: page.id,
                            in_trash: true,
                        });
                    } catch (err) {
                        handleNotionRollbackError(action, orgId, err);
                    }
                },
                requires: ['notion.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'notion.blocks.append',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: () => null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as NotionAction;
                    const result = getResponse(action, orgId) as NotionBlockAppendResult;
                    if (!Array.isArray(result.results) || result.results.length === 0) {
                        return;
                    }

                    const client = context.client as NotionClient;
                    try {
                        const outcomes = await Promise.allSettled(
                            result.results.map((block) =>
                                client.blocks.delete({ block_id: block.id }),
                            ),
                        );

                        const failures: Array<{ blockId: string; err: unknown }> = [];
                        outcomes.forEach((outcome, index) => {
                            if (outcome.status === 'fulfilled') {
                                return;
                            }

                            if (getErrorStatus(outcome.reason) === 404) {
                                return;
                            }

                            failures.push({
                                blockId: result.results[index].id,
                                err: outcome.reason,
                            });
                        });

                        if (failures.length > 0) {
                            for (const failure of failures) {
                                console.error(
                                    `[notionConnector] block delete failed | action: ${action.id} | org: ${orgId} | blockId: ${failure.blockId}`,
                                    failure.err,
                                );
                            }

                            throw new Error(
                                `[notionConnector] rollback partially failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: ${failures.length}/${result.results.length} blocks failed to delete`,
                            );
                        }
                    } catch (err) {
                        handleNotionRollbackError(action, orgId, err);
                    }
                },
                requires: ['notion.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'notion.pages.archive',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                typeof payload.page_id === 'string' ? `https://api.notion.com/v1/pages/${payload.page_id}` : null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as NotionAction;
                    // Toggle target — page_id is caller-specified in the payload, not server-generated; no response extraction needed.
                    const pageId = typeof action.payload?.page_id === 'string' ? action.payload.page_id : undefined;
                    if (!pageId) {
                        throw new Error(
                            `[notionConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing page_id in payload`,
                        );
                    }

                    const client = context.client as NotionClient;
                    try {
                        await client.pages.update({
                            page_id: pageId,
                            in_trash: false,
                        });
                    } catch (err) {
                        handleNotionRollbackError(action, orgId, err);
                    }
                },
                requires: ['notion.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'notion.pages.restore',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                typeof payload.page_id === 'string' ? `https://api.notion.com/v1/pages/${payload.page_id}` : null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as NotionAction;
                    // Toggle target — page_id is caller-specified in the payload, not server-generated; no response extraction needed.
                    const pageId = typeof action.payload?.page_id === 'string' ? action.payload.page_id : undefined;
                    if (!pageId) {
                        throw new Error(
                            `[notionConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing page_id in payload`,
                        );
                    }

                    const client = context.client as NotionClient;
                    try {
                        await client.pages.update({
                            page_id: pageId,
                            in_trash: true,
                        });
                    } catch (err) {
                        handleNotionRollbackError(action, orgId, err);
                    }
                },
                requires: ['notion.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'notion.database_items.archive',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                typeof payload.page_id === 'string' ? `https://api.notion.com/v1/pages/${payload.page_id}` : null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as NotionAction;
                    // Domain alias of notion.pages.archive — same SDK call (pages.update), distinct apiName for Agent intent clarity per database-item vs standalone-page mental model.
                    // Toggle target — page_id is caller-specified in the payload, not server-generated; no response extraction needed.
                    const pageId = typeof action.payload?.page_id === 'string' ? action.payload.page_id : undefined;
                    if (!pageId) {
                        throw new Error(
                            `[notionConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing page_id in payload`,
                        );
                    }

                    const client = context.client as NotionClient;
                    try {
                        await client.pages.update({
                            page_id: pageId,
                            in_trash: false,
                        });
                    } catch (err) {
                        handleNotionRollbackError(action, orgId, err);
                    }
                },
                requires: ['notion.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'notion.database_items.restore',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                typeof payload.page_id === 'string' ? `https://api.notion.com/v1/pages/${payload.page_id}` : null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as NotionAction;
                    // Domain alias of notion.pages.restore — same SDK call (pages.update), distinct apiName for Agent intent clarity per database-item vs standalone-page mental model.
                    // Toggle target — page_id is caller-specified in the payload, not server-generated; no response extraction needed.
                    const pageId = typeof action.payload?.page_id === 'string' ? action.payload.page_id : undefined;
                    if (!pageId) {
                        throw new Error(
                            `[notionConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing page_id in payload`,
                        );
                    }

                    const client = context.client as NotionClient;
                    try {
                        await client.pages.update({
                            page_id: pageId,
                            in_trash: true,
                        });
                    } catch (err) {
                        handleNotionRollbackError(action, orgId, err);
                    }
                },
                requires: ['notion.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'notion.database_items.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                typeof payload.id === 'string' ? `https://api.notion.com/v1/pages/${payload.id}` : null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as NotionAction;
                    // Domain alias of notion.pages.update — identical snapshot-restore logic, distinct apiName for database-item semantics.
                    const beforeState = action.snapshot?.beforeState ?? null;
                    if (!beforeState) {
                        throw new Error(
                            `[notionConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    if (!beforeState.id) {
                        throw new Error(
                            `[notionConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing page id in beforeState`,
                        );
                    }

                    const client = context.client as NotionClient;
                    try {
                        await client.pages.update({
                            page_id: beforeState.id,
                            properties: beforeState.properties as Parameters<typeof client.pages.update>[0]['properties'],
                        });
                    } catch (err) {
                        handleNotionRollbackError(action, orgId, err);
                    }
                },
                requires: ['notion.token'],
            },
        } as SnapshotConnectorAction,
    ],
};

