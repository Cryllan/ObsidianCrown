const VERSION = "1.0.0";

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

export async function onRequestGet(context) {
    const {
        request,
        env,
        data
    } = context;

    const administrator = data.admin;
    const requestId = data.requestId;

    if (!administrator) {
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

    try {
        const url = new URL(request.url);

        const applicationId = String(
            url.searchParams.get("id") || ""
        ).trim();

        if (!applicationId) {
            return jsonResponse({
                success: false,
                error: "Application ID is required",
                requestId
            }, 400);
        }

        if (
            applicationId.length > 128 ||
            !/^[a-zA-Z0-9_-]+$/.test(applicationId)
        ) {
            return jsonResponse({
                success: false,
                error: "Invalid application ID",
                requestId
            }, 400);
        }

        const [
            applicationResult,
            historyResult
        ] = await env.DB.batch([

            env.DB.prepare(`
                SELECT
                    application_id,
                    display_name,
                    roblox_username,
                    discord_username,
                    discipline,
                    experience,
                    portfolio_url,
                    introduction,
                    status,
                    reviewer,
                    reviewer_notes,
                    privacy_version,
                    created_at,
                    updated_at
                FROM applications
                WHERE application_id = ?
                LIMIT 1
            `).bind(applicationId),

            env.DB.prepare(`
                SELECT
                    id,
                    previous_status,
                    new_status,
                    changed_by,
                    notes,
                    created_at
                FROM application_history
                WHERE application_id = ?
                ORDER BY created_at DESC, id DESC
                LIMIT 200
            `).bind(applicationId)

        ]);

        const application =
            applicationResult.results?.[0];

        if (!application) {
            return jsonResponse({
                success: false,
                error: "Application not found",
                applicationId,
                requestId
            }, 404);
        }

        const history = (
            historyResult.results || []
        ).map(row => ({
            id: row.id,
            previousStatus:
                row.previous_status || null,
            newStatus: row.new_status,
            changedBy: row.changed_by,
            notes: row.notes || null,
            createdAt: row.created_at
        }));

        return jsonResponse({
            success: true,

            service:
                "Obsidian Crown Administration",

            version: VERSION,

            administrator: {
                email: administrator.email,
                role: "Administrator"
            },

            application: {
                applicationId:
                    application.application_id,

                displayName:
                    application.display_name,

                robloxUsername:
                    application.roblox_username,

                discordUsername:
                    application.discord_username || null,

                discipline:
                    application.discipline,

                experience:
                    application.experience,

                portfolioUrl:
                    application.portfolio_url,

                introduction:
                    application.introduction,

                status:
                    application.status,

                reviewer:
                    application.reviewer || null,

                reviewerNotes:
                    application.reviewer_notes || null,

                privacyVersion:
                    application.privacy_version,

                createdAt:
                    application.created_at,

                updatedAt:
                    application.updated_at
            },

            history,

            metadata: {
                historyEntries: history.length,
                historyLimit: 200,

                isActive: [
                    "pending",
                    "under_review",
                    "shortlisted",
                    "interview"
                ].includes(application.status),

                isCompleted: [
                    "accepted",
                    "declined",
                    "withdrawn"
                ].includes(application.status)
            },

            generatedAt:
                new Date().toISOString(),

            requestId
        });

    } catch (error) {
        console.error(
            "[Admin Application]",
            requestId,
            error.message
        );

        return jsonResponse({
            success: false,
            error: "Unable to retrieve application",
            requestId
        }, 500);
    }
}
