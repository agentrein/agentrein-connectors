import type { ConnectorAction, Connector, RollbackContext } from '../types';
import { Octokit } from '@octokit/rest';

interface GitHubBeforeState {
    title?: string;
    body?: string;
    state?: 'open' | 'closed';
    labels?: Array<string | { name?: string }>;
    assignees?: Array<string | { login?: string }>;
    content?: string;
    path?: string;
    sha?: string;
    name?: string;
    tag_name?: string;
    draft?: boolean;
    prerelease?: boolean;
}

interface GitHubAction {
    id: string;
    operationType: 'CREATE' | 'UPDATE' | 'DELETE';
    payload: {
        owner?: string;
        repo?: string;
        org?: string;
        issue_number?: number;
        pull_number?: number;
        comment_id?: number;
        release_id?: number;
        workflow_id?: string | number;
        invitation_id?: number;
        path?: string;
        sha?: string;
        [key: string]: unknown;
    };
    response?: {
        data?: {
            number?: number;
            id?: number;
            path?: string;
            sha?: string;
            content?: {
                path?: string;
                sha?: string;
                [key: string]: unknown;
            };
            commit?: {
                sha?: string;
                [key: string]: unknown;
            };
            [key: string]: unknown;
        };
        number?: number;
        id?: number;
        path?: string;
        sha?: string;
        content?: {
            path?: string;
            sha?: string;
            [key: string]: unknown;
        };
        commit?: {
            sha?: string;
            [key: string]: unknown;
        };
        [key: string]: unknown;
    };
    snapshot?: {
        beforeState?: GitHubBeforeState | null;
        afterState?: GitHubBeforeState | null;
    };
}

function getIssueResponse(action: GitHubAction): NonNullable<GitHubAction['response']> {
    const response = action.response?.data ?? action.response;
    if (!response) {
        return {};
    }
    return response;
}

function getCreatedFileResponse(action: GitHubAction, orgId: string): { path: string; sha: string } {
    const res = (action.response?.data ?? action.response) as Record<string, unknown> | undefined;
    const contentObj = (res?.content ?? (res?.data as Record<string, unknown> | undefined)?.content) as Record<string, unknown> | undefined;
    const path = (typeof res?.path === 'string' ? res.path : undefined) ??
                 (typeof contentObj?.path === 'string' ? contentObj.path : undefined) ??
                 (typeof action.payload.path === 'string' ? action.payload.path : undefined);
    const sha = (typeof res?.sha === 'string' ? res.sha : undefined) ??
                (typeof contentObj?.sha === 'string' ? contentObj.sha : undefined);
    if (!path || !sha) {
        throw new Error(
            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing path or sha in create file response`,
        );
    }
    return { path, sha };
}

function getCreatedIssueCommentResponse(action: GitHubAction, orgId: string): { comment_id: number } {
    const res = (action.response?.data ?? action.response) as Record<string, unknown> | undefined;
    const commentId = typeof res?.id === 'number' ? res.id : undefined;
    if (!commentId) {
        throw new Error(
            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing comment id in create comment response`,
        );
    }
    return { comment_id: commentId };
}

function getCreatedReleaseResponse(action: GitHubAction, orgId: string): { release_id: number } {
    const res = (action.response?.data ?? action.response) as Record<string, unknown> | undefined;
    const releaseId = typeof res?.id === 'number' ? res.id : undefined;
    if (!releaseId) {
        throw new Error(
            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing release id in create release response`,
        );
    }
    return { release_id: releaseId };
}

function getCreatedInvitationResponse(action: GitHubAction, orgId: string): { org: string; invitation_id: number } {
    // action.payload.org/owner is the GitHub-side org/owner name, unrelated to AgentRein's tenant orgId used in rollback error reporting below.
    const org = typeof action.payload.org === 'string' ? action.payload.org : (typeof action.payload.owner === 'string' ? action.payload.owner : undefined);
    const res = (action.response?.data ?? action.response) as Record<string, unknown> | undefined;
    const invitationId = typeof res?.id === 'number' ? res.id : (typeof action.payload.invitation_id === 'number' ? action.payload.invitation_id : undefined);
    if (!org || !invitationId) {
        throw new Error(
            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing org or invitation_id for invite rollback`,
        );
    }
    return { org, invitation_id: invitationId };
}

function getErrorStatus(err: unknown): number | undefined {
    if (typeof err !== 'object' || err === null) return undefined;
    const e = err as Record<string, unknown>;
    if (typeof e.status === 'number') return e.status;
    return undefined;
}

type SnapshotConnectorAction = ConnectorAction & {
    resourceUrlResolver?: (apiName: string, payload: Record<string, unknown>) => string | null;
};

const GITHUB_API = 'https://api.github.com';

function issueUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const owner = typeof payload.owner === 'string' ? payload.owner : null;
    const repo = typeof payload.repo === 'string' ? payload.repo : null;
    const issueNumber = typeof payload.issue_number === 'number' ? payload.issue_number : null;
    if (!owner || !repo || issueNumber === null) {
        return null;
    }
    return `${GITHUB_API}/repos/${owner}/${repo}/issues/${issueNumber}`;
}

function fileUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const owner = typeof payload.owner === 'string' ? payload.owner : null;
    const repo = typeof payload.repo === 'string' ? payload.repo : null;
    const path = typeof payload.path === 'string' ? payload.path : null;
    if (!owner || !repo || !path) {
        return null;
    }
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    return `${GITHUB_API}/repos/${owner}/${repo}/contents/${cleanPath}`;
}

function issueCommentUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const owner = typeof payload.owner === 'string' ? payload.owner : null;
    const repo = typeof payload.repo === 'string' ? payload.repo : null;
    const commentId = typeof payload.comment_id === 'number' ? payload.comment_id : null;
    if (!owner || !repo || commentId === null) {
        return null;
    }
    return `${GITHUB_API}/repos/${owner}/${repo}/issues/comments/${commentId}`;
}

function pullRequestUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const owner = typeof payload.owner === 'string' ? payload.owner : null;
    const repo = typeof payload.repo === 'string' ? payload.repo : null;
    const pullNumber = typeof payload.pull_number === 'number' ? payload.pull_number : null;
    if (!owner || !repo || pullNumber === null) {
        return null;
    }
    return `${GITHUB_API}/repos/${owner}/${repo}/pulls/${pullNumber}`;
}

function pullRequestCommentUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const owner = typeof payload.owner === 'string' ? payload.owner : null;
    const repo = typeof payload.repo === 'string' ? payload.repo : null;
    const commentId = typeof payload.comment_id === 'number' ? payload.comment_id : null;
    if (!owner || !repo || commentId === null) {
        return null;
    }
    return `${GITHUB_API}/repos/${owner}/${repo}/pulls/comments/${commentId}`;
}

function releaseUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const owner = typeof payload.owner === 'string' ? payload.owner : null;
    const repo = typeof payload.repo === 'string' ? payload.repo : null;
    const releaseId = typeof payload.release_id === 'number' ? payload.release_id : null;
    if (!owner || !repo || releaseId === null) {
        return null;
    }
    return `${GITHUB_API}/repos/${owner}/${repo}/releases/${releaseId}`;
}

function workflowUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const owner = typeof payload.owner === 'string' ? payload.owner : null;
    const repo = typeof payload.repo === 'string' ? payload.repo : null;
    const workflowId = typeof payload.workflow_id === 'string' || typeof payload.workflow_id === 'number' ? payload.workflow_id : null;
    if (!owner || !repo || !workflowId) {
        return null;
    }
    return `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${workflowId}`;
}

function reviewUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const owner = typeof payload.owner === 'string' ? payload.owner : null;
    const repo = typeof payload.repo === 'string' ? payload.repo : null;
    const pullNumber = typeof payload.pull_number === 'number' ? payload.pull_number : null;
    if (!owner || !repo || pullNumber === null) {
        return null;
    }
    return `${GITHUB_API}/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`;
}

function userInviteUrlResolver(_apiName: string, payload: Record<string, unknown>): string | null {
    const org = typeof payload.org === 'string' ? payload.org : (typeof payload.owner === 'string' ? payload.owner : null);
    if (!org) {
        return null;
    }
    return `${GITHUB_API}/orgs/${org}/invitations`;
}

