import type { ConnectorAction, Connector, RollbackContext } from '../types';
import { WebClient } from '@slack/web-api';

interface SlackAction {
    id: string;
    operationType: 'CREATE' | 'UPDATE' | 'DELETE';
    payload: {
        channel?: string;
        text?: string;
        ts?: string;
        timestamp?: string;
        blocks?: unknown[];
        attachments?: unknown[];
        file_ids?: string[];
        name?: string;
        topic?: string;
        purpose?: string;
        user?: string;
        users?: string | string[];
        usergroup?: string;
        description?: string;
        handle?: string;
        file?: string;
        content?: string;
        filename?: string;
        profile?: Record<string, unknown>;
        [key: string]: unknown;
    };
    response?: {
        data?: {
            ts?: string;
            channel?: string | { id?: string };
            file?: string | { id?: string };
            usergroup?: string | { id?: string };
            [key: string]: unknown;
        };
        ts?: string;
        channel?: string | { id?: string };
        file?: string | { id?: string };
        usergroup?: string | { id?: string };
        [key: string]: unknown;
    };
    undoConfig?: {
        requireApproval?: boolean;
        safetyLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
        reason?: string;
    };
    snapshot?: {
        beforeState?: {
            text?: string;
            blocks?: unknown[];
            attachments?: unknown[];
            file_ids?: string[];
            channel?: string;
            ts?: string;
            name?: string;
            topic?: string;
            purpose?: string;
            handle?: string;
            description?: string;
            users?: string[];
            usergroup?: string;
            profile?: Record<string, unknown>;
            [key: string]: unknown;
        };
    };
}

function getResponseIds(action: SlackAction): { channel?: string; ts?: string } {
    return {
        channel: typeof action.response?.data?.channel === 'string' ? action.response.data.channel : (typeof action.response?.channel === 'string' ? action.response.channel : undefined),
        ts: action.response?.data?.ts ?? action.response?.ts,
    };
}

function getCreatedChannelResponse(action: SlackAction, orgId: string): { channel: string } {
    const channelRes = action.response?.data?.channel ?? action.response?.channel;
    const channelId = typeof channelRes === 'string' ? channelRes : (isRecord(channelRes) && typeof channelRes.id === 'string' ? channelRes.id : undefined);
    if (!channelId) {
        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel ID in response'));
    }
    return { channel: channelId };
}

function getCreatedFileResponse(action: SlackAction, orgId: string): { file: string } {
    const fileRes = action.response?.data?.file ?? action.response?.file;
    const fileId = typeof fileRes === 'string' ? fileRes : (isRecord(fileRes) && typeof fileRes.id === 'string' ? fileRes.id : undefined);
    if (!fileId) {
        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing file ID in response'));
    }
    return { file: fileId };
}

function getCreatedUserGroupResponse(action: SlackAction, orgId: string): { usergroup: string } {
    const ugRes = action.response?.data?.usergroup ?? action.response?.usergroup;
    const usergroupId = typeof ugRes === 'string' ? ugRes : (isRecord(ugRes) && typeof ugRes.id === 'string' ? ugRes.id : undefined);
    if (!usergroupId) {
        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing usergroup ID in response'));
    }
    return { usergroup: usergroupId };
}

function parseUserList(usersProp: unknown, userProp: unknown): string[] {
    const userIds: string[] = [];
    if (typeof userProp === 'string' && userProp.trim().length > 0) {
        userIds.push(userProp.trim());
    }
    if (typeof usersProp === 'string') {
        usersProp.split(',').forEach((u) => {
            const trimmed = u.trim();
            if (trimmed.length > 0 && !userIds.includes(trimmed)) {
                userIds.push(trimmed);
            }
        });
    } else if (Array.isArray(usersProp)) {
        usersProp.forEach((u) => {
            if (typeof u === 'string' && u.trim().length > 0 && !userIds.includes(u.trim())) {
                userIds.push(u.trim());
            }
        });
    }
    return userIds;
}

function getRollbackErrorMessage(action: SlackAction, orgId: string, reason: string): string {
    return `[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: ${reason}`;
}

