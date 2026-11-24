import { prepareAudit } from "../../_shared/audit.js";

const VERSION = "1.1.0";

const VALID_STATUSES = [
    "pending",
    "under_review",
    "shortlisted",
    "interview",
    "accepted",
    "declined",
    "withdrawn"
];

const COMPLETED_STATUSES = [
    "accepted",
    "declined",
    "withdrawn"
];

const STATUS_TRANSITIONS = {
    pending: [
        "under_review",
        "shortlisted",
        "declined",
        "withdrawn"
    ],

    under_review: [
        "pending",
        "shortlisted",
        "interview",
        "accepted",
        "declined",
        "withdrawn"
    ],

    shortlisted: [
        "under_review",
        "interview",
        "accepted",
        "declined",
        "withdrawn"
    ],

    interview: [
        "under_review",
        "shortlisted",
        "accepted",
        "declined",
        "withdrawn"
    ],

    accepted: [
        "under_review"
    ],

    declined: [
        "under_review"
    ],

    withdrawn: [
        "under_review"
    ]
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store, private, max-age=0",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff"
        }
    });
}

function failure(context, error, status, extra = {}) {
    return jsonResponse({
        success: false,
        error,
        ...extra,
        requestId: context.data.requestId
    }, status);
}

function success(context, payload = {}) {
    return jsonResponse({
        success: true,
        service: "Obsidian Crown Administration",
        version: VERSION,
        ...payload,
        requestId: context.data.requestId
    });
}

function authorize(context) {
    if (!context.data.admin?.email) {
        return failure(
            context,
            "Authentication required",
            401
        );
    }

    if (!context.env.DB) {
        return failure(
            context,
            "Database unavailable",
            503
        );
    }

    return null;
}

function validApplicationId(value) {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 128 &&
        /^[a-zA-Z0-9_-]+$/.test(value)
    );
}

async function readBody(context) {
    const contentType = (
        context.request.headers.get("Content-Type") || ""
    ).split(";")[0].trim().toLowerCase();

    if (contentType !== "application/json") {
        return {
            error: failure(
                context,
                "Content-Type must be application/json",
                415
            )
        };
    }

    try {
        const rawBody = await context.request.text();

        if (rawBody.length > 16000) {
            return {
                error: failure(
                    context,
                    "Request body is too large",
                    413
                )
            };
        }

        const body = JSON.parse(rawBody);

        if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body)
        ) {
            throw new Error("Invalid request body");
        }

        return { body };

    } catch {
        return {
            error: failure(
                context,
                "Invalid JSON request body",
                400
            )
        };
    }
}

function normalizeStatus(value) {
    return typeof value === "string"
        ? value.trim().toLowerCase()
        : "";
}

function nextTimestamp(previousTimestamp) {
    const previous = Date.parse(previousTimestamp);

    return new Date(
        Math.max(
            Date.now(),
            Number.isFinite(previous)
                ? previous + 1
                : 0
        )
    ).toISOString();
}

export async function onRequestGet(context) {
    const denied = authorize(context);

    if (denied) {
        return denied;
    }

    return success(context, {
        endpoint: "Application Status Management",

        method: "POST",

        validStatuses: VALID_STATUSES,

        transitions: STATUS_TRANSITIONS,

        requiredFields: [
            "applicationId",
            "status",
            "expectedStatus"
        ],

        optionalFields: [
            "notes",
            "expectedUpdatedAt"
        ],

        capabilities: {
            statusManagement: true,
            historyTracking: true,
            auditLogging: true,
            concurrencyProtection: true,
            reopeningProtection: true
        }
    });
}

