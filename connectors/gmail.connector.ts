import type { ConnectorAction, Connector, RollbackContext } from '../types';
import { gmail_v1 } from 'googleapis';

interface GmailMessage {
    id: string;
    threadId: string;
    labelIds?: string[];
    snippet?: string;
}

interface GmailDraft {
    id: string;
    message: GmailMessage;
}

interface GmailLabel {
    id: string;
    name?: string;
    type?: string;
}

interface GmailAction {
    id: string;
    operationType: 'CREATE' | 'UPDATE' | 'DELETE';
    payload: {
        id?: string;
        to?: string;
        subject?: string;
        threadId?: string;
        messageId?: string;
        draftId?: string;
        labelId?: string;
        name?: string;
        addLabelIds?: string[];
        removeLabelIds?: string[];
    };
    response?: {
        data?: (GmailMessage & GmailDraft & GmailLabel);
    } & (GmailMessage & GmailDraft & GmailLabel);
    undoConfig?: {
        requireApproval?: boolean;
        safetyLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
        reason?: string;
    };
    snapshot?: {
        beforeState?: {
            labelIds?: string[];
            raw?: string;
            threadId?: string;
            message?: gmail_v1.Schema$Message;
        };
    };
}

function getRollbackErrorMessage(action: GmailAction, orgId: string, reason: string): string {
    return `[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: ${reason}`;
}

function getErrorStatus(err: unknown): number | undefined {
    if (typeof err !== 'object' || err === null) {
        return undefined;
    }

    const candidate = err as {
        status?: unknown;
        code?: unknown;
        response?: {
            status?: unknown;
        };
    };

    if (typeof candidate.status === 'number') {
        return candidate.status;
    }

    if (typeof candidate.code === 'number') {
        return candidate.code;
    }

    if (typeof candidate.response?.status === 'number') {
        return candidate.response.status;
    }

    return undefined;
}

function getResponse(action: GmailAction, orgId: string): GmailMessage & GmailDraft & GmailLabel {
    const response = (action.response?.data ?? action.response) as (GmailMessage & GmailDraft & GmailLabel) | undefined;
    if (!response) {
        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing Gmail response'));
    }
    return response;
}

type SnapshotConnectorAction = ConnectorAction & {
    resourceUrlResolver?: (apiName: string, payload: Record<string, unknown>) => string | null;
};

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function messageUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const id = typeof payload.id === 'string' ? payload.id : (typeof payload.messageId === 'string' ? payload.messageId : null);
    if (!id) {
        return null;
    }
    return `${GMAIL_API}/messages/${id}`;
}

function threadUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const id = typeof payload.id === 'string' ? payload.id : (typeof payload.threadId === 'string' ? payload.threadId : null);
    if (!id) {
        return null;
    }
    return `${GMAIL_API}/threads/${id}`;
}

function draftUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const id = typeof payload.id === 'string' ? payload.id : (typeof payload.draftId === 'string' ? payload.draftId : null);
    if (!id) {
        return null;
    }
    return `${GMAIL_API}/drafts/${id}`;
}

function labelUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const id = typeof payload.id === 'string' ? payload.id : (typeof payload.labelId === 'string' ? payload.labelId : null);
    if (!id) {
        return null;
    }
    return `${GMAIL_API}/labels/${id}`;
}