function getBeforeState(action: SlackAction, orgId: string): NonNullable<NonNullable<SlackAction['snapshot']>['beforeState']> {
    const beforeState = action.snapshot?.beforeState;
    if (!beforeState) {
        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing beforeState'));
    }
    return beforeState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getSlackErrorCode(err: unknown): string | undefined {
    if (!isRecord(err)) return undefined;

    if (isRecord(err.data) && typeof err.data.error === 'string') {
        return err.data.error;
    }

    if (typeof err.code === 'string') return err.code;
    if (typeof err.message === 'string') return err.message;

    return undefined;
}

type SnapshotConnectorAction = ConnectorAction & {
    resourceUrlResolver?: (apiName: string, payload: Record<string, unknown>) => string | null;
};

const SLACK_API = 'https://slack.com/api';

function messageUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const channel = typeof payload.channel === 'string' ? payload.channel : null;
    const ts = typeof payload.ts === 'string' ? payload.ts : null;
    if (!channel || !ts) {
        return null;
    }
    return `${SLACK_API}/conversations.history?channel=${channel}&latest=${ts}&inclusive=true&limit=1`;
}

function channelUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const channel = typeof payload.channel === 'string' ? payload.channel : (typeof payload.channel_id === 'string' ? payload.channel_id : null);
    if (!channel) {
        return null;
    }
    return `${SLACK_API}/conversations.info?channel=${channel}`;
}

function fileUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const file = typeof payload.file === 'string' ? payload.file : (typeof payload.file_id === 'string' ? payload.file_id : null);
    if (!file) {
        return null;
    }
    return `${SLACK_API}/files.info?file=${file}`;
}

function userGroupUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const usergroup = typeof payload.usergroup === 'string' ? payload.usergroup : (typeof payload.usergroup_id === 'string' ? payload.usergroup_id : null);
    if (!usergroup) {
        return null;
    }
    return `${SLACK_API}/usergroups.users.list?usergroup=${usergroup}`;
}

function reactionUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const channel = typeof payload.channel === 'string' ? payload.channel : null;
    const ts = typeof payload.ts === 'string' ? payload.ts : (typeof payload.timestamp === 'string' ? payload.timestamp : null);
    if (!channel || !ts) {
        return null;
    }
    return `${SLACK_API}/reactions.get?channel=${channel}&timestamp=${ts}`;
}

function starUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const channel = typeof payload.channel === 'string' ? payload.channel : null;
    const ts = typeof payload.ts === 'string' ? payload.ts : (typeof payload.timestamp === 'string' ? payload.timestamp : null);
    const file = typeof payload.file === 'string' ? payload.file : null;
    if (channel && ts) {
        return `${SLACK_API}/stars.list?channel=${channel}&timestamp=${ts}`;
    }
    if (file) {
        return `${SLACK_API}/stars.list?file=${file}`;
    }
    return null;
}

function userProfileUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const user = typeof payload.user === 'string' ? payload.user : null;
    if (!user) {
        return null;
    }
    return `${SLACK_API}/users.profile.get?user=${user}`;
}

