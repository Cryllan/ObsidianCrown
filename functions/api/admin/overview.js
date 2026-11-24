const VERSION = "1.0.0";

const APPLICATION_STATUSES = [
    "pending",
    "under_review",
    "shortlisted",
    "interview",
    "accepted",
    "declined",
    "withdrawn"
];

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

function toNumber(value) {
    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : 0;
}

function percentage(value, total) {
    if (total <= 0) {
        return 0;
    }

    return Math.round(
        (value / total) * 10000
    ) / 100;
}

function isEnabled(value) {
    return ["true", "1", "yes", "on"].includes(
        String(value || "").trim().toLowerCase()
    );
}

export async function onRequestGet(context) {
    const {
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
        const [
            totalsResult,
            statusesResult,
            disciplinesResult,
            recentResult,
            trendsResult
        ] = await env.DB.batch([

            env.DB.prepare(`
                SELECT
                    COUNT(*) AS total,
                    COALESCE(SUM(
                        CASE
                            WHEN datetime(created_at) >=
                                datetime('now', '-24 hours')
                            THEN 1
                            ELSE 0
                        END
                    ), 0) AS last_24_hours,
                    COALESCE(SUM(
                        CASE
                            WHEN datetime(created_at) >=
                                datetime('now', '-7 days')
                            THEN 1
                            ELSE 0
                        END
                    ), 0) AS last_7_days,
                    COALESCE(SUM(
                        CASE
                            WHEN datetime(created_at) >=
                                datetime('now', '-30 days')
                            THEN 1
                            ELSE 0
                        END
                    ), 0) AS last_30_days
                FROM applications
            `),

            env.DB.prepare(`
                SELECT
                    status,
                    COUNT(*) AS total
                FROM applications
                GROUP BY status
            `),

            env.DB.prepare(`
                SELECT
                    discipline,
                    COUNT(*) AS total
                FROM applications
                GROUP BY discipline
                ORDER BY total DESC, discipline ASC
            `),

            env.DB.prepare(`
                SELECT
                    application_id,
                    display_name,
                    roblox_username,
                    discipline,
                    status,
                    created_at,
                    updated_at
                FROM applications
                ORDER BY created_at DESC, id DESC
                LIMIT 10
            `),

            env.DB.prepare(`
                WITH RECURSIVE days(day) AS (
                    SELECT date('now', '-13 days')

                    UNION ALL

                    SELECT date(day, '+1 day')
                    FROM days
                    WHERE day < date('now')
                )

                SELECT
                    days.day AS date,
                    COUNT(applications.id) AS total
                FROM days
                LEFT JOIN applications
                    ON date(applications.created_at) = days.day
                GROUP BY days.day
                ORDER BY days.day ASC
            `)

        ]);

        const totals = totalsResult.results?.[0] || {};

        const totalApplications = toNumber(
            totals.total
        );

        const statuses = Object.fromEntries(
            APPLICATION_STATUSES.map(
                status => [status, 0]
            )
        );

        for (
            const row of statusesResult.results || []
        ) {
            if (
                Object.prototype.hasOwnProperty.call(
                    statuses,
                    row.status
                )
            ) {
                statuses[row.status] = toNumber(
                    row.total
                );
            }
        }

        const activeApplications =
            statuses.pending +
            statuses.under_review +
            statuses.shortlisted +
            statuses.interview;

        const completedApplications =
            statuses.accepted +
            statuses.declined +
            statuses.withdrawn;

        const decidedApplications =
            statuses.accepted +
            statuses.declined;

        const acceptanceRate = percentage(
            statuses.accepted,
            decidedApplications
        );

        const completionRate = percentage(
            completedApplications,
            totalApplications
        );

        const disciplines = (
            disciplinesResult.results || []
        ).map(row => ({
            name: row.discipline,
            total: toNumber(row.total),
            percentage: percentage(
                toNumber(row.total),
                totalApplications
            )
        }));

        const recentApplications = (
            recentResult.results || []
        ).map(row => ({
            applicationId: row.application_id,
            displayName: row.display_name,
            robloxUsername: row.roblox_username,
            discipline: row.discipline,
            status: row.status,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));

        const trends = (
            trendsResult.results || []
        ).map(row => ({
            date: row.date,
            applications: toNumber(row.total)
        }));

        const applicationsOpen = isEnabled(
            env.APPLICATIONS_OPEN
        );

        return jsonResponse({
            success: true,

            service: "Obsidian Crown Administration",

            version: VERSION,

            administrator: {
                email: administrator.email,
                role: "Administrator"
            },

            recruitment: {
                open: applicationsOpen,
                status: applicationsOpen
                    ? "open"
                    : "closed"
            },

            statistics: {
                total: totalApplications,

                pending: statuses.pending,

                underReview: statuses.under_review,

                shortlisted: statuses.shortlisted,

                interview: statuses.interview,

                accepted: statuses.accepted,

                declined: statuses.declined,

                withdrawn: statuses.withdrawn,

                active: activeApplications,

                completed: completedApplications,

                acceptanceRate,

                completionRate,

                last24Hours: toNumber(
                    totals.last_24_hours
                ),

                last7Days: toNumber(
                    totals.last_7_days
                ),

                last30Days: toNumber(
                    totals.last_30_days
                )
            },

            statusDistribution: APPLICATION_STATUSES.map(
                status => ({
                    status,
                    total: statuses[status],
                    percentage: percentage(
                        statuses[status],
                        totalApplications
                    )
                })
            ),

            disciplines,

            recentApplications,

            trends,

            system: {
                database: "connected",
                authentication: "verified",
                status: "operational"
            },

            generatedAt: new Date().toISOString(),

            requestId
        });

    } catch (error) {
        console.error(
            "[Admin Overview]",
            requestId,
            error.message
        );

        return jsonResponse({
            success: false,
            error: "Unable to retrieve recruitment overview",
            requestId
        }, 500);
    }
}