export const gmailConnector: Connector = {
    connector: 'gmail',
    actions: [
        // ─── Existing Actions (Fixed resourceUrlResolver) ─────────────────────
        {
            apiName: 'gmail.messages.send',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: messageUrlResolver,
            rollback: {
                type: 'CORRECTION_MESSAGE',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GmailAction;
                    const msg = getResponse(action, orgId) as GmailMessage;
                    const payload = action.payload;
                    const client = context.client as gmail_v1.Gmail;
                    const reason = action.undoConfig?.reason;
                    const body = reason
                        ? `Warning: The previous email was sent in error by an AI agent.\nReason: ${reason}\nPlease disregard the previous message.`
                        : 'Warning: The previous email was sent in error. Please disregard.';

                    const correctionRaw = Buffer.from(
                        [
                            `To: ${payload.to ?? ''}`,
                            `Subject: Re: ${payload.subject ?? 'Your Recent Email'}`,
                            'MIME-Version: 1.0',
                            'Content-Type: text/plain; charset=UTF-8',
                            '',
                            body,
                        ].join('\r\n'),
                    ).toString('base64url');

                    try {
                        await client.users.messages.send({
                            userId: 'me',
                            requestBody: { raw: correctionRaw, threadId: msg.threadId },
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['gmail.clientId', 'gmail.clientSecret', 'gmail.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gmail.messages.trash',
            captureBeforeState: true,
            operationType: 'DELETE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: messageUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GmailAction;
                    const msg = getResponse(action, orgId) as GmailMessage;
                    if (!msg.id) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing message id'));
                    }

                    const client = context.client as gmail_v1.Gmail;
                    let labelIds: string[] | undefined;
                    try {
                        const currentMessage = await client.users.messages.get({ userId: 'me', id: msg.id });
                        labelIds = currentMessage.data.labelIds ?? undefined;
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            throw new Error(getRollbackErrorMessage(action, orgId, `Message ${msg.id} is no longer in trash — manual intervention required`));
                        }
                        throw err;
                    }

                    if (!labelIds?.includes('TRASH')) {
                        throw new Error(getRollbackErrorMessage(action, orgId, `Message ${msg.id} is no longer in trash — manual intervention required`));
                    }

                    try {
                        await client.users.messages.untrash({
                            userId: 'me',
                            id: msg.id,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['gmail.clientId', 'gmail.clientSecret', 'gmail.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gmail.drafts.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: draftUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GmailAction;
                    const draft = getResponse(action, orgId) as GmailDraft;
                    if (!draft.id) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing draft id'));
                    }

                    const client = context.client as gmail_v1.Gmail;
                    try {
                        await client.users.drafts.delete({
                            userId: 'me',
                            id: draft.id,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['gmail.clientId', 'gmail.clientSecret', 'gmail.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gmail.labels.modify',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: messageUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GmailAction;
                    const beforeState = action.snapshot?.beforeState;
                    if (!beforeState?.labelIds?.length) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing beforeState.labelIds'));
                    }

                    const messageId = action.payload.messageId;
                    if (!messageId) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing messageId'));
                    }

                    const client = context.client as gmail_v1.Gmail;
                    try {
                        await client.users.messages.modify({
                            userId: 'me',
                            id: messageId,
                            requestBody: {
                                addLabelIds: beforeState.labelIds,
                                removeLabelIds: action.payload.addLabelIds ?? [],
                            },
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['gmail.clientId', 'gmail.clientSecret', 'gmail.refreshToken'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 1: CREATE actions ──────────────────────────────────────────
        {
            apiName: 'gmail.labels.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: labelUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GmailAction;
                    const label = getResponse(action, orgId) as GmailLabel;
                    if (!label.id) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing label id'));
                    }

                    const client = context.client as gmail_v1.Gmail;
                    try {
                        await client.users.labels.delete({
                            userId: 'me',
                            id: label.id,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['gmail.clientId', 'gmail.clientSecret', 'gmail.refreshToken'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 1-special: CREATE with CORRECTION_MESSAGE ───────────────────
        {
            apiName: 'gmail.messages.reply',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: messageUrlResolver,
            rollback: {
                type: 'CORRECTION_MESSAGE',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GmailAction;
                    const msg = getResponse(action, orgId) as GmailMessage;
                    const payload = action.payload;
                    const client = context.client as gmail_v1.Gmail;
                    const reason = action.undoConfig?.reason;
                    const threadId = msg.threadId ?? payload.threadId;
                    const body = reason
                        ? `Warning: The previous reply in this thread was sent in error by an AI agent.\nReason: ${reason}\nPlease disregard the previous message.`
                        : 'Warning: The previous reply in this thread was sent in error. Please disregard.';

                    const correctionRaw = Buffer.from(
                        [
                            `To: ${payload.to ?? ''}`,
                            `Subject: Re: ${payload.subject ?? 'Your Recent Email'}`,
                            'MIME-Version: 1.0',
                            'Content-Type: text/plain; charset=UTF-8',
                            '',
                            body,
                        ].join('\r\n'),
                    ).toString('base64url');

                    try {
                        await client.users.messages.send({
                            userId: 'me',
                            requestBody: { raw: correctionRaw, threadId },
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['gmail.clientId', 'gmail.clientSecret', 'gmail.refreshToken'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 2: UPDATE/DELETE snapshot-restore actions ───────────────────
        {
            apiName: 'gmail.drafts.delete',
            captureBeforeState: true,
            operationType: 'DELETE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: draftUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GmailAction;
                    const beforeState = action.snapshot?.beforeState;
                    if (!beforeState?.raw && !beforeState?.message) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing beforeState draft content'));
                    }

                    const threadId = beforeState.message?.threadId ?? beforeState.threadId;
                    const client = context.client as gmail_v1.Gmail;
                    try {
                        // Recreate the draft via client.users.drafts.create using full draft content & preserving threadId.
                        // Note: The recreated draft receives a new ID upon creation (same limitation pattern as GitHub files.delete rollback).
                        await client.users.drafts.create({
                            userId: 'me',
                            requestBody: {
                                message: {
                                    ...(beforeState.raw ? { raw: beforeState.raw } : beforeState.message),
                                    ...(threadId ? { threadId } : {}),
                                },
                            },
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['gmail.clientId', 'gmail.clientSecret', 'gmail.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gmail.threads.modify',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: threadUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GmailAction;
                    const beforeState = action.snapshot?.beforeState;
                    if (!beforeState?.labelIds?.length) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing beforeState.labelIds'));
                    }

                    const threadId = action.payload.threadId ?? action.payload.id;
                    if (!threadId) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing threadId'));
                    }

                    const client = context.client as gmail_v1.Gmail;
                    try {
                        await client.users.threads.modify({
                            userId: 'me',
                            id: threadId,
                            requestBody: {
                                addLabelIds: beforeState.labelIds,
                                removeLabelIds: action.payload.addLabelIds ?? [],
                            },
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['gmail.clientId', 'gmail.clientSecret', 'gmail.refreshToken'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 3: Toggle actions ──────────────────────────────────────────
        {
            apiName: 'gmail.messages.untrash',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: messageUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GmailAction;
                    const messageId = action.payload.messageId ?? action.payload.id ?? (action.response ? getResponse(action, orgId).id : undefined);
                    if (!messageId) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing message id'));
                    }

                    const client = context.client as gmail_v1.Gmail;
                    let labelIds: string[] | undefined;
                    try {
                        const currentMessage = await client.users.messages.get({ userId: 'me', id: messageId });
                        labelIds = currentMessage.data.labelIds ?? undefined;
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        throw err;
                    }

                    if (labelIds?.includes('TRASH')) {
                        return;
                    }

                    try {
                        await client.users.messages.trash({
                            userId: 'me',
                            id: messageId,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['gmail.clientId', 'gmail.clientSecret', 'gmail.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gmail.threads.trash',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: threadUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GmailAction;
                    const threadId = action.payload.threadId ?? action.payload.id ?? (action.response ? getResponse(action, orgId).id : undefined);
                    if (!threadId) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing thread id'));
                    }

                    const client = context.client as gmail_v1.Gmail;
                    try {
                        await client.users.threads.untrash({
                            userId: 'me',
                            id: threadId,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['gmail.clientId', 'gmail.clientSecret', 'gmail.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gmail.threads.untrash',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: threadUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GmailAction;
                    const threadId = action.payload.threadId ?? action.payload.id ?? (action.response ? getResponse(action, orgId).id : undefined);
                    if (!threadId) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing thread id'));
                    }

                    const client = context.client as gmail_v1.Gmail;
                    try {
                        await client.users.threads.trash({
                            userId: 'me',
                            id: threadId,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['gmail.clientId', 'gmail.clientSecret', 'gmail.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gmail.messages.markAsRead',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: messageUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GmailAction;
                    const messageId = action.payload.messageId ?? action.payload.id;
                    if (!messageId) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing messageId'));
                    }

                    const client = context.client as gmail_v1.Gmail;
                    try {
                        await client.users.messages.modify({
                            userId: 'me',
                            id: messageId,
                            requestBody: {
                                addLabelIds: ['UNREAD'],
                            },
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['gmail.clientId', 'gmail.clientSecret', 'gmail.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gmail.messages.markAsUnread',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: messageUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GmailAction;
                    const messageId = action.payload.messageId ?? action.payload.id;
                    if (!messageId) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing messageId'));
                    }

                    const client = context.client as gmail_v1.Gmail;
                    try {
                        await client.users.messages.modify({
                            userId: 'me',
                            id: messageId,
                            requestBody: {
                                removeLabelIds: ['UNREAD'],
                            },
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[gmailConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['gmail.clientId', 'gmail.clientSecret', 'gmail.refreshToken'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 4: No safe rollback (safetyLevel: HIGH, rollback: NONE) ────
        {
            apiName: 'gmail.messages.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: messageUrlResolver,
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error('permanent message deletion cannot be undone — use messages.trash for reversible deletion instead');
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gmail.threads.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: threadUrlResolver,
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error('permanent thread deletion cannot be undone — use threads.trash for reversible deletion instead');
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gmail.labels.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: labelUrlResolver,
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'deleted labels cannot be safely restored — recreating a label by name does not restore its association with previously labeled messages, which would create a false sense of successful rollback',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
    ],
};