export const slackConnector: Connector = {
    connector: 'slack',
    actions: [
        {
            apiName: 'slack.chat.postMessage',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: messageUrlResolver,
            rollback: {
                type: 'CORRECTION_MESSAGE',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const { channel, ts } = getResponseIds(action);
                    if (!channel || !ts) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel/ts'));
                    }

                    const reason = action.undoConfig?.reason;
                    const client = context.client as WebClient;

                    try {
                        await client.chat.update({
                            channel,
                            ts,
                            blocks: [],
                            text: reason ? `⚠️ Reverted by AgentRein: ${reason}` : '⚠️ Reverted by AgentRein',
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'message_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.chat.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: messageUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const beforeState = getBeforeState(action, orgId);
                    if (!beforeState.channel || !beforeState.ts) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel/ts'));
                    }

                    const client = context.client as WebClient;
                    const updateArgs = {
                        channel: beforeState.channel,
                        ts: beforeState.ts,
                        text: beforeState.text,
                        ...(beforeState.blocks ? { blocks: beforeState.blocks } : {}),
                        ...(beforeState.attachments ? { attachments: beforeState.attachments } : {}),
                        ...(beforeState.file_ids ? { file_ids: beforeState.file_ids } : {}),
                    } as unknown as Parameters<typeof client.chat.update>[0];

                    try {
                        await client.chat.update(updateArgs);
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'message_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.chat.delete',
            captureBeforeState: true,
            operationType: 'DELETE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: messageUrlResolver,
            rollback: {
                type: 'API_CALL',
                // Best-effort text restoration only — does not restore thread replies or reactions attached to the original message. This is a deliberate product decision: partial restoration is preferable to no restoration.
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const beforeState = getBeforeState(action, orgId);
                    if (!beforeState.channel) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel'));
                    }

                    const reason = action.undoConfig?.reason;
                    const client = context.client as WebClient;

                    // NOTE: restored message gets a new ts; any external references to the
                    // original ts will be broken. This is a Slack API limitation.
                    const postMessageArgs = {
                        channel: beforeState.channel,
                        text: `(Restored by AgentRein${reason ? `: ${reason}` : ''})\n\n${beforeState.text ?? ''}`,
                        ...(beforeState.blocks ? { blocks: beforeState.blocks } : {}),
                        ...(beforeState.attachments ? { attachments: beforeState.attachments } : {}),
                    } as unknown as Parameters<typeof client.chat.postMessage>[0];

                    try {
                        await client.chat.postMessage(postMessageArgs);
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'channel_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 1: CREATE actions (inverse rollback via API_CALL, ID from response) ────────
        {
            apiName: 'slack.channels.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: channelUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const createdChannel = getCreatedChannelResponse(action, orgId);
                    const client = context.client as WebClient;

                    try {
                        await client.conversations.archive({
                            channel: createdChannel.channel,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'already_archived' || getSlackErrorCode(err) === 'channel_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.files.upload',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: fileUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const createdFile = getCreatedFileResponse(action, orgId);
                    const client = context.client as WebClient;

                    try {
                        await client.files.delete({
                            file: createdFile.file,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'file_deleted' || getSlackErrorCode(err) === 'file_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.userGroups.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: userGroupUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const createdUserGroup = getCreatedUserGroupResponse(action, orgId);
                    const client = context.client as WebClient;

                    try {
                        await client.usergroups.disable({
                            usergroup: createdUserGroup.usergroup,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'already_disabled' || getSlackErrorCode(err) === 'usergroup_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 1-variant: CREATE actions (composite-key identifier from payload) ───────────
        {
            apiName: 'slack.reactions.add',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: reactionUrlResolver,
            rollback: {
                type: 'API_CALL',
                // Composite-key resource — the payload's (channel, ts, name) tuple IS the resource's natural identifier; there is no separate server-generated ID to read from the response.
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const channel = action.payload.channel;
                    const ts = action.payload.ts ?? action.payload.timestamp;
                    const name = action.payload.name;

                    if (!channel || !ts || !name) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel/ts/name in payload'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.reactions.remove({
                            channel,
                            timestamp: ts,
                            name,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'no_reaction' || getSlackErrorCode(err) === 'message_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.stars.add',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: starUrlResolver,
            rollback: {
                type: 'API_CALL',
                // Composite-key resource — the payload's (channel, ts, name) tuple IS the resource's natural identifier; there is no separate server-generated ID to read from the response.
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const channel = action.payload.channel;
                    const ts = action.payload.ts ?? action.payload.timestamp;
                    const file = action.payload.file;

                    if (!channel && !file) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel or file in payload'));
                    }

                    const client = context.client as WebClient;
                    const removeArgs = (file
                        ? { file }
                        : { channel, timestamp: ts }) as unknown as Parameters<typeof client.stars.remove>[0];

                    try {
                        await client.stars.remove(removeArgs);
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'not_starred') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 2: UPDATE actions (snapshot-restore, captureBeforeState: true) ────────────
        {
            apiName: 'slack.channels.rename',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: channelUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const beforeState = getBeforeState(action, orgId);
                    const channel = beforeState.channel ?? action.payload.channel;
                    const name = beforeState.name;

                    if (!channel || !name) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel/name in beforeState'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.conversations.rename({
                            channel,
                            name,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'channel_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.channels.setTopic',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: channelUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const beforeState = getBeforeState(action, orgId);
                    const channel = beforeState.channel ?? action.payload.channel;
                    const topic = beforeState.topic ?? '';

                    if (!channel) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel in beforeState/payload'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.conversations.setTopic({
                            channel,
                            topic,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'channel_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.channels.setPurpose',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: channelUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const beforeState = getBeforeState(action, orgId);
                    const channel = beforeState.channel ?? action.payload.channel;
                    const purpose = beforeState.purpose ?? '';

                    if (!channel) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel in beforeState/payload'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.conversations.setPurpose({
                            channel,
                            purpose,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'channel_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.userProfile.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: userProfileUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const beforeState = getBeforeState(action, orgId);
                    const profile = beforeState.profile;

                    if (!profile) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing profile in beforeState'));
                    }

                    const client = context.client as WebClient;
                    const user = typeof action.payload.user === 'string' ? action.payload.user : undefined;

                    try {
                        await client.users.profile.set({
                            profile: profile as Record<string, unknown>,
                            ...(user ? { user } : {}),
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'user_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.userGroups.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: userGroupUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const beforeState = getBeforeState(action, orgId);
                    const usergroup = beforeState.usergroup ?? action.payload.usergroup;

                    if (!usergroup) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing usergroup in beforeState/payload'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.usergroups.update({
                            usergroup,
                            ...(beforeState.name ? { name: beforeState.name } : {}),
                            ...(beforeState.handle ? { handle: beforeState.handle } : {}),
                            ...(beforeState.description ? { description: beforeState.description } : {}),
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'usergroup_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.userGroups.users.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            // The high safetyLevel reflects blast radius (can affect permissions and trigger notification pings for many users at once), not rollback infeasibility.
            safetyLevel: 'HIGH',
            resourceUrlResolver: userGroupUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const beforeState = getBeforeState(action, orgId);
                    const usergroup = beforeState.usergroup ?? action.payload.usergroup;
                    const users = beforeState.users;

                    if (!usergroup || !users) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing usergroup/users in beforeState'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.usergroups.users.update({
                            usergroup,
                            users: users.join(','),
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'usergroup_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 3: Toggle actions (inverse-operation rollback, captureBeforeState: false) ──
        {
            apiName: 'slack.channels.archive',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: channelUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const channel = action.payload.channel;
                    if (!channel) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel in payload'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.conversations.unarchive({
                            channel,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'not_archived' || getSlackErrorCode(err) === 'channel_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.channels.invite',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: channelUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const channel = action.payload.channel;
                    const usersToKick = parseUserList(action.payload.users, action.payload.user);

                    if (!channel || usersToKick.length === 0) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel/users in payload'));
                    }

                    const client = context.client as WebClient;
                    const failedUsers: string[] = [];

                    for (const user of usersToKick) {
                        try {
                            await client.conversations.kick({
                                channel,
                                user,
                            });
                        } catch (err) {
                            const errCode = getSlackErrorCode(err);
                            if (errCode === 'not_in_channel' || errCode === 'user_not_found') {
                                continue;
                            }
                            console.error(`[slackConnector] rollback failed to kick user: ${user} | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                            failedUsers.push(user);
                        }
                    }

                    if (failedUsers.length > 0) {
                        throw new Error(getRollbackErrorMessage(action, orgId, `Failed to kick users: ${failedUsers.join(', ')}`));
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.channels.kick',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: channelUrlResolver,
            rollback: {
                type: 'API_CALL',
                // Rollback may fail on permissions or private channels — this is expected and should surface as a normal rollback failure, not be silently swallowed.
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const channel = action.payload.channel;
                    const user = action.payload.user ?? (typeof action.payload.users === 'string' ? action.payload.users : Array.isArray(action.payload.users) ? action.payload.users[0] : undefined);
                    if (!channel || !user) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel/user in payload'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.conversations.invite({
                            channel,
                            users: user,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'already_in_channel') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.channels.join',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: channelUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const channel = action.payload.channel;
                    if (!channel) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel in payload'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.conversations.leave({
                            channel,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'not_in_channel') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.channels.leave',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: channelUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const channel = action.payload.channel;
                    if (!channel) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel in payload'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.conversations.join({
                            channel,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'already_in_channel') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.channels.close',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: channelUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const channel = action.payload.channel;
                    if (!channel) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel in payload'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.conversations.open({
                            channel,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'channel_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.channels.open',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'LOW',
            resourceUrlResolver: channelUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const channel = action.payload.channel;
                    if (!channel) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing channel in payload'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.conversations.close({
                            channel,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'channel_not_found') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.userGroups.enable',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: userGroupUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const usergroup = action.payload.usergroup;
                    if (!usergroup) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing usergroup in payload'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.usergroups.disable({
                            usergroup,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'already_disabled') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'slack.userGroups.disable',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: userGroupUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as SlackAction;
                    const usergroup = action.payload.usergroup;
                    if (!usergroup) {
                        throw new Error(getRollbackErrorMessage(action, orgId, 'Missing usergroup in payload'));
                    }

                    const client = context.client as WebClient;

                    try {
                        await client.usergroups.enable({
                            usergroup,
                        });
                    } catch (err) {
                        if (getSlackErrorCode(err) === 'already_enabled') {
                            return;
                        }

                        console.error(`[slackConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['slack.token'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 4: No safe rollback (safetyLevel: HIGH, rollback.type: NONE) ─────────────────
        {
            apiName: 'slack.files.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: fileUrlResolver,
            rollback: {
                type: 'NONE',
                execute: async (_rawAction: unknown, _context: RollbackContext): Promise<void> => {
                    throw new Error("deleted files are permanently removed from Slack's servers and cannot be restored");
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
    ],
};