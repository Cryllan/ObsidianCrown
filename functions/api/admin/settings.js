import { prepareAudit } from "../../_shared/audit.js";

const VERSION = "1.1.0";

const SETTINGS = {
    applications_open: {
        type: "boolean",
        default: false,
        environment: "APPLICATIONS_OPEN"
    },

    recruitment_message: {
        type: "string",
        default: "Recruitment is currently closed.",
        maxLength: 1000
    },

    recruitment_title: {
        type: "string",
        default: "Careers at Obsidian Crown",
        maxLength: 150
    },

    privacy_version: {
        type: "string",
        default: "1.0",
        maxLength: 30,
        writable: false
    }
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

function parseBoolean(value) {
    return ["true", "1", "yes", "on"].includes(
        String(value || "").trim().toLowerCase()
    );
}

function getDefaultValue(key, env) {
    const definition = SETTINGS[key];

    if (
        definition.environment &&
        env[definition.environment] !== undefined
    ) {
        const value = env[definition.environment];

        if (definition.type === "boolean") {
            return parseBoolean(value);
        }

        return String(value);
    }

    return definition.default;
}

function deserializeValue(key, value) {
    const definition = SETTINGS[key];

    if (definition.type === "boolean") {
        return parseBoolean(value);
    }

    return String(value);
}

function serializeValue(value) {
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }

    return String(value);
}

function validateValue(key, value) {
    if (
        !Object.prototype.hasOwnProperty.call(
            SETTINGS,
            key
        )
    ) {
        return {
            valid: false,
            error: "Unknown recruitment setting"
        };
    }

    const definition = SETTINGS[key];

    if (definition.writable === false) {
        return {
            valid: false,
            error: "This setting cannot be modified"
        };
    }

    if (definition.type === "boolean") {
        if (typeof value !== "boolean") {
            return {
                valid: false,
                error: "Setting must be a boolean"
            };
        }

        return {
            valid: true,
            value
        };
    }

    if (definition.type === "string") {
        if (typeof value !== "string") {
            return {
                valid: false,
                error: "Setting must be a string"
            };
        }

        const normalized = value.trim();

        if (!normalized) {
            return {
                valid: false,
                error: "Setting cannot be empty"
            };
        }

        if (
            definition.maxLength &&
            normalized.length > definition.maxLength
        ) {
            return {
                valid: false,
                error: "Setting exceeds maximum length",
                maxLength: definition.maxLength
            };
        }

        return {
            valid: true,
            value: normalized
        };
    }

    return {
        valid: false,
        error: "Unsupported setting type"
    };
}

async function loadSettings(env) {
    const result = await env.DB.prepare(`
        SELECT
            key,
            value,
            updated_by,
            updated_at
        FROM recruitment_settings
    `).all();

    const rows = new Map(
        (result.results || []).map(
            row => [row.key, row]
        )
    );

    const settings = {};
    const metadata = {};

    for (const key of Object.keys(SETTINGS)) {
        const row = rows.get(key);

        if (row) {
            settings[key] = deserializeValue(
                key,
                row.value
            );

            metadata[key] = {
                source: "database",
                updatedBy: row.updated_by || null,
                updatedAt: row.updated_at || null
            };

        } else {
            settings[key] = getDefaultValue(
                key,
                env
            );

            metadata[key] = {
                source:
                    SETTINGS[key].environment &&
                    env[SETTINGS[key].environment] !== undefined
                        ? "environment"
                        : "default",

                updatedBy: null,
                updatedAt: null
            };
        }
    }

    return {
        settings,
        metadata,
        rows
    };
}

