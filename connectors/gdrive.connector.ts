import type { ConnectorAction, Connector, RollbackContext } from '../types';
import { drive_v3 } from 'googleapis';

interface DriveFile {
    id: string;
    name: string;
    mimeType: string;
    parents?: string[];
    trashed?: boolean;
    [key: string]: unknown;
}

interface GDriveAction {
    id: string;
    operationType: 'CREATE' | 'UPDATE' | 'DELETE';
    payload: {
        fileId?: string;
        addParents?: string;
        removeParents?: string;
        [key: string]: unknown;
    };
    response?: {
        data?: DriveFile;
    } & DriveFile;
    undoConfig?: {
        requireApproval?: boolean;
        safetyLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
        reason?: string;
    };
    snapshot?: {
        beforeState?: Partial<DriveFile> | null;
    };
}

function getResponse(action: GDriveAction, orgId: string): DriveFile {
    const response = action.response?.data ?? action.response;
    if (!response) {
        throw new Error(
            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing response`,
        );
    }
    return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function handleGDriveRollbackError(action: GDriveAction, orgId: string, err: unknown, permissionHint: string): void {
    const status = getErrorStatus(err);

    if (status === 404) {
        return;
    }

    if (status === 403) {
        throw new Error(
            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: PERMISSION_DENIED — ${permissionHint}`,
        );
    }

    console.error(`[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
    throw err;
}

type SnapshotConnectorAction = ConnectorAction & {
    resourceUrlResolver?: (apiName: string, payload: Record<string, unknown>) => string | null;
};

function getDriveFileUrl(fileId: string | undefined): string | null {
    return fileId ? `https://www.googleapis.com/drive/v3/files/${fileId}` : null;
}

function getSharedDriveUrl(driveId: string | undefined): string | null {
    return driveId ? `https://www.googleapis.com/drive/v3/drives/${driveId}` : null;
}

interface DrivePermission {
    id: string;
    [key: string]: unknown;
}

interface GDrivePermissionAction {
    id: string;
    operationType: 'CREATE' | 'UPDATE' | 'DELETE';
    payload: {
        fileId?: string;
        permissionId?: string;
        [key: string]: unknown;
    };
    response?: {
        data?: DrivePermission;
    } & DrivePermission;
    undoConfig?: {
        requireApproval?: boolean;
        safetyLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
        reason?: string;
    };
}

function getCreatedPermissionResponse(action: GDrivePermissionAction, orgId: string): DrivePermission {
    const response = action.response?.data ?? action.response;
    if (!response || !response.id) {
        throw new Error(
            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing permission response or permission id`,
        );
    }
    return response;
}

export const gdriveConnector: Connector = {
    connector: 'gdrive',
    actions: [
        {
            apiName: 'gdrive.files.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: () => null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GDriveAction;
                    const file = getResponse(action, orgId);
                    if (!file.id) {
                        throw new Error(
                            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing file id in response`,
                        );
                    }

                    const client = context.client as drive_v3.Drive;
                    // IMPORTANT: Using files.update({ trashed: true }) instead of files.delete.
                    // files.delete is a permanent hard delete with no recovery.
                    // Trashing gives the user a 30-day window to recover the file manually
                    // if the rollback was triggered in error. Data Loss Risk → near zero.
                    try {
                        await client.files.update({
                            fileId: file.id,
                            requestBody: { trashed: true },
                        });
                    } catch (err) {
                        handleGDriveRollbackError(action, orgId, err, 'verify Service Account has write access to this file');
                    }
                },
                requires: ['google.clientId', 'google.clientSecret', 'google.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gdrive.files.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                getDriveFileUrl(typeof payload.id === 'string' ? payload.id : undefined),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GDriveAction;
                    const beforeState = action.snapshot?.beforeState ?? null;
                    if (!beforeState) {
                        throw new Error(
                            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    const { id, ...requestBody } = beforeState;
                    if (!id) {
                        throw new Error(
                            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing file id in beforeState`,
                        );
                    }

                    const client = context.client as drive_v3.Drive;
                    // Restores only the changed fields — surgical rollback, not full overwrite.
                    try {
                        await client.files.update({
                            fileId: id,
                            requestBody,
                        });
                    } catch (err) {
                        handleGDriveRollbackError(action, orgId, err, 'verify Service Account has write access to this file');
                    }
                },
                requires: ['google.clientId', 'google.clientSecret', 'google.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gdrive.files.move',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                getDriveFileUrl(typeof payload.fileId === 'string' ? payload.fileId : undefined),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GDriveAction;
                    const fileId = action.payload.fileId;
                    if (!fileId) {
                        throw new Error(
                            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing fileId in payload`,
                        );
                    }

                    const addParents = action.payload.removeParents;
                    const removeParents = action.payload.addParents;
                    if (!addParents) {
                        throw new Error(
                            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing removeParents in payload — Move configuration is broken`,
                        );
                    }

                    if (!removeParents) {
                        throw new Error(
                            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing addParents in payload — Move configuration is broken`,
                        );
                    }

                    const client = context.client as drive_v3.Drive;
                    try {
                        await client.files.update({
                            fileId,
                            addParents,
                            removeParents,
                        });
                    } catch (err) {
                        handleGDriveRollbackError(action, orgId, err, 'verify Service Account has access to source and destination folders');
                    }
                },
                requires: ['google.clientId', 'google.clientSecret', 'google.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gdrive.files.trash',
            captureBeforeState: true,
            operationType: 'DELETE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: () => null,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GDriveAction;
                    const file = getResponse(action, orgId);
                    if (!file.id) {
                        throw new Error(
                            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing file id in response`,
                        );
                    }

                    const client = context.client as drive_v3.Drive;
                    let currentFile: DriveFile;
                    try {
                        const current = await client.files.get({ fileId: file.id, fields: 'id,trashed' });
                        currentFile = current.data as DriveFile;
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        handleGDriveRollbackError(action, orgId, err, 'verify Service Account has write access to this file');
                        return;
                    }

                    if (currentFile.trashed === false) {
                        return;
                    }

                    try {
                        await client.files.update({
                            fileId: file.id,
                            requestBody: { trashed: false },
                        });
                    } catch (err) {
                        handleGDriveRollbackError(action, orgId, err, 'verify Service Account has write access to this file');
                    }
                },
                requires: ['google.clientId', 'google.clientSecret', 'google.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gdrive.files.copy',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                getDriveFileUrl(typeof payload.fileId === 'string' ? payload.fileId : (typeof payload.id === 'string' ? payload.id : undefined)),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GDriveAction;
                    const file = getResponse(action, orgId);
                    if (!file.id) {
                        throw new Error(
                            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing file id in response`,
                        );
                    }

                    const client = context.client as drive_v3.Drive;
                    try {
                        await client.files.update({
                            fileId: file.id,
                            requestBody: { trashed: true },
                        });
                    } catch (err) {
                        handleGDriveRollbackError(action, orgId, err, 'verify Service Account has write access to this file');
                    }
                },
                requires: ['google.clientId', 'google.clientSecret', 'google.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gdrive.files.share',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                getDriveFileUrl(typeof payload.fileId === 'string' ? payload.fileId : undefined),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GDrivePermissionAction;
                    const permission = getCreatedPermissionResponse(action, orgId);
                    const fileId = action.payload.fileId;
                    if (!fileId) {
                        throw new Error(
                            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing fileId in payload`,
                        );
                    }

                    const client = context.client as drive_v3.Drive;
                    try {
                        await client.permissions.delete({
                            fileId,
                            permissionId: permission.id,
                        });
                    } catch (err) {
                        handleGDriveRollbackError(action as unknown as GDriveAction, orgId, err, 'verify Service Account has permission management access on this file');
                    }
                },
                requires: ['google.clientId', 'google.clientSecret', 'google.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gdrive.drives.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                getSharedDriveUrl(typeof payload.driveId === 'string' ? payload.driveId : (typeof payload.id === 'string' ? payload.id : undefined)),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GDriveAction;
                    const drive = getResponse(action, orgId);
                    if (!drive.id) {
                        throw new Error(
                            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing drive id in response`,
                        );
                    }

                    const client = context.client as drive_v3.Drive;
                    // Safe to delete because the Shared Drive was JUST created and is necessarily empty.
                    // Deleting an existing Shared Drive with content is non-reversible (see gdrive.drives.delete).
                    try {
                        await client.drives.delete({
                            driveId: drive.id,
                        });
                    } catch (err) {
                        handleGDriveRollbackError(action, orgId, err, 'verify Service Account has admin access to delete this Shared Drive');
                    }
                },
                requires: ['google.clientId', 'google.clientSecret', 'google.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gdrive.drives.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                getSharedDriveUrl(typeof payload.driveId === 'string' ? payload.driveId : (typeof payload.id === 'string' ? payload.id : undefined)),
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GDriveAction;
                    const beforeState = action.snapshot?.beforeState ?? null;
                    if (!beforeState) {
                        throw new Error(
                            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    const { id, ...requestBody } = beforeState;
                    if (!id) {
                        throw new Error(
                            `[gdriveConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing drive id in beforeState`,
                        );
                    }

                    const client = context.client as drive_v3.Drive;
                    // Restores only the changed fields — surgical rollback, not full overwrite.
                    try {
                        await client.drives.update({
                            driveId: id,
                            requestBody,
                        });
                    } catch (err) {
                        handleGDriveRollbackError(action, orgId, err, 'verify Service Account has admin access to update this Shared Drive');
                    }
                },
                requires: ['google.clientId', 'google.clientSecret', 'google.refreshToken'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gdrive.files.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                getDriveFileUrl(typeof payload.fileId === 'string' ? payload.fileId : (typeof payload.id === 'string' ? payload.id : undefined)),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error('permanent file deletion cannot be undone — use files.trash for reversible deletion instead');
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'gdrive.drives.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: (_apiName: string, payload: Record<string, unknown>) =>
                getSharedDriveUrl(typeof payload.driveId === 'string' ? payload.driveId : (typeof payload.id === 'string' ? payload.id : undefined)),
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'Shared Drive deletion cannot be safely undone — Shared Drives have no trash concept, and a drive being deleted may contain content that cannot be recovered',
                    );
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
    ],
};

