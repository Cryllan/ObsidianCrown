const VERSION = "1.0.0";

const VALID_STATUSES = [
    "pending",
    "under_review",
    "shortlisted",
    "interview",
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

function validApplicationId(value) {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 128 &&
        /^[a-zA-Z0-9_-]+$/.test(value)
    );
}

export async function onRequestGet(context) {
    const { data } = context;

    if (!data.admin) {
        return jsonResponse({
            success: false,
            error: "Authentication required",
            requestId: data.requestId
        }, 401);
    }

    return jsonResponse({
        success: true,

        service: "Obsidian Crown Administration",

        version: VERSION,

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
            "notes"
        ],

        requestId: data.requestId
    });
}

export async function onRequestPost(context) {
    const {
        request,
        env,
        data
    } = context;

    const administrator = data.admin;
    const requestId = data.requestId;

    if (!administrator?.email) {
        return jsonResponse({
            success: false,
            error: "Authentication required",
            requestId
        }, 401);
    }

    if (!env.DB) {
        return jsonResponse({
            success: false,
            error: "Database unavailable",
            requestId
        }, 503);
    }

    const contentType = (
        request.headers.get("Content-Type") || ""
    ).split(";")[0].trim().toLowerCase();

    if (contentType !== "application/json") {
        return jsonResponse({
            success: false,
            error: "Content-Type must be application/json",
            requestId
        }, 415);
    }

    let body;

    try {
        const rawBody = await request.text();

        if (rawBody.length > 16000) {
            return jsonResponse({
                success: false,
                error: "Request body is too large",
                requestId
            }, 413);
        }

        body = JSON.parse(rawBody);

        if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body)
        ) {
            throw new Error("Invalid body");
        }

    } catch {
        return jsonResponse({
            success: false,
            error: "Invalid JSON request body",
            requestId
        }, 400);
    }

    const applicationId =
        typeof body.applicationId === "string"
            ? body.applicationId.trim()
            : "";

    const newStatus =
        typeof body.status === "string"
            ? body.status.trim().toLowerCase()
            : "";

    const expectedStatus =
        typeof body.expectedStatus === "string"
            ? body.expectedStatus.trim().toLowerCase()
            : "";

    if (
        body.notes !== undefined &&
        body.notes !== null &&
        typeof body.notes !== "string"
    ) {
        return jsonResponse({
            success: false,
            error: "Notes must be a string",
            requestId
        }, 400);
    }

    const notes =
        typeof body.notes === "string"
            ? body.notes.trim()
            : "";

    if (!validApplicationId(applicationId)) {
        return jsonResponse({
            success: false,
            error: "Invalid application ID",
            requestId
        }, 400);
    }

    if (!VALID_STATUSES.includes(newStatus)) {
        return jsonResponse({
            success: false,
            error: "Invalid application status",
            validStatuses: VALID_STATUSES,
            requestId
        }, 400);
    }

    if (!VALID_STATUSES.includes(expectedStatus)) {
        return jsonResponse({
            success: false,
            error: "A valid expectedStatus is required",
            validStatuses: VALID_STATUSES,
            requestId
        }, 400);
    }

    if (notes.length > 3000) {
        return jsonResponse({
            success: false,
            error: "Decision notes cannot exceed 3000 characters",
            requestId
        }, 400);
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
            return jsonResponse({
                success: false,
                error: "Application not found",
                applicationId,
                requestId
            }, 404);
        }

        const previousStatus = application.status;

        if (previousStatus !== expectedStatus) {
            return jsonResponse({
                success: false,
                error: "Application status has changed",
                applicationId,
                expectedStatus,
                currentStatus: previousStatus,
                refreshRequired: true,
                requestId
            }, 409);
        }

        if (previousStatus === newStatus) {
            return jsonResponse({
                success: true,
                changed: false,
                message: "Application already has this status",
                applicationId,
                status: previousStatus,
                requestId
            });
        }

        const allowedTransitions =
            STATUS_TRANSITIONS[previousStatus] || [];

        if (!allowedTransitions.includes(newStatus)) {
            return jsonResponse({
                success: false,
                error: "Invalid status transition",
                applicationId,
                previousStatus,
                requestedStatus: newStatus,
                allowedTransitions,
                requestId
            }, 409);
        }

        const reopening = [
            "accepted",
            "declined",
            "withdrawn"
        ].includes(previousStatus);

        if (reopening && !notes) {
            return jsonResponse({
                success: false,
                error: "A reason is required to reopen an application",
                requestId
            }, 400);
        }

        const timestamp = new Date().toISOString();

        const results = await env.DB.batch([

            env.DB.prepare(`
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
            ),

            env.DB.prepare(`
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
            )

        ]);

        const updatedRows = Number(
            results[0]?.meta?.changes || 0
        );

        const historyRows = Number(
            results[1]?.meta?.changes || 0
        );

        if (updatedRows !== 1) {
            return jsonResponse({
                success: false,
                error: "Application was modified by another request",
                applicationId,
                refreshRequired: true,
                requestId
            }, 409);
        }

        if (historyRows !== 1) {
            console.error(
                "[Admin Status] History verification failed",
                requestId,
                applicationId
            );

            return jsonResponse({
                success: false,
                error: "Status update could not be fully verified",
                refreshRequired: true,
                requestId
            }, 500);
        }

        return jsonResponse({
            success: true,

            service: "Obsidian Crown Administration",

            version: VERSION,

            changed: true,

            message: "Application status updated successfully",

            application: {
                applicationId,
                displayName: application.display_name,
                previousStatus,
                status: newStatus,
                reviewer: administrator.email,
                updatedAt: timestamp
            },

            history: {
                recorded: true,
                previousStatus,
                newStatus,
                changedBy: administrator.email,
                notes: notes || null,
                createdAt: timestamp
            },

            allowedTransitions:
                STATUS_TRANSITIONS[newStatus] || [],

            requestId
        });

    } catch (error) {
        console.error(
            "[Admin Status]",
            requestId,
            error.message
        );

        return jsonResponse({
            success: false,
            error: "Unable to update application status",
            requestId
        }, 500);
    }
}