function formatRecruitment(settings) {
    return {
        open: settings.applications_open,

        status: settings.applications_open
            ? "open"
            : "closed",

        title: settings.recruitment_title,

        message: settings.recruitment_message,

        privacyVersion: settings.privacy_version
    };
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
        const raw = await context.request.text();

        if (raw.length > 16000) {
            return {
                error: failure(
                    context,
                    "Request body is too large",
                    413
                )
            };
        }

        const body = JSON.parse(raw);

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

function handleError(context, error) {
    console.error(
        "[Admin Settings]",
        context.data.requestId,
        error.message
    );

    return failure(
        context,
        "Unable to process recruitment settings",
        500
    );
}

function getCapabilities() {
    return {
        persistentSettings: true,
        recruitmentAvailability: true,
        publicMessaging: true,
        openingConfirmation: true,
        auditLogging: true,
        changeDetection: true,
        transactionalWrites: true,
        concurrencyProtection: true
    };
}

export async function onRequestGet(context) {
    const denied = authorize(context);

    if (denied) {
        return denied;
    }

    try {
        const {
            settings,
            metadata
        } = await loadSettings(context.env);

        return success(context, {
            administrator: {
                email: context.data.admin.email,
                role: "Administrator"
            },

            endpoint: "Recruitment Settings",

            recruitment: formatRecruitment(settings),

            settings,

            metadata,

            capabilities: getCapabilities(),

            availableSettings: Object.entries(
                SETTINGS
            ).map(([key, definition]) => ({
                key,
                type: definition.type,
                writable: definition.writable !== false,
                maxLength: definition.maxLength || null
            })),

            generatedAt: new Date().toISOString()
        });

    } catch (error) {
        return handleError(context, error);
    }
}

export async function onRequestPatch(context) {
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

    if (
        !body.settings ||
        typeof body.settings !== "object" ||
        Array.isArray(body.settings)
    ) {
        return failure(
            context,
            "A settings object is required",
            400
        );
    }

    const entries = Object.entries(body.settings);

    if (!entries.length) {
        return failure(
            context,
            "No settings were provided",
            400
        );
    }

    if (entries.length > Object.keys(SETTINGS).length) {
        return failure(
            context,
            "Too many settings provided",
            400
        );
    }

    const validated = [];

    for (const [key, value] of entries) {
        const validation = validateValue(
            key,
            value
        );

        if (!validation.valid) {
            return failure(
                context,
                validation.error,
                400,
                {
                    key,
                    maxLength:
                        validation.maxLength || null
                }
            );
        }

        validated.push({
            key,
            value: validation.value
        });
    }

    if (
        validated.some(
            setting =>
                setting.key === "applications_open" &&
                setting.value === true
        ) &&
        body.confirmOpen !== true
    ) {
        return failure(
            context,
            "Opening recruitment requires confirmation",
            400,
            { confirmationRequired: true }
        );
    }

    try {
        const current = await loadSettings(env);

        const changes = validated
            .filter(setting =>
                current.settings[setting.key] !== setting.value ||
                !current.rows.has(setting.key)
            )
            .map(setting => ({
                key: setting.key,
                previousValue: current.settings[setting.key],
                newValue: setting.value,
                existing: current.rows.get(setting.key) || null
            }));

        if (!changes.length) {
            return success(context, {
                changed: false,

                message: "Recruitment settings are unchanged",

                recruitment: formatRecruitment(
                    current.settings
                ),

                settings: current.settings,

                metadata: current.metadata,

                audit: {
                    recorded: false,
                    reason: "No settings changed"
                }
            });
        }

        const timestamp = new Date().toISOString();

        const statements = [];
        const operations = [];

        for (const change of changes) {
            let updateStatement;

            if (change.existing) {
                updateStatement = env.DB.prepare(`
                    UPDATE recruitment_settings
                    SET
                        value = ?,
                        updated_by = ?,
                        updated_at = ?
                    WHERE key = ?
                    AND value IS ?
                    AND updated_at IS ?
                `).bind(
                    serializeValue(change.newValue),
                    data.admin.email,
                    timestamp,
                    change.key,
                    change.existing.value,
                    change.existing.updated_at
                );

            } else {
                updateStatement = env.DB.prepare(`
                    INSERT INTO recruitment_settings (
                        key,
                        value,
                        updated_by,
                        updated_at
                    )
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO NOTHING
                `).bind(
                    change.key,
                    serializeValue(change.newValue),
                    data.admin.email,
                    timestamp
                );
            }

            let action = "settings.updated";
            let targetType = "settings";
            let targetId = change.key;

            if (
                change.key === "applications_open" &&
                change.previousValue !== change.newValue
            ) {
                action = change.newValue
                    ? "recruitment.opened"
                    : "recruitment.closed";

                targetType = "recruitment";
                targetId = "applications";
            }

            const auditStatement = prepareAudit(
                context,
                {
                    action,
                    targetType,
                    targetId,
                    timestamp,

                    details: {
                        key: change.key,
                        previousValue: change.previousValue,
                        newValue: change.newValue,
                        initialized: !change.existing
                    }
                },
                {
                    onlyIfChanged: true
                }
            );

            operations.push({
                key: change.key,
                previousValue: change.previousValue,
                newValue: change.newValue,
                action,
                mutationIndex: statements.length,
                auditIndex: statements.length + 1
            });

            statements.push(
                updateStatement,
                auditStatement
            );
        }

        const results = await env.DB.batch(statements);

        const updated = [];
        const conflicts = [];
        const auditRecords = [];

        for (const operation of operations) {
            const mutationResult =
                results[operation.mutationIndex];

            const auditResult =
                results[operation.auditIndex];

            const mutationRows = Number(
                mutationResult?.meta?.changes || 0
            );

            const auditRows = Number(
                auditResult?.meta?.changes || 0
            );

            if (mutationRows === 0 && auditRows === 0) {
                conflicts.push(operation.key);
                continue;
            }

            if (mutationRows !== 1 || auditRows !== 1) {
                console.error(
                    "[Admin Settings] Batch verification failed",
                    data.requestId,
                    {
                        key: operation.key,
                        mutationRows,
                        auditRows
                    }
                );

                return failure(
                    context,
                    "Settings update could not be fully verified",
                    500,
                    { refreshRequired: true }
                );
            }

            updated.push({
                key: operation.key,
                previousValue: operation.previousValue,
                value: operation.newValue
            });

            auditRecords.push({
                id: auditResult.meta?.last_row_id || null,
                action: operation.action,
                key: operation.key
            });
        }

        const latest = await loadSettings(env);

        if (conflicts.length) {
            return failure(
                context,
                "One or more settings changed during the request",
                409,
                {
                    conflicts,
                    updated,
                    partialUpdate: updated.length > 0,
                    recruitment: formatRecruitment(
                        latest.settings
                    ),
                    settings: latest.settings,
                    metadata: latest.metadata,
                    audit: {
                        recorded: auditRecords.length > 0,
                        total: auditRecords.length,
                        records: auditRecords
                    },
                    refreshRequired: true
                }
            );
        }

        return success(context, {
            changed: updated.length > 0,

            message: "Recruitment settings saved successfully",

            updated,

            recruitment: formatRecruitment(
                latest.settings
            ),

            settings: latest.settings,

            metadata: latest.metadata,

            audit: {
                recorded: auditRecords.length > 0,
                total: auditRecords.length,
                records: auditRecords
            },

            updatedBy: data.admin.email,

            updatedAt: timestamp
        });

    } catch (error) {
        return handleError(context, error);
    }
}
