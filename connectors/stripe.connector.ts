import type { ConnectorAction, Connector, RollbackContext } from '../types';
import Stripe from 'stripe';

interface StripeAction {
    id: string;
    operationType: 'CREATE' | 'UPDATE' | 'DELETE';
    payload: Record<string, unknown>;
    response?: {
        data?: {
            id?: string;
            status?: string;
            [key: string]: unknown;
        };
        id?: string;
        status?: string;
        [key: string]: unknown;
    };
    undoConfig?: {
        requireApproval?: boolean;
        safetyLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
        reason?: string;
    };
    snapshot?: {
        beforeState?: Record<string, unknown> | null;
    };
}

type StripeConnectorAction = ConnectorAction & {
    undoConfig?: StripeAction['undoConfig'];
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getResponseRecord(action: StripeAction): Record<string, unknown> {
    const response = action.response;
    if (isRecord(response) && isRecord(response.data)) return response.data;
    if (isRecord(response)) return response;
    return {};
}

function getRollbackError(action: StripeAction, orgId: string, reason: string): Error {
    return new Error(
        `[stripeConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType} | reason: ${reason}`,
    );
}

function requireStringId(record: Record<string, unknown>, action: StripeAction, orgId: string, resource: string): string {
    if (typeof record.id !== 'string') {
        const err = getRollbackError(action, orgId, `Missing ${resource} id in response`);
        console.error(`[stripeConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`, err);
        throw err;
    }
    return record.id;
}

function isNonDraftInvoiceError(err: unknown): boolean {
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
        return err.code === 'invoice_not_editable' ||
            err.code === 'invoice_already_finalized';
    }
    return false;
}

function isNotFoundError(err: unknown): boolean {
    if (err instanceof Stripe.errors.StripeInvalidRequestError) {
        return err.statusCode === 404;
    }
    return false;
}