export const githubConnector: Connector = {
    connector: 'github',
    actions: [
        {
            apiName: 'github.issues.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: issueUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const issue = getIssueResponse(action);
                    const owner = action.payload.owner;
                    const repo = action.payload.repo;
                    const issueNumber = issue.number;

                    if (!owner || !repo || !issueNumber) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner/repo/number in payload or response`,
                        );
                    }

                    const client = context.client as Octokit;
                    try {
                        await client.issues.update({
                            owner,
                            repo,
                            issue_number: issueNumber,
                            state: 'closed',
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.issues.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: issueUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const beforeState = action.snapshot?.beforeState ?? null;
                    if (!beforeState) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    const owner = action.payload.owner;
                    const repo = action.payload.repo;
                    const issueNumber = action.payload.issue_number;
                    if (!owner || !repo || !issueNumber) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner/repo/issue_number in payload`,
                        );
                    }

                    const labels = beforeState.labels
                        ?.map((label) => (typeof label === 'string' ? label : label?.name))
                        .filter((label): label is string => Boolean(label));

                    const assignees = beforeState.assignees
                        ?.map((assignee) => (typeof assignee === 'string' ? assignee : assignee?.login))
                        .filter((assignee): assignee is string => Boolean(assignee));

                    const client = context.client as Octokit;
                    try {
                        await client.issues.update({
                            owner,
                            repo,
                            issue_number: issueNumber,
                            title: beforeState.title,
                            body: beforeState.body,
                            state: beforeState.state,
                            labels,
                            assignees,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 1: CREATE actions ──────────────────────────────────────────
        {
            apiName: 'github.files.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: fileUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const createdFile = getCreatedFileResponse(action, orgId);
                    const owner = action.payload.owner;
                    const repo = action.payload.repo;

                    if (!owner || !repo) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner or repo in payload`,
                        );
                    }

                    const client = context.client as Octokit;
                    try {
                        await client.repos.deleteFile({
                            owner,
                            repo,
                            path: createdFile.path,
                            sha: createdFile.sha,
                            message: 'Rollback creation of file',
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.issueComments.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: issueCommentUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const comment = getCreatedIssueCommentResponse(action, orgId);
                    const owner = action.payload.owner;
                    const repo = action.payload.repo;

                    if (!owner || !repo) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner or repo in payload`,
                        );
                    }

                    const client = context.client as Octokit;
                    try {
                        await client.issues.deleteComment({
                            owner,
                            repo,
                            comment_id: comment.comment_id,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.releases.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: releaseUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const release = getCreatedReleaseResponse(action, orgId);
                    const owner = action.payload.owner;
                    const repo = action.payload.repo;

                    if (!owner || !repo) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner or repo in payload`,
                        );
                    }

                    const client = context.client as Octokit;
                    try {
                        await client.repos.deleteRelease({
                            owner,
                            repo,
                            release_id: release.release_id,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 2: UPDATE/DELETE snapshot-restore actions ───────────────────
        {
            apiName: 'github.files.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: fileUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const beforeState = action.snapshot?.beforeState ?? null;
                    if (!beforeState || !beforeState.content) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState content`,
                        );
                    }

                    // Extract post-update file sha from original update action response (or snapshot.afterState)
                    const res = (action.response?.data ?? action.response) as Record<string, unknown> | undefined;
                    const contentObj = (res?.content ?? (res?.data as Record<string, unknown> | undefined)?.content) as Record<string, unknown> | undefined;
                    const currentSha = (typeof res?.sha === 'string' ? res.sha : undefined) ??
                                       (typeof contentObj?.sha === 'string' ? contentObj.sha : undefined) ??
                                       action.snapshot?.afterState?.sha;

                    if (!currentSha) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Platform gap — missing current file sha (response/afterState sha) needed to rollback file update`,
                        );
                    }

                    const owner = action.payload.owner;
                    const repo = action.payload.repo;
                    const path = action.payload.path ?? beforeState.path;
                    if (!owner || !repo || !path) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner/repo/path`,
                        );
                    }

                    const client = context.client as Octokit;
                    try {
                        await client.repos.createOrUpdateFileContents({
                            owner,
                            repo,
                            path,
                            message: 'Rollback file update to previous content',
                            content: beforeState.content,
                            sha: currentSha,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.files.delete',
            captureBeforeState: true,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: fileUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const beforeState = action.snapshot?.beforeState ?? null;
                    if (!beforeState || !beforeState.content) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState content`,
                        );
                    }

                    const owner = action.payload.owner;
                    const repo = action.payload.repo;
                    const path = action.payload.path ?? beforeState.path;
                    if (!owner || !repo || !path) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner/repo/path`,
                        );
                    }

                    // Note: git history/commit chain is not restored, only file content.
                    const client = context.client as Octokit;
                    try {
                        await client.repos.createOrUpdateFileContents({
                            owner,
                            repo,
                            path,
                            message: 'Rollback file deletion by recreating file',
                            content: beforeState.content,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.pullRequestComments.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: pullRequestCommentUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const beforeState = action.snapshot?.beforeState ?? null;
                    if (!beforeState || beforeState.body === undefined) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState body`,
                        );
                    }

                    const owner = action.payload.owner;
                    const repo = action.payload.repo;
                    const commentId = action.payload.comment_id;
                    if (!owner || !repo || !commentId) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner/repo/comment_id in payload`,
                        );
                    }

                    const client = context.client as Octokit;
                    try {
                        // PR conversation comments share GitHub's issue comments endpoint; review-line comments are a separate resource, out of scope for this batch.
                        await client.issues.updateComment({
                            owner,
                            repo,
                            comment_id: commentId,
                            body: beforeState.body,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.pullRequests.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: pullRequestUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const beforeState = action.snapshot?.beforeState ?? null;
                    if (!beforeState) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    const owner = action.payload.owner;
                    const repo = action.payload.repo;
                    const pullNumber = action.payload.pull_number;
                    if (!owner || !repo || !pullNumber) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner/repo/pull_number in payload`,
                        );
                    }

                    const client = context.client as Octokit;
                    try {
                        await client.pulls.update({
                            owner,
                            repo,
                            pull_number: pullNumber,
                            title: beforeState.title,
                            body: beforeState.body,
                            state: beforeState.state,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.releases.update',
            captureBeforeState: true,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: releaseUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const beforeState = action.snapshot?.beforeState ?? null;
                    if (!beforeState) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing beforeState`,
                        );
                    }

                    const owner = action.payload.owner;
                    const repo = action.payload.repo;
                    const releaseId = action.payload.release_id;
                    if (!owner || !repo || !releaseId) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner/repo/release_id in payload`,
                        );
                    }

                    const client = context.client as Octokit;
                    try {
                        await client.repos.updateRelease({
                            owner,
                            repo,
                            release_id: releaseId,
                            name: beforeState.name,
                            body: beforeState.body,
                            tag_name: beforeState.tag_name,
                            draft: beforeState.draft,
                            prerelease: beforeState.prerelease,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 3: Toggle actions ──────────────────────────────────────────
        {
            apiName: 'github.issues.lock',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: issueUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const owner = action.payload.owner;
                    const repo = action.payload.repo;
                    const issueNumber = action.payload.issue_number;

                    if (!owner || !repo || !issueNumber) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner/repo/issue_number in payload`,
                        );
                    }

                    const client = context.client as Octokit;
                    try {
                        await client.issues.unlock({
                            owner,
                            repo,
                            issue_number: issueNumber,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.pullRequests.close',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: pullRequestUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const owner = action.payload.owner;
                    const repo = action.payload.repo;
                    const pullNumber = action.payload.pull_number;

                    if (!owner || !repo || !pullNumber) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner/repo/pull_number in payload`,
                        );
                    }

                    const client = context.client as Octokit;
                    try {
                        await client.pulls.update({
                            owner,
                            repo,
                            pull_number: pullNumber,
                            state: 'open',
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.pullRequests.reopen',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: pullRequestUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const owner = action.payload.owner;
                    const repo = action.payload.repo;
                    const pullNumber = action.payload.pull_number;

                    if (!owner || !repo || !pullNumber) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner/repo/pull_number in payload`,
                        );
                    }

                    const client = context.client as Octokit;
                    try {
                        await client.pulls.update({
                            owner,
                            repo,
                            pull_number: pullNumber,
                            state: 'closed',
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.workflows.enable',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: workflowUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const owner = action.payload.owner;
                    const repo = action.payload.repo;
                    const workflowId = action.payload.workflow_id;

                    if (!owner || !repo || !workflowId) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner/repo/workflow_id in payload`,
                        );
                    }

                    const client = context.client as Octokit;
                    try {
                        await client.actions.disableWorkflow({
                            owner,
                            repo,
                            workflow_id: workflowId,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.workflows.disable',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            resourceUrlResolver: workflowUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const owner = action.payload.owner;
                    const repo = action.payload.repo;
                    const workflowId = action.payload.workflow_id;

                    if (!owner || !repo || !workflowId) {
                        throw new Error(
                            `[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: Missing owner/repo/workflow_id in payload`,
                        );
                    }

                    const client = context.client as Octokit;
                    try {
                        await client.actions.enableWorkflow({
                            owner,
                            repo,
                            workflow_id: workflowId,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,

        // ─── Group 4: Non-reversible & High Safety actions ────────────────────
        {
            apiName: 'github.pullRequests.merge',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: pullRequestUrlResolver,
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error('merge is not reversible — use an explicit revert-PR flow instead');
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.workflows.dispatch',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: workflowUrlResolver,
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error('workflow dispatch triggers a real run and cannot be undone');
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.releases.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: releaseUrlResolver,
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error('deleted release and its assets cannot be reliably restored');
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.reviews.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: reviewUrlResolver,
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error('GitHub does not support deleting a submitted review');
                },
                requires: [],
            },
        } as SnapshotConnectorAction,
        {
            apiName: 'github.users.invite',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            resourceUrlResolver: userInviteUrlResolver,
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as GitHubAction;
                    const invite = getCreatedInvitationResponse(action, orgId);

                    const client = context.client as Octokit;
                    try {
                        await client.orgs.cancelInvitation({
                            org: invite.org,
                            invitation_id: invite.invitation_id,
                        });
                    } catch (err) {
                        if (getErrorStatus(err) === 404) {
                            return;
                        }
                        console.error(`[githubConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
                        throw err;
                    }
                },
                requires: ['github.token'],
            },
        } as SnapshotConnectorAction,
    ],
};
