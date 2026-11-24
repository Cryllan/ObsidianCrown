const VERSION = "1.0.0";
const MAX_NOTE_LENGTH = 5000;
const MAX_BODY_LENGTH = 32000;
const MAX_NOTES_PER_PAGE = 100;

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

function success(context, payload = {}, status = 200) {
    return jsonResponse({
        success: true,
        service: "Obsidian Crown Administration",
        version: VERSION,
        ...payload,
        requestId: context.data.requestId
    }, status);
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

function validNoteId(value) {
    return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value > 0
    );
}

function boundedInteger(value, fallback, min, max) {
    if (value === null || value === "") {
        return fallback;
    }

    const number = Number(value);

    if (!Number.isSafeInteger(number)) {
        return fallback;
    }

    return Math.min(
        Math.max(number, min),
        max
    );
}

function formatNote(row) {
    return {
        id: row.id,
        applicationId: row.application_id,
        author: row.author,
        note: row.note,
        createdAt: row.created_at,
        updatedAt: row.updated_at
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

        if (raw.length > MAX_BODY_LENGTH) {
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

async function findApplication(db, applicationId) {
    return await db.prepare(`
        SELECT
            application_id,
            display_name,
            status
        FROM applications
        WHERE application_id = ?
        LIMIT 1
    `).bind(applicationId).first();
}

async function findNote(db, applicationId, noteId) {
    return await db.prepare(`
        SELECT
            id,
            application_id,
            author,
            note,
            created_at,
            updated_at
        FROM application_notes
        WHERE application_id = ?
        AND id = ?
        LIMIT 1
    `).bind(
        applicationId,
        noteId
    ).first();
}

function handleError(context, error) {
    console.error(
        "[Admin Notes]",
        context.data.requestId,
        error.message
    );

    return failure(
        context,
        "Unable to process administrator notes",
        500
    );
}

export async function onRequestGet(context) {
    const denied = authorize(context);

    if (denied) {
        return denied;
    }

    const { request, env } = context;

    try {
        const url = new URL(request.url);

        const applicationId = String(
            url.searchParams.get("id") || ""
        ).trim();

        if (!applicationId) {
            return success(context, {
                endpoint: "Private Administrator Notes",

                methods: {
                    GET: "Retrieve applicant notes",
                    POST: "Create a private note",
                    PATCH: "Edit an existing note",
                    DELETE: "Delete an existing note"
                },

                limits: {
                    maxNoteLength: MAX_NOTE_LENGTH,
                    maxNotesPerPage: MAX_NOTES_PER_PAGE
                },

                visibility: "Administrators only"
            });
        }

        if (!validApplicationId(applicationId)) {
            return failure(
                context,
                "Invalid application ID",
                400
            );
        }

        const application = await findApplication(
            env.DB,
            applicationId
        );

        if (!application) {
            return failure(
                context,
                "Application not found",
                404,
                { applicationId }
            );
        }

        const requestedPage = boundedInteger(
            url.searchParams.get("page"),
            1,
            1,
            1000000
        );

        const limit = boundedInteger(
            url.searchParams.get("limit"),
            25,
            1,
            MAX_NOTES_PER_PAGE
        );

        const count = await env.DB.prepare(`
            SELECT COUNT(*) AS total
            FROM application_notes
            WHERE application_id = ?
        `).bind(applicationId).first();

        const total = Number(count?.total || 0);

        const totalPages = Math.max(
            1,
            Math.ceil(total / limit)
        );

        const page = Math.min(
            requestedPage,
            totalPages
        );

        const offset = (page - 1) * limit;

        const result = await env.DB.prepare(`
            SELECT
                id,
                application_id,
                author,
                note,
                created_at,
                updated_at
            FROM application_notes
            WHERE application_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            OFFSET ?
        `).bind(
            applicationId,
            limit,
            offset
        ).all();

        const notes = (
            result.results || []
        ).map(formatNote);

        return success(context, {
            application: {
                applicationId,
                displayName: application.display_name,
                status: application.status
            },

            notes,

            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNextPage: page < totalPages,
                hasPreviousPage: page > 1
            },

            generatedAt: new Date().toISOString()
        });

    } catch (error) {
        return handleError(context, error);
    }
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

    const applicationId =
        typeof body.applicationId === "string"
            ? body.applicationId.trim()
            : "";

    const note =
        typeof body.note === "string"
            ? body.note.trim()
            : "";

    if (!validApplicationId(applicationId)) {
        return failure(
            context,
            "Invalid application ID",
            400
        );
    }

    if (!note) {
        return failure(
            context,
            "Note content is required",
            400
        );
    }

    if (note.length > MAX_NOTE_LENGTH) {
        return failure(
            context,
            "Note exceeds maximum length",
            400,
            { maxLength: MAX_NOTE_LENGTH }
        );
    }

    try {
        const timestamp = new Date().toISOString();

        const createdNote = await env.DB.prepare(`
            INSERT INTO application_notes (
                application_id,
                author,
                note,
                created_at,
                updated_at
            )
            SELECT
                application_id,
                ?,
                ?,
                ?,
                ?
            FROM applications
            WHERE application_id = ?
            RETURNING
                id,
                application_id,
                author,
                note,
                created_at,
                updated_at
        `).bind(
            data.admin.email,
            note,
            timestamp,
            timestamp,
            applicationId
        ).first();

        if (!createdNote) {
            return failure(
                context,
                "Application not found",
                404,
                { applicationId }
            );
        }

        return success(context, {
            message: "Private note created successfully",
            note: formatNote(createdNote)
        }, 201);

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

    const applicationId =
        typeof body.applicationId === "string"
            ? body.applicationId.trim()
            : "";

    const noteId = body.noteId;

    const note =
        typeof body.note === "string"
            ? body.note.trim()
            : "";

    const expectedUpdatedAt =
        typeof body.expectedUpdatedAt === "string"
            ? body.expectedUpdatedAt.trim()
            : "";

    if (!validApplicationId(applicationId)) {
        return failure(
            context,
            "Invalid application ID",
            400
        );
    }

    if (!validNoteId(noteId)) {
        return failure(
            context,
            "Invalid note ID",
            400
        );
    }

    if (!note) {
        return failure(
            context,
            "Note content is required",
            400
        );
    }

    if (note.length > MAX_NOTE_LENGTH) {
        return failure(
            context,
            "Note exceeds maximum length",
            400,
            { maxLength: MAX_NOTE_LENGTH }
        );
    }

    if (!expectedUpdatedAt) {
        return failure(
            context,
            "expectedUpdatedAt is required",
            400
        );
    }

    try {
        const existing = await findNote(
            env.DB,
            applicationId,
            noteId
        );

        if (!existing) {
            return failure(
                context,
                "Note not found",
                404
            );
        }

        if (
            existing.author.toLowerCase() !==
            data.admin.email.toLowerCase()
        ) {
            return failure(
                context,
                "Only the original author may edit this note",
                403
            );
        }

        if (existing.updated_at !== expectedUpdatedAt) {
            return failure(
                context,
                "Note has been modified",
                409,
                { refreshRequired: true }
            );
        }

        if (existing.note === note) {
            return success(context, {
                changed: false,
                message: "Note content is unchanged",
                note: formatNote(existing)
            });
        }

        const timestamp = new Date(
            Math.max(
                Date.now(),
                (Date.parse(existing.updated_at) || 0) + 1
            )
        ).toISOString();

        const updatedNote = await env.DB.prepare(`
            UPDATE application_notes
            SET
                note = ?,
                updated_at = ?
            WHERE id = ?
            AND application_id = ?
            AND author COLLATE NOCASE = ?
            AND updated_at = ?
            RETURNING
                id,
                application_id,
                author,
                note,
                created_at,
                updated_at
        `).bind(
            note,
            timestamp,
            noteId,
            applicationId,
            data.admin.email,
            expectedUpdatedAt
        ).first();

        if (!updatedNote) {
            return failure(
                context,
                "Note was modified by another request",
                409,
                { refreshRequired: true }
            );
        }

        return success(context, {
            changed: true,
            message: "Private note updated successfully",
            note: formatNote(updatedNote)
        });

    } catch (error) {
        return handleError(context, error);
    }
}

export async function onRequestDelete(context) {
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

    const applicationId =
        typeof body.applicationId === "string"
            ? body.applicationId.trim()
            : "";

    const noteId = body.noteId;

    const expectedUpdatedAt =
        typeof body.expectedUpdatedAt === "string"
            ? body.expectedUpdatedAt.trim()
            : "";

    if (!validApplicationId(applicationId)) {
        return failure(
            context,
            "Invalid application ID",
            400
        );
    }

    if (!validNoteId(noteId)) {
        return failure(
            context,
            "Invalid note ID",
            400
        );
    }

    if (!expectedUpdatedAt) {
        return failure(
            context,
            "expectedUpdatedAt is required",
            400
        );
    }

    try {
        const existing = await findNote(
            env.DB,
            applicationId,
            noteId
        );

        if (!existing) {
            return failure(
                context,
                "Note not found",
                404
            );
        }

        if (
            existing.author.toLowerCase() !==
            data.admin.email.toLowerCase()
        ) {
            return failure(
                context,
                "Only the original author may delete this note",
                403
            );
        }

        if (existing.updated_at !== expectedUpdatedAt) {
            return failure(
                context,
                "Note has been modified",
                409,
                { refreshRequired: true }
            );
        }

        const result = await env.DB.prepare(`
            DELETE FROM application_notes
            WHERE id = ?
            AND application_id = ?
            AND author COLLATE NOCASE = ?
            AND updated_at = ?
        `).bind(
            noteId,
            applicationId,
            data.admin.email,
            expectedUpdatedAt
        ).run();

        if (Number(result.meta?.changes || 0) !== 1) {
            return failure(
                context,
                "Note was modified by another request",
                409,
                { refreshRequired: true }
            );
        }

        return success(context, {
            deleted: true,
            message: "Private note deleted successfully",
            applicationId,
            noteId
        });

    } catch (error) {
        return handleError(context, error);
    }
}