export async function onRequestPost(context) {
    const denied = authorize(context);

    if (denied) {
        return denied;
    }

    const parsed = await readBody(context);

    if (parsed.error) {
        return parsed.error;
    }

    const { body } = parsed;
    const { env, data } = context;

    const administrator = data.admin;

    const applicationId =
        typeof body.applicationId === "string"
            ? body.applicationId.trim()
            : "";

    const newStatus = normalizeStatus(
        body.status
    );

    const expectedStatus = normalizeStatus(
        body.expectedStatus
    );

    if (
        body.notes !== undefined &&
        body.notes !== null &&
        typeof body.notes !== "string"
    ) {
        return failure(
            context,
            "Notes must be a string",
            400
        );
    }

    const notes =
        typeof body.notes === "string"
            ? body.notes.trim()
            : "";

    if (
        body.expectedUpdatedAt !== undefined &&
        (
            typeof body.expectedUpdatedAt !== "string" ||
            !body.expectedUpdatedAt.trim() ||
            body.expectedUpdatedAt.length > 100
        )
    ) {
        return failure(
            context,
            "Invalid expectedUpdatedAt",
            400
        );
    }

    const expectedUpdatedAt =
        body.expectedUpdatedAt || null;

    if (!validApplicationId(applicationId)) {
        return failure(
            context,
            "Invalid application ID",
            400
        );
    }

    if (!VALID_STATUSES.includes(newStatus)) {
        return failure(
            context,
            "Invalid application status",
            400,
            {
                validStatuses: VALID_STATUSES
            }
        );
    }

    if (!VALID_STATUSES.includes(expectedStatus)) {
        return failure(
            context,
            "A valid expectedStatus is required",
            400,
            {
                validStatuses: VALID_STATUSES
            }
        );
    }

    if (notes.length > 3000) {
        return failure(
            context,
            "Decision notes cannot exceed 3000 characters",
            400
        );
    }

    try {
        const application = await env.DB.prepare(`
            SELECT
                application_id,
                display_name,
                status,
                reviewer,
                updated_at
            FROM applications
            WHERE application_id = ?
            LIMIT 1
        `).bind(applicationId).first();

        if (!application) {
            return failure(
                context,
                "Application not found",
                404,
                { applicationId }
            );
        }

        const previousStatus = application.status;

        if (previousStatus !== expectedStatus) {
            return failure(
                context,
                "Application status has changed",
                409,
                {
                    applicationId,
                    expectedStatus,
                    currentStatus: previousStatus,
                    refreshRequired: true
                }
            );
        }

        if (
            expectedUpdatedAt &&
            expectedUpdatedAt !== application.updated_at
        ) {
            return failure(
                context,
                "Application has been modified",
                409,
                {
                    applicationId,
                    currentStatus: previousStatus,
                    currentUpdatedAt: application.updated_at,
                    refreshRequired: true
                }
            );
        }

        if (previousStatus === newStatus) {
            return success(context, {
                changed: false,

                message:
                    "Application already has this status",

                applicationId,

                status: previousStatus,

                audit: {
                    recorded: false,
                    reason: "No status change"
                }
            });
        }

        const allowedTransitions =
            STATUS_TRANSITIONS[previousStatus] || [];

        if (!allowedTransitions.includes(newStatus)) {
            return failure(
                context,
                "Invalid status transition",
                409,
                {
                    applicationId,
                    previousStatus,
                    requestedStatus: newStatus,
                    allowedTransitions
                }
            );
        }

        const reopening = COMPLETED_STATUSES.includes(
            previousStatus
        );

        if (reopening && !notes) {
            return failure(
                context,
                "A reason is required to reopen an application",
                400
            );
        }

        const timestamp = nextTimestamp(
            application.updated_at
        );

        const auditAction = reopening
            ? "application.reopened"
            : "application.status_changed";

        const updateStatement = env.DB.prepare(`
            UPDATE applications
            SET
                status = ?,
                reviewer = ?,
                updated_at = ?
            WHERE application_id = ?
            AND status = ?
            AND updated_at = ?
        `).bind(
            newStatus,
            administrator.email,
            timestamp,
            applicationId,
            previousStatus,
            application.updated_at
        );

        const historyStatement = env.DB.prepare(`
            INSERT INTO application_history (
                application_id,
                previous_status,
                new_status,
                changed_by,
                notes,
                created_at
            )
            SELECT
                ?,
                ?,
                ?,
                ?,
                ?,
                ?
            WHERE changes() = 1
        `).bind(
            applicationId,
            previousStatus,
            newStatus,
            administrator.email,
            notes || null,
            timestamp
        );

        const auditStatement = prepareAudit(
            context,
            {
                action: auditAction,

                targetType: "application",

                targetId: applicationId,

                timestamp,

                details: {
                    previousStatus,
                    newStatus,
                    previousReviewer:
                        application.reviewer || null,
                    newReviewer:
                        administrator.email,
                    reopened: reopening,
                    hasDecisionNotes:
                        notes.length > 0
                }
            },
            {
                onlyIfChanged: true
            }
        );

        const results = await env.DB.batch([
            updateStatement,
            historyStatement,
            auditStatement
        ]);

        const updatedRows = Number(
            results[0]?.meta?.changes || 0
        );

        const historyRows = Number(
            results[1]?.meta?.changes || 0
        );

        const auditRows = Number(
            results[2]?.meta?.changes || 0
        );

        if (updatedRows === 0) {
            return failure(
                context,
                "Application was modified by another request",
                409,
                {
                    applicationId,
                    refreshRequired: true
                }
            );
        }

        if (
            updatedRows !== 1 ||
            historyRows !== 1 ||
            auditRows !== 1
        ) {
            console.error(
                "[Admin Status] Batch verification failed",
                data.requestId,
                {
                    applicationId,
                    updatedRows,
                    historyRows,
                    auditRows
                }
            );

            return failure(
                context,
                "Status update could not be fully verified",
                500,
                {
                    refreshRequired: true
                }
            );
        }

        return success(context, {
            changed: true,

            message:
                "Application status updated successfully",

            application: {
                applicationId,

                displayName:
                    application.display_name,

                previousStatus,

                status: newStatus,

                reviewer:
                    administrator.email,

                updatedAt: timestamp
            },

            history: {
                recorded: true,

                id:
                    results[1]?.meta?.last_row_id || null,

                previousStatus,

                newStatus,

                changedBy:
                    administrator.email,

                notes: notes || null,

                createdAt: timestamp
            },

            audit: {
                recorded: true,

                id:
                    results[2]?.meta?.last_row_id || null,

                action: auditAction,

                actor:
                    administrator.email,

                targetType: "application",

                targetId: applicationId,

                createdAt: timestamp
            },

            allowedTransitions:
                STATUS_TRANSITIONS[newStatus] || []
        });

    } catch (error) {
        console.error(
            "[Admin Status]",
            data.requestId,
            error.message
        );

        return failure(
            context,
            "Unable to update application status",
            500
        );
    }
}
