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

const SORT_COLUMNS = {
    newest: "created_at DESC, id DESC",
    oldest: "created_at ASC, id ASC",
    updated: "updated_at DESC, id DESC",
    name_asc: "display_name COLLATE NOCASE ASC, id ASC",
    name_desc: "display_name COLLATE NOCASE DESC, id DESC",
    discipline: "discipline COLLATE NOCASE ASC, id ASC",
    status: "status ASC, id ASC"
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

    const date = new Date(
        value + "T00:00:00.000Z"
    );

    return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
    );
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

        const status = String(
            params.get("status") || "all"
        ).trim().toLowerCase();

        const discipline = String(
            params.get("discipline") || "all"
        ).trim().slice(0, 100);

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
            status !== "all" &&
            !VALID_STATUSES.includes(status)
        ) {
            return jsonResponse({
                success: false,
                error: "Invalid application status",
                validStatuses: VALID_STATUSES,
                requestId
            }, 400);
        }

        if (
            !Object.prototype.hasOwnProperty.call(
                SORT_COLUMNS,
                sort
            )
        ) {
            return jsonResponse({
                success: false,
                error: "Invalid sorting option",
                validSortOptions: Object.keys(
                    SORT_COLUMNS
                ),
                requestId
            }, 400);
        }

        if (dateFrom && !validDate(dateFrom)) {
            return jsonResponse({
                success: false,
                error: "Invalid starting date",
                requestId
            }, 400);
        }

        if (dateTo && !validDate(dateTo)) {
            return jsonResponse({
                success: false,
                error: "Invalid ending date",
                requestId
            }, 400);
        }

        if (
            dateFrom &&
            dateTo &&
            dateFrom > dateTo
        ) {
            return jsonResponse({
                success: false,
                error: "Invalid date range",
                requestId
            }, 400);
        }

        const conditions = [];
        const bindings = [];

        if (search) {
            const pattern =
                "%" + escapeLike(search) + "%";

            conditions.push(`
                (
                    application_id LIKE ? ESCAPE '\\'
                    OR display_name LIKE ? ESCAPE '\\'
                    OR roblox_username LIKE ? ESCAPE '\\'
                    OR discord_username LIKE ? ESCAPE '\\'
                    OR discipline LIKE ? ESCAPE '\\'
                )
            `);

            bindings.push(
                pattern,
                pattern,
                pattern,
                pattern,
                pattern
            );
        }

        if (status !== "all") {
            conditions.push("status = ?");
            bindings.push(status);
        }

        if (discipline.toLowerCase() !== "all") {
            conditions.push(
                "discipline COLLATE NOCASE = ?"
            );

            bindings.push(discipline);
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

        const countQuery = `
            SELECT COUNT(*) AS total
            FROM applications
            ${whereClause}
        `;

        const countResult = await env.DB
            .prepare(countQuery)
            .bind(...bindings)
            .first();

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

        const applicationsQuery = `
            SELECT
                application_id,
                display_name,
                roblox_username,
                discord_username,
                discipline,
                portfolio_url,
                status,
                reviewer,
                privacy_version,
                created_at,
                updated_at
            FROM applications
            ${whereClause}
            ORDER BY ${SORT_COLUMNS[sort]}
            LIMIT ?
            OFFSET ?
        `;

        const [
            applicationsResult,
            disciplinesResult,
            statusesResult
        ] = await env.DB.batch([

            env.DB.prepare(
                applicationsQuery
            ).bind(
                ...bindings,
                limit,
                offset
            ),

            env.DB.prepare(`
                SELECT
                    discipline,
                    COUNT(*) AS total
                FROM applications
                GROUP BY discipline
                ORDER BY discipline ASC
            `),

            env.DB.prepare(`
                SELECT
                    status,
                    COUNT(*) AS total
                FROM applications
                GROUP BY status
            `)

        ]);

        const applications = (
            applicationsResult.results || []
        ).map(row => ({
            applicationId: row.application_id,
            displayName: row.display_name,
            robloxUsername: row.roblox_username,
            discordUsername: row.discord_username,
            discipline: row.discipline,
            portfolioUrl: row.portfolio_url,
            status: row.status,
            reviewer: row.reviewer || null,
            privacyVersion: row.privacy_version,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));

        const statusCounts = Object.fromEntries(
            VALID_STATUSES.map(
                status => [status, 0]
            )
        );

        for (
            const row of statusesResult.results || []
        ) {
            if (
                Object.prototype.hasOwnProperty.call(
                    statusCounts,
                    row.status
                )
            ) {
                statusCounts[row.status] = Number(
                    row.total || 0
                );
            }
        }

        const disciplines = (
            disciplinesResult.results || []
        ).map(row => ({
            name: row.discipline,
            total: Number(row.total || 0)
        }));

        return jsonResponse({
            success: true,

            service: "Obsidian Crown Administration",

            version: VERSION,

            administrator: {
                email: administrator.email,
                role: "Administrator"
            },

            applications,

            pagination: {
                page,
                limit,
                total,
                totalPages,
                hasNextPage: page < totalPages,
                hasPreviousPage: page > 1,
                showingFrom: applications.length
                    ? offset + 1
                    : 0,
                showingTo: applications.length
                    ? offset + applications.length
                    : 0
            },

            filters: {
                search,
                status,
                discipline,
                sort,
                dateFrom: dateFrom || null,
                dateTo: dateTo || null
            },

            availableFilters: {
                statuses: VALID_STATUSES.map(
                    status => ({
                        status,
                        total: statusCounts[status]
                    })
                ),
                disciplines,
                sortOptions: Object.keys(
                    SORT_COLUMNS
                )
            },

            generatedAt: new Date().toISOString(),

            requestId
        });

    } catch (error) {
        console.error(
            "[Admin Applications]",
            requestId,
            error.message
        );

        return jsonResponse({
            success: false,
            error: "Unable to retrieve applications",
            requestId
        }, 500);
    }
}
