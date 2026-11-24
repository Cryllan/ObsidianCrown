const VALID_ACTIONS = new Set([
    "application.status_changed",
    "application.reopened",
    "note.created",
    "note.updated",
    "note.deleted",
    "settings.updated",
    "recruitment.opened",
    "recruitment.closed"
]);

const VALID_TARGET_TYPES = new Set([
    "application",
    "note",
    "settings",
    "recruitment"
]);

function requiredString(value, name, maxLength) {
    if (typeof value !== "string") {
        throw new Error(`${name} must be a string`);
    }

    const normalized = value.trim();

    if (
        !normalized ||
        normalized.length > maxLength
    ) {
        throw new Error(`Invalid ${name}`);
    }

    return normalized;
}

function serializeDetails(details) {
    if (details === undefined || details === null) {
        return null;
    }

    if (
        typeof details !== "object" ||
        Array.isArray(details)
    ) {
        throw new Error("Invalid audit details");
    }

    const serialized = JSON.stringify(details);

    if (serialized.length > 16000) {
        throw new Error("Audit details exceed maximum length");
    }

    return serialized;
}

export function prepareAudit(
    context,
    event,
    options = {}
) {
    const { env, data } = context;

    if (!env.DB) {
        throw new Error("Audit database unavailable");
    }

    if (!data.admin?.email) {
        throw new Error("Authenticated administrator required");
    }

    const actor = requiredString(
        data.admin.email,
        "actor",
        254
    );

    const action = requiredString(
        event.action,
        "action",
        100
    );

    if (!VALID_ACTIONS.has(action)) {
        throw new Error("Unsupported audit action");
    }

    const targetType = requiredString(
        event.targetType,
        "target type",
        100
    );

    if (!VALID_TARGET_TYPES.has(targetType)) {
        throw new Error("Unsupported audit target");
    }

    const targetId =
        event.targetId === undefined ||
        event.targetId === null
            ? null
            : requiredString(
                String(event.targetId),
                "target ID",
                128
            );

    const details = serializeDetails({
        ...(event.details || {}),
        requestId: data.requestId || null
    });

    const timestamp =
        event.timestamp ||
        new Date().toISOString();

    const conditional = options.onlyIfChanged === true
        ? "WHERE changes() = 1"
        : "";

    return env.DB.prepare(`
        INSERT INTO admin_activity (
            actor,
            action,
            target_type,
            target_id,
            details,
            created_at
        )
        SELECT
            ?,
            ?,
            ?,
            ?,
            ?,
            ?
        ${conditional}
    `).bind(
        actor,
        action,
        targetType,
        targetId,
        details,
        timestamp
    );
}

export async function recordAudit(context, event) {
    const result = await prepareAudit(
        context,
        event
    ).run();

    if (Number(result.meta?.changes || 0) !== 1) {
        throw new Error("Audit record could not be created");
    }

    return {
        recorded: true,
        id: result.meta?.last_row_id || null
    };
}
