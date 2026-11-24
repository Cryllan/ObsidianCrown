const VERSION = "1.0.0";

const SORT_OPTIONS = {
    newest: "created_at DESC, id DESC",
    oldest: "created_at ASC, id ASC",
    actor: "actor COLLATE NOCASE ASC, id DESC",
    action: "action COLLATE NOCASE ASC, id DESC"
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

function boundedInteger(value, fallback, min, max) {
    if (value === null || value === "") {
        return fallback;
    }

    const number = Number(value);

    if (!Number.isSafeInteger(number)) {
        return fallback;
    }

    return Math.min(Math.max(number, min), max);
}

function escapeLike(value) {
    return value.replace(
        /[\\%_]/g,
        character => "\\" + character
    );
}

function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const date = new Date(value + "T00:00:00.000Z");

    return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
    );
}

function parseDetails(value) {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function formatActivity(row) {
    return {
        id: row.id,
        actor: row.actor,
        action: row.action,
        targetType: row.target_type || null,
        targetId: row.target_id || null,
        details: parseDetails(row.details),
        createdAt: row.created_at
    };
}

export async function onRequest(context) {
    const { request, env, data } = context;

    if (!data.admin?.email) {
        return failure(
            context,
            "Authentication required",
            401
        );
    }

    if (request.method !== "GET") {
        return new Response(JSON.stringify({
            success: false,
            error: "Method not allowed",
            requestId: data.requestId
        }), {
            status: 405,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store, private",
                "X-Content-Type-Options": "nosniff",
                "Allow": "GET"
            }
        });
    }

    if (!env.DB) {
        return failure(
            context,
            "Database unavailable",
            503
        );
    }

    try {
        const url = new URL(request.url);
        const params = url.searchParams;

        const requestedPage = boundedInteger(
            params.get("page"),
            1,
            1,
            1000000
        );

        const limit = boundedInteger(
            params.get("limit"),
            25,
            1,
            100
        );

        const search = String(
            params.get("search") || ""
        ).trim().slice(0, 150);

        const actor = String(
            params.get("actor") || "all"
        ).trim().slice(0, 254);

        const action = String(
            params.get("action") || "all"
        ).trim().slice(0, 100);

        const targetType = String(
            params.get("targetType") || "all"
        ).trim().slice(0, 100);

        const targetId = String(
            params.get("targetId") || ""
        ).trim().slice(0, 128);

        const sort = String(
            params.get("sort") || "newest"
        ).trim().toLowerCase();

        const dateFrom = String(
            params.get("dateFrom") || ""
        ).trim();

        const dateTo = String(
            params.get("dateTo") || ""
        ).trim();

        if (
            !Object.prototype.hasOwnProperty.call(
                SORT_OPTIONS,
                sort
            )
        ) {
            return failure(
                context,
                "Invalid sorting option",
                400,
                {
                    validSortOptions:
                        Object.keys(SORT_OPTIONS)
                }
            );
        }

        if (dateFrom && !validDate(dateFrom)) {
            return failure(
                context,
                "Invalid starting date",
                400
            );
        }

        if (dateTo && !validDate(dateTo)) {
            return failure(
                context,
                "Invalid ending date",
                400
            );
        }

        if (
            dateFrom &&
            dateTo &&
            dateFrom > dateTo
        ) {
            return failure(
                context,
                "Invalid date range",
                400
            );
        }

        const conditions = [];
        const bindings = [];

        if (search) {
            const pattern =
                "%" + escapeLike(search) + "%";

            conditions.push(`
                (
                    actor LIKE ? ESCAPE '\\'
                    OR action LIKE ? ESCAPE '\\'
                    OR target_type LIKE ? ESCAPE '\\'
                    OR target_id LIKE ? ESCAPE '\\'
                )
            `);

            bindings.push(
                pattern,
                pattern,
                pattern,
                pattern
            );
        }

        if (actor.toLowerCase() !== "all") {
            conditions.push(
                "actor COLLATE NOCASE = ?"
            );

            bindings.push(actor);
        }

        if (action.toLowerCase() !== "all") {
            conditions.push("action = ?");
            bindings.push(action);
        }

        if (targetType.toLowerCase() !== "all") {
            conditions.push("target_type = ?");
            bindings.push(targetType);
        }

        if (targetId) {
            conditions.push("target_id = ?");
            bindings.push(targetId);
        }

        if (dateFrom) {
            conditions.push(
                "date(created_at) >= date(?)"
            );

            bindings.push(dateFrom);
        }

        if (dateTo) {
            conditions.push(
                "date(created_at) <= date(?)"
            );

            bindings.push(dateTo);
        }

        const whereClause = conditions.length
            ? "WHERE " + conditions.join(" AND ")
            : "";

        let countStatement = env.DB.prepare(`
            SELECT COUNT(*) AS total
            FROM admin_activity
            ${whereClause}
        `);

        if (bindings.length) {
            countStatement =
                countStatement.bind(...bindings);
        }

        const countResult =
            await countStatement.first();

        const total = Number(
            countResult?.total || 0
        );

        const totalPages = Math.max(
            1,
            Math.ceil(total / limit)
        );

        const page = Math.min(
            requestedPage,
            totalPages
        );

        const offset = (page - 1) * limit;

        const [
            activityResult,
            actorsResult,
            actionsResult,
            targetsResult,
            statisticsResult
        ] = await env.DB.batch([

            env.DB.prepare(`
                SELECT
                    id,
                    actor,
                    action,
                    target_type,
                    target_id,
                    details,
                    created_at
                FROM admin_activity
                ${whereClause}
                ORDER BY ${SORT_OPTIONS[sort]}
                LIMIT ?
                OFFSET ?
            `).bind(
                ...bindings,
                limit,
                offset
            ),

            env.DB.prepare(`
                SELECT
                    actor,
                    COUNT(*) AS total
                FROM admin_activity
                GROUP BY actor
                ORDER BY actor COLLATE NOCASE ASC
            `),

            env.DB.prepare(`
                SELECT
                    action,
                    COUNT(*) AS total
                FROM admin_activity
                GROUP BY action
                ORDER BY total DESC, action ASC
            `),

            env.DB.prepare(`
                SELECT
                    target_type,
                    COUNT(*) AS total
                FROM admin_activity
                WHERE target_type IS NOT NULL
                GROUP BY target_type
                ORDER BY target_type ASC
            `),

            env.DB.prepare(`
                SELECT
                    COUNT(*) AS total,

                    COUNT(DISTINCT actor)
                        AS administrators,

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

                FROM admin_activity
            `)

        ]);

        const activity = (
            activityResult.results || []
        ).map(formatActivity);

        const statistics =
            statisticsResult.results?.[0] || {};

        return jsonResponse({
            success: true,

            service:
                "Obsidian Crown Administration",

            version: VERSION,

            endpoint: "Administrator Activity",

            administrator: {
                email: data.admin.email,
                role: "Administrator"
            },

            statistics: {
                total: Number(
                    statistics.total || 0
                ),

                administrators: Number(
                    statistics.administrators || 0
                ),

                last24Hours: Number(
                    statistics.last_24_hours || 0
                ),

                last7Days: Number(
                    statistics.last_7_days || 0
                ),

                last30Days: Number(
                    statistics.last_30_days || 0
                )
            },

            activity,

            pagination: {
                page,
                limit,
                total,
                totalPages,

                hasNextPage:
                    page < totalPages,

                hasPreviousPage:
                    page > 1,

                showingFrom: activity.length
                    ? offset + 1
                    : 0,

                showingTo: activity.length
                    ? offset + activity.length
                    : 0
            },

            filters: {
                search,
                actor,
                action,
                targetType,
                targetId: targetId || null,
                sort,
                dateFrom: dateFrom || null,
                dateTo: dateTo || null
            },

            availableFilters: {
                actors: (
                    actorsResult.results || []
                ).map(row => ({
                    actor: row.actor,
                    total: Number(row.total || 0)
                })),

                actions: (
                    actionsResult.results || []
                ).map(row => ({
                    action: row.action,
                    total: Number(row.total || 0)
                })),

                targetTypes: (
                    targetsResult.results || []
                ).map(row => ({
                    targetType: row.target_type,
                    total: Number(row.total || 0)
                })),

                sortOptions:
                    Object.keys(SORT_OPTIONS)
            },

            permissions: {
                read: true,
                create: false,
                edit: false,
                delete: false
            },

            generatedAt:
                new Date().toISOString(),

            requestId: data.requestId
        });

    } catch (error) {
        console.error(
            "[Admin Activity]",
            data.requestId,
            error.message
        );

        return failure(
            context,
            "Unable to retrieve administrator activity",
            500
        );
    }
}