const stripeActions = [
        {
            apiName: 'stripe.invoices.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as StripeAction;
                    const res = getResponseRecord(action);
                    const client = context.client as Stripe;
                    const invoiceId = requireStringId(res, action, orgId, 'invoice');

                    try {
                        await client.invoices.del(invoiceId);
                    } catch (err) {
                        if (isNonDraftInvoiceError(err)) {
                            const rollbackErr = getRollbackError(
                                action,
                                orgId,
                                'Invoice is no longer a Draft — manual intervention required (Void or Credit Note)',
                            );
                            console.error(
                                `[stripeConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`,
                                err,
                            );
                            throw rollbackErr;
                        }

                        console.error(
                            `[stripeConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`,
                            err,
                        );
                        throw err;
                    }
                },
                requires: ['stripe.apiKey'],
            },
        },
        {
            apiName: 'stripe.customers.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as StripeAction;
                    const res = getResponseRecord(action);
                    const client = context.client as Stripe;
                    const customerId = requireStringId(res, action, orgId, 'customer');

                    try {
                        await client.customers.del(customerId);
                    } catch (err) {
                        if (isNotFoundError(err)) return;

                        console.error(
                            `[stripeConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`,
                            err,
                        );
                        throw err;
                    }
                },
                requires: ['stripe.apiKey'],
            },
        },
        {
            apiName: 'stripe.refunds.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            undoConfig: {
                requireApproval: true,
                reason: 'Refunds are irreversible on Stripe — human approval required before execution',
            },
            rollback: {
                type: 'NONE',
                execute: async (_action: unknown, _context: RollbackContext): Promise<void> => {},
                requires: [],
            },
        },
        // Stripe charges cannot be deleted or cancelled via the API. Reversal requires a separate
        // stripe.refunds.create action, which must never be triggered automatically during rollback (Decision 1 principle).
        {
            apiName: 'stripe.charges.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            rollback: {
                type: 'NONE',
                execute: async (): Promise<void> => {
                    throw new Error(
                        'Stripe charges cannot be deleted, voided, or cancelled via the API. If reversal is needed, a separate stripe.refunds.create action must be explicitly initiated and approved — this is never triggered automatically as part of charge rollback.',
                    );
                },
                requires: [],
            },
        },
        {
            apiName: 'stripe.customers.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            rollback: {
                type: 'NONE',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as StripeAction;
                    throw getRollbackError(
                        action,
                        orgId,
                        'Stripe customer deletion is permanent and cannot be undone — no restore endpoint exists.',
                    );
                },
                requires: [],
            },
        },
        {
            apiName: 'stripe.coupons.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'MEDIUM',
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as StripeAction;
                    const res = getResponseRecord(action);
                    const client = context.client as Stripe;
                    const couponId = requireStringId(res, action, orgId, 'coupon');

                    try {
                        await client.coupons.del(couponId);
                    } catch (err) {
                        if (isNotFoundError(err)) return;

                        console.error(
                            `[stripeConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`,
                            err,
                        );
                        throw err;
                    }
                },
                requires: ['stripe.apiKey'],
            },
        },
        {
            apiName: 'stripe.coupons.delete',
            captureBeforeState: false,
            operationType: 'DELETE',
            safetyLevel: 'HIGH',
            rollback: {
                type: 'NONE',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as StripeAction;
                    throw getRollbackError(
                        action,
                        orgId,
                        'Stripe coupon deletion is permanent — deleted coupons cannot be restored, only new coupons can be created.',
                    );
                },
                requires: [],
            },
        },
        // Meter events can only be canceled within 24 hours of ingestion via meterEventAdjustments.
        // safetyLevel remains HIGH despite having an API_CALL rollback path (safetyLevel and rollback.type are independent).
        {
            apiName: 'stripe.meterEvents.create',
            captureBeforeState: false,
            operationType: 'CREATE',
            safetyLevel: 'HIGH',
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as StripeAction;
                    const res = getResponseRecord(action);
                    const client = context.client as Stripe;
                    const identifier = requireStringId(res, action, orgId, 'meter event identifier');
                    const eventName = typeof res.event_name === 'string' ? res.event_name : (action.payload?.event_name as string);

                    if (!eventName) {
                        const err = getRollbackError(action, orgId, 'Missing meter event event_name in response or payload');
                        console.error(
                            `[stripeConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`,
                            err,
                        );
                        throw err;
                    }

                    try {
                        await client.billing.meterEventAdjustments.create({
                            event_name: eventName,
                            type: 'cancel',
                            cancel: {
                                identifier,
                            },
                        });
                    } catch (err) {
                        console.error(
                            `[stripeConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`,
                            err,
                        );
                        throw getRollbackError(
                            action,
                            orgId,
                            `Meter event cancellation failed — the 24-hour cancellation window may have passed: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }
                },
                requires: ['stripe.apiKey'],
            },
        },
        // Toggle target — paymentMethodId is caller-specified in the payload; reversing attach is calling detach on the same id.
        {
            apiName: 'stripe.paymentMethods.attach',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'MEDIUM',
            rollback: {
                type: 'API_CALL',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as StripeAction;
                    const client = context.client as Stripe;
                    const paymentMethodId =
                        (action.payload?.paymentMethodId as string | undefined) ??
                        (action.payload?.payment_method_id as string | undefined) ??
                        (action.payload?.id as string | undefined);

                    if (!paymentMethodId || typeof paymentMethodId !== 'string') {
                        const err = getRollbackError(
                            action,
                            orgId,
                            'Missing paymentMethodId in payload for paymentMethods.attach rollback',
                        );
                        console.error(
                            `[stripeConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`,
                            err,
                        );
                        throw err;
                    }

                    try {
                        await client.paymentMethods.detach(paymentMethodId);
                    } catch (err) {
                        if (isNotFoundError(err)) return;

                        console.error(
                            `[stripeConnector] rollback failed | action: ${action.id} | org: ${orgId} | op: ${action.operationType}`,
                            err,
                        );
                        throw err;
                    }
                },
                requires: ['stripe.apiKey'],
            },
        },
        // Stripe SDK explicit docstring constraint: "Detachment is permanent and irreversible — once detached,
        // a PaymentMethod can no longer be used for payments or re-attached to a Customer."
        {
            apiName: 'stripe.paymentMethods.detach',
            captureBeforeState: false,
            operationType: 'UPDATE',
            safetyLevel: 'HIGH',
            rollback: {
                type: 'NONE',
                execute: async (rawAction: unknown, context: RollbackContext): Promise<void> => {
                    const orgId = context.orgId ?? 'unknown';
                    const action = rawAction as StripeAction;
                    throw getRollbackError(
                        action,
                        orgId,
                        "Stripe payment method detachment is permanent and irreversible per Stripe's API — a detached payment method cannot be re-attached to any customer.",
                    );
                },
                requires: [],
            },
        },
    ] satisfies StripeConnectorAction[];

export const stripeConnector: Connector = {
    connector: 'stripe',
    actions: stripeActions,
};
