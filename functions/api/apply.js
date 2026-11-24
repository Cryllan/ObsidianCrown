const CONFIG = Object.freeze({
    SERVICE_NAME: "Obsidian Crown Recruitment",
    VERSION: "2.1.2",
    PRIVACY_VERSION: "1.0",
    MAX_BODY_SIZE: 16384,
    DUPLICATE_WINDOW_HOURS: 24,
    TURNSTILE_TIMEOUT: 10000,
    TURNSTILE_ACTION: "recruitment",

    DEFAULT_TITLE: "Careers at Obsidian Crown",

    DEFAULT_MESSAGE:
        "Recruitment is currently closed. Please check back for future opportunities.",

    ALLOWED_ORIGINS: [
        "https://obsidiancrown.org"
    ],

    ALLOWED_HOSTNAMES: [
        "obsidiancrown.org"
    ],

    DISCIPLINES: [
        "Game Engineering",
        "3D Art & Environment",
        "UI/UX Design",
        "Animation & Rigging",
        "Game Design",
        "Production & Community",
        "Other"
    ],

    EXPERIENCE_LEVELS: [
        "Less than 1 year",
        "1–2 years",
        "3–4 years",
        "5+ years"
    ]
});

class APIError extends Error {
    constructor(message, status = 400, code = "BAD_REQUEST") {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function diagnostic(stage, details = {}, level = "log") {
    const entry = JSON.stringify({
        service: CONFIG.SERVICE_NAME,
        version: CONFIG.VERSION,
        stage,
        timestamp: new Date().toISOString(),
        ...details
    });

    if (level === "error") {
        console.error(entry);
    } else if (level === "warn") {
        console.warn(entry);
    } else {
        console.log(entry);
    }
}

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store, max-age=0",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
            "X-Robots-Tag": "noindex, nofollow",
            ...extraHeaders
        }
    });
}

function success(data = {}, status = 200) {
    return json({
        success: true,
        ...data
    }, status);
}

function failure(
    message,
    status = 400,
    code = "BAD_REQUEST",
    extra = {}
) {
    return json({
        success: false,
        code,
        message,
        ...extra
    }, status);
}

function getTurnstileSecret(env) {
    return typeof env.TURNSTILE_SECRET === "string"
        ? env.TURNSTILE_SECRET.trim()
        : "";
}

function backendConfigured(env) {
    return Boolean(
        env.DB &&
        getTurnstileSecret(env)
    );
}

function parseBoolean(value) {
    return ["true", "1", "yes", "on"].includes(
        String(value ?? "").trim().toLowerCase()
    );
}

function normalizeText(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value
        .normalize("NFKC")
        .replace(/\r\n/g, "\n")
        .replace(
            /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
            ""
        )
        .trim();
}

function requiredText(value, label, min, max) {
    const text = normalizeText(value);

    if (text.length < min || text.length > max) {
        throw new APIError(
            `${label} must contain between ${min} and ${max} characters.`,
            400,
            "VALIDATION_ERROR"
        );
    }

    return text;
}

async function loadRecruitmentSettings(env) {
    if (!env.DB) {
        throw new APIError(
            "Recruitment service is temporarily unavailable.",
            503,
            "DATABASE_UNAVAILABLE"
        );
    }

    let result;

    try {
        result = await env.DB.prepare(`
            SELECT key, value
            FROM recruitment_settings
            WHERE key IN (
                'applications_open',
                'recruitment_title',
                'recruitment_message',
                'privacy_version'
            )
        `).all();

    } catch {
        diagnostic(
            "settings.load_failed",
            {},
            "error"
        );

        throw new APIError(
            "Recruitment configuration is temporarily unavailable.",
            503,
            "SETTINGS_UNAVAILABLE"
        );
    }

    const settings = new Map(
        (result.results || []).map(row => [
            row.key,
            row.value
        ])
    );

    const open = settings.has("applications_open")
        ? parseBoolean(settings.get("applications_open"))
        : false;

    const title = normalizeText(
        settings.get("recruitment_title")
    ) || CONFIG.DEFAULT_TITLE;

    const message = normalizeText(
        settings.get("recruitment_message")
    ) || (
        open
            ? "We welcome expressions of interest from talented developers and creatives."
            : CONFIG.DEFAULT_MESSAGE
    );

    const privacyVersion = settings.has("privacy_version")
        ? String(settings.get("privacy_version"))
        : CONFIG.PRIVACY_VERSION;

    if (
        !/^[0-9]+(?:\.[0-9]+)*$/.test(privacyVersion) ||
        privacyVersion.length > 30
    ) {
        throw new APIError(
            "Recruitment configuration is temporarily unavailable.",
            503,
            "INVALID_CONFIGURATION"
        );
    }

    return {
        open,
        status: open ? "open" : "closed",
        title,
        message,
        privacyVersion,

        source: settings.has("applications_open")
            ? "database"
            : "default"
    };
}

function formatRecruitment(settings, configured = true) {
    const open = configured && settings.open;

    return {
        open,
        status: open ? "open" : "closed",
        title: settings.title,

        message: configured
            ? settings.message
            : "Recruitment is temporarily unavailable.",

        privacyVersion: settings.privacyVersion
    };
}

function validateOrigin(request) {
    const origin = request.headers.get("Origin");

    if (
        !origin ||
        !CONFIG.ALLOWED_ORIGINS.includes(origin)
    ) {
        throw new APIError(
            "This request is not permitted.",
            403,
            "INVALID_ORIGIN"
        );
    }
}

function validateHostname(request) {
    const url = new URL(request.url);

    if (
        url.protocol !== "https:" ||
        !CONFIG.ALLOWED_HOSTNAMES.includes(url.hostname)
    ) {
        throw new APIError(
            "This request is not permitted.",
            403,
            "INVALID_HOSTNAME"
        );
    }
}

async function readJSON(request) {
    const contentType = request.headers
        .get("Content-Type")
        ?.split(";")[0]
        .trim()
        .toLowerCase();

    if (contentType !== "application/json") {
        throw new APIError(
            "The request must contain JSON data.",
            415,
            "INVALID_CONTENT_TYPE"
        );
    }

    const declaredLength = Number(
        request.headers.get("Content-Length") || 0
    );

    if (declaredLength > CONFIG.MAX_BODY_SIZE) {
        throw new APIError(
            "The submission is too large.",
            413,
            "PAYLOAD_TOO_LARGE"
        );
    }

    if (!request.body) {
        throw new APIError(
            "No application data was provided.",
            400,
            "EMPTY_BODY"
        );
    }

    const reader = request.body.getReader();
    const decoder = new TextDecoder();

    let size = 0;
    let raw = "";

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            size += value.byteLength;

            if (size > CONFIG.MAX_BODY_SIZE) {
                await reader.cancel();

                throw new APIError(
                    "The submission is too large.",
                    413,
                    "PAYLOAD_TOO_LARGE"
                );
            }

            raw += decoder.decode(value, {
                stream: true
            });
        }

        raw += decoder.decode();

    } finally {
        reader.releaseLock();
    }

    let data;

    try {
        data = JSON.parse(raw);

    } catch {
        throw new APIError(
            "Invalid application data.",
            400,
            "INVALID_JSON"
        );
    }

    if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data)
    ) {
        throw new APIError(
            "Invalid application data.",
            400,
            "INVALID_JSON"
        );
    }

    return data;
}

function validatePortfolio(value) {
    const portfolio = requiredText(
        value,
        "Portfolio URL",
        10,
        500
    );

    let url;

    try {
        url = new URL(portfolio);

    } catch {
        throw new APIError(
            "Please provide a valid portfolio URL.",
            400,
            "INVALID_PORTFOLIO"
        );
    }

    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !url.hostname.includes(".") ||
        url.hostname === "localhost" ||
        url.hostname.endsWith(".local")
    ) {
        throw new APIError(
            "Your portfolio must use a valid HTTPS URL.",
            400,
            "INVALID_PORTFOLIO"
        );
    }

    if (url.href.length > 500) {
        throw new APIError(
            "The portfolio URL is too long.",
            400,
            "INVALID_PORTFOLIO"
        );
    }

    return url.href;
}

function validateApplication(data, recruitment) {
    const displayName = requiredText(
        data.displayName,
        "Preferred name",
        2,
        60
    );

    const robloxUsername = requiredText(
        data.robloxUsername,
        "Roblox username",
        3,
        20
    );

    if (!/^[A-Za-z0-9_]{3,20}$/.test(robloxUsername)) {
        throw new APIError(
            "Please enter a valid Roblox username.",
            400,
            "INVALID_ROBLOX_USERNAME"
        );
    }

    const discordUsername = normalizeText(
        data.discordUsername
    );

    if (
        discordUsername &&
        !/^[a-z0-9._]{2,32}$/.test(discordUsername)
    ) {
        throw new APIError(
            "Please enter a valid Discord username, not a display name.",
            400,
            "INVALID_DISCORD_USERNAME"
        );
    }

    const discipline = normalizeText(
        data.discipline
    );

    if (!CONFIG.DISCIPLINES.includes(discipline)) {
        throw new APIError(
            "Please select a valid discipline.",
            400,
            "INVALID_DISCIPLINE"
        );
    }

    const experience = normalizeText(
        data.experience
    );

    if (!CONFIG.EXPERIENCE_LEVELS.includes(experience)) {
        throw new APIError(
            "Please select your development experience.",
            400,
            "INVALID_EXPERIENCE"
        );
    }

    const portfolioURL = validatePortfolio(
        data.portfolioURL
    );

    const introduction = requiredText(
        data.introduction,
        "Introduction",
        30,
        2500
    );

    if (
        data.privacyAccepted !== true ||
        data.privacyVersion !== recruitment.privacyVersion
    ) {
        throw new APIError(
            "Please review and acknowledge the current privacy policy.",
            400,
            "PRIVACY_REQUIRED"
        );
    }

    const turnstileToken =
        typeof data.turnstileToken === "string"
            ? data.turnstileToken.trim()
            : "";

    if (
        !turnstileToken ||
        turnstileToken.length > 2048
    ) {
        throw new APIError(
            "Please complete the security verification.",
            400,
            "TURNSTILE_REQUIRED"
        );
    }

    return {
        displayName,
        robloxUsername,
        discordUsername: discordUsername || null,
        discipline,
        experience,
        portfolioURL,
        introduction,
        privacyVersion: recruitment.privacyVersion,
        turnstileToken
    };
}

async function verifyTurnstile(
    env,
    token,
    request,
    requestID
) {
    const secret = getTurnstileSecret(env);

    if (!secret) {
        diagnostic(
            "turnstile.secret_missing",
            { requestID },
            "error"
        );

        throw new APIError(
            "Security verification is temporarily unavailable.",
            503,
            "SECURITY_UNAVAILABLE"
        );
    }

    diagnostic("turnstile.started", {
        requestID,
        tokenPresent: Boolean(token),
        tokenLength: token.length,
        secretConfigured: true,
        expectedAction: CONFIG.TURNSTILE_ACTION
    });

    const form = new URLSearchParams();

    form.set("secret", secret);
    form.set("response", token);
    form.set("idempotency_key", crypto.randomUUID());

    const ip = request.headers.get("CF-Connecting-IP");

    if (ip) {
        form.set("remoteip", ip);
    }

    let response;
    let result;

    const startedAt = Date.now();

    try {
        response = await fetch(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/x-www-form-urlencoded",

                    "Accept":
                        "application/json"
                },

                body: form.toString(),

                redirect: "manual",

                signal: AbortSignal.timeout(
                    CONFIG.TURNSTILE_TIMEOUT
                )
            }
        );

        if (!response.ok) {
            diagnostic(
                "turnstile.http_error",
                {
                    requestID,
                    status: response.status,
                    durationMs: Date.now() - startedAt
                },
                "error"
            );

            throw new Error(
                "Verification service unavailable."
            );
        }

        result = await response.json();

    } catch {
        diagnostic(
            "turnstile.service_unavailable",
            {
                requestID,
                durationMs: Date.now() - startedAt
            },
            "error"
        );

        throw new APIError(
            "Security verification is temporarily unavailable. Please try again.",
            503,
            "SECURITY_UNAVAILABLE"
        );
    }

    const knownErrorCodes = new Set([
        "missing-input-secret",
        "invalid-input-secret",
        "missing-input-response",
        "invalid-input-response",
        "bad-request",
        "timeout-or-duplicate",
        "internal-error"
    ]);

    const codes = Array.isArray(result?.["error-codes"])
        ? result["error-codes"].map(code =>
            knownErrorCodes.has(code)
                ? code
                : "unknown-error"
        )
        : [];

    diagnostic("turnstile.siteverify_response", {
        requestID,
        httpStatus: response.status,
        verified: result?.success === true,
        codes,
        durationMs: Date.now() - startedAt
    });

    if (result?.success !== true) {
        diagnostic(
            "turnstile.rejected",
            {
                requestID,
                codes
            },
            "warn"
        );

        if (
            codes.includes("invalid-input-secret") ||
            codes.includes("missing-input-secret") ||
            codes.includes("internal-error")
        ) {
            throw new APIError(
                "Security verification is temporarily unavailable. Please try again later.",
                503,
                "SECURITY_UNAVAILABLE"
            );
        }

        if (codes.includes("timeout-or-duplicate")) {
            throw new APIError(
                "Your security verification has expired or has already been used. Please complete a new verification.",
                403,
                "TURNSTILE_FAILED"
            );
        }

        throw new APIError(
            "Security verification failed. Please complete a new verification.",
            403,
            "TURNSTILE_FAILED"
        );
    }

    if (
        !CONFIG.ALLOWED_HOSTNAMES.includes(
            result.hostname
        )
    ) {
        diagnostic(
            "turnstile.hostname_mismatch",
            {
                requestID,
                hostnameMatched: false
            },
            "warn"
        );

        throw new APIError(
            "Security verification was issued for an invalid hostname.",
            403,
            "INVALID_HOSTNAME"
        );
    }

    if (result.action !== CONFIG.TURNSTILE_ACTION) {
        diagnostic(
            "turnstile.action_mismatch",
            {
                requestID,
                expectedAction: CONFIG.TURNSTILE_ACTION,
                actionMatched: false
            },
            "warn"
        );

        throw new APIError(
            "Invalid security verification action.",
            403,
            "INVALID_ACTION"
        );
    }

    diagnostic("turnstile.verified", {
        requestID,
        hostnameMatched: true,
        actionMatched: true,
        durationMs: Date.now() - startedAt
    });

    return true;
}

function generateApplicationID() {
    const bytes = new Uint8Array(12);

    crypto.getRandomValues(bytes);

    const reference = Array.from(bytes)
        .map(byte =>
            byte.toString(16).padStart(2, "0")
        )
        .join("")
        .toUpperCase();

    return `OC-${reference}`;
}

async function storeApplication(
    env,
    application,
    requestID
) {
    const applicationID = generateApplicationID();

    const duplicateWindow =
        `-${CONFIG.DUPLICATE_WINDOW_HOURS} hours`;

    const timestamp = new Date().toISOString();

    const insert = env.DB.prepare(`
        INSERT INTO applications (
            application_id,
            display_name,
            roblox_username,
            discord_username,
            discipline,
            experience,
            portfolio_url,
            introduction,
            status,
            privacy_version,
            created_at,
            updated_at
        )
        SELECT
            ?, ?, ?, ?, ?, ?, ?, ?,
            'pending',
            ?, ?, ?
        WHERE EXISTS (
            SELECT 1
            FROM recruitment_settings
            WHERE key = 'applications_open'
            AND LOWER(TRIM(value)) IN (
                'true',
                '1',
                'yes',
                'on'
            )
        )
        AND COALESCE(
            (
                SELECT value
                FROM recruitment_settings
                WHERE key = 'privacy_version'
            ),
            ?
        ) = ?
        AND NOT EXISTS (
            SELECT 1
            FROM applications
            WHERE LOWER(roblox_username) = LOWER(?)
            AND discipline = ?
            AND datetime(created_at) >= datetime('now', ?)
        )
    `).bind(
        applicationID,
        application.displayName,
        application.robloxUsername,
        application.discordUsername,
        application.discipline,
        application.experience,
        application.portfolioURL,
        application.introduction,
        application.privacyVersion,
        timestamp,
        timestamp,
        CONFIG.PRIVACY_VERSION,
        application.privacyVersion,
        application.robloxUsername,
        application.discipline,
        duplicateWindow
    );

    const history = env.DB.prepare(`
        INSERT INTO application_history (
            application_id,
            previous_status,
            new_status,
            changed_by,
            notes,
            created_at
        )
        SELECT
            application_id,
            NULL,
            'pending',
            'system',
            'Application submitted.',
            ?
        FROM applications
        WHERE application_id = ?
        AND changes() = 1
    `).bind(
        timestamp,
        applicationID
    );

    let results;

    try {
        results = await env.DB.batch([
            insert,
            history
        ]);

    } catch {
        diagnostic(
            "submission.database_error",
            { requestID },
            "error"
        );

        throw new APIError(
            "Your application could not be saved. Please try again later.",
            503,
            "DATABASE_WRITE_FAILED"
        );
    }

    const insertedRows = Number(
        results[0]?.meta?.changes || 0
    );

    const historyRows = Number(
        results[1]?.meta?.changes || 0
    );

    if (insertedRows === 0) {
        const latest = await loadRecruitmentSettings(env);

        if (!latest.open) {
            throw new APIError(
                "Portfolio submissions are not currently open.",
                503,
                "APPLICATIONS_CLOSED"
            );
        }

        if (
            latest.privacyVersion !==
            application.privacyVersion
        ) {
            throw new APIError(
                "The privacy policy has changed. Please refresh the page and review the current policy.",
                409,
                "PRIVACY_VERSION_CHANGED"
            );
        }

        const duplicate = await env.DB.prepare(`
            SELECT application_id
            FROM applications
            WHERE LOWER(roblox_username) = LOWER(?)
            AND discipline = ?
            AND datetime(created_at) >= datetime('now', ?)
            LIMIT 1
        `).bind(
            application.robloxUsername,
            application.discipline,
            duplicateWindow
        ).first();

        if (duplicate) {
            diagnostic("submission.duplicate", {
                requestID
            });

            throw new APIError(
                "An application for this Roblox username and discipline has already been submitted within the last 24 hours.",
                409,
                "DUPLICATE_APPLICATION"
            );
        }

        throw new APIError(
            "Recruitment configuration changed during submission. Please refresh the page and try again.",
            409,
            "RECRUITMENT_CONFIGURATION_CHANGED"
        );
    }

    if (
        insertedRows !== 1 ||
        historyRows !== 1
    ) {
        diagnostic(
            "submission.transaction_verification_failed",
            {
                requestID,
                insertedRows,
                historyRows
            },
            "error"
        );

        throw new APIError(
            "The submission could not be fully verified. Please contact recruitment support before submitting again.",
            500,
            "SUBMISSION_VERIFICATION_FAILED"
        );
    }

    diagnostic("submission.saved", {
        requestID,
        insertedRows,
        historyRows
    });

    return applicationID;
}

async function sendDiscordNotification(
    env,
    applicationID,
    application
) {
    if (!env.DISCORD_WEBHOOK_URL) {
        return;
    }

    let webhook;

    try {
        webhook = new URL(
            env.DISCORD_WEBHOOK_URL
        );

        if (
            webhook.protocol !== "https:" ||
            webhook.hostname !== "discord.com" ||
            !webhook.pathname.startsWith("/api/webhooks/") ||
            webhook.username ||
            webhook.password ||
            webhook.port
        ) {
            diagnostic(
                "notification.invalid_configuration",
                {},
                "error"
            );

            return;
        }

    } catch {
        diagnostic(
            "notification.invalid_configuration",
            {},
            "error"
        );

        return;
    }

    const payload = {
        username: "Obsidian Crown Recruitment",

        allowed_mentions: {
            parse: []
        },

        embeds: [
            {
                author: {
                    name: "OBSIDIAN CROWN • RECRUITMENT"
                },

                title: "New Portfolio Submission",

                description:
                    "A new expression of interest has been received and is awaiting review.",

                color: 0xBCA783,

                fields: [
                    {
                        name: "Application Reference",
                        value: applicationID,
                        inline: false
                    },
                    {
                        name: "Discipline",
                        value: application.discipline,
                        inline: true
                    },
                    {
                        name: "Experience",
                        value: application.experience,
                        inline: true
                    },
                    {
                        name: "Status",
                        value: "Pending Review",
                        inline: true
                    }
                ],

                footer: {
                    text: "Obsidian Crown • Recruitment System"
                },

                timestamp: new Date().toISOString()
            }
        ]
    };

    try {
        const response = await fetch(
            webhook.href,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify(payload),

                redirect: "manual",

                signal: AbortSignal.timeout(10000)
            }
        );

        if (!response.ok) {
            diagnostic(
                "notification.delivery_failed",
                {
                    status: response.status
                },
                "error"
            );

            return;
        }

        diagnostic("notification.delivered");

    } catch {
        diagnostic(
            "notification.delivery_failed",
            {},
            "error"
        );
    }
}

function handleError(error, requestID = null) {
    if (error instanceof APIError) {
        diagnostic(
            "request.rejected",
            {
                requestID,
                status: error.status,
                code: error.code
            },
            error.status >= 500 ? "error" : "warn"
        );

        return failure(
            error.message,
            error.status,
            error.code,
            {
                requestId: requestID
            }
        );
    }

    diagnostic(
        "request.unexpected_error",
        { requestID },
        "error"
    );

    return failure(
        "An unexpected error occurred. Please try again later.",
        500,
        "INTERNAL_ERROR",
        {
            requestId: requestID
        }
    );
}

export async function onRequestGet(context) {
    const { request, env } = context;

    const requestID = crypto.randomUUID();

    try {
        validateHostname(request);

        if (!env.DB) {
            return failure(
                "Recruitment service unavailable.",
                503,
                "DATABASE_UNAVAILABLE"
            );
        }

        await env.DB.prepare(`
            SELECT application_id
            FROM applications
            LIMIT 0
        `).all();

        await env.DB.prepare(`
            SELECT application_id
            FROM application_history
            LIMIT 0
        `).all();

        const settings = await loadRecruitmentSettings(
            env
        );

        const configured = backendConfigured(env);

        const recruitment = formatRecruitment(
            settings,
            configured
        );

        return success({
            service: CONFIG.SERVICE_NAME,

            version: CONFIG.VERSION,

            database: "connected",

            status: configured
                ? "operational"
                : "configuration_required",

            applicationsOpen: recruitment.open,

            privacyVersion: recruitment.privacyVersion,

            recruitment,

            configuration: {
                source: settings.source,
                persistent: true
            },

            capabilities: {
                persistentRecruitmentSettings: true,
                dynamicRecruitmentAvailability: true,
                dynamicRecruitmentMessaging: true,
                dynamicPrivacyVersion: true,
                turnstileVerification: true,
                turnstileDiagnostics: true,
                duplicatePrevention: true,
                submissionHistory: true,
                transactionalSubmissions: true,
                submissionAvailabilityRecheck: true
            },

            generatedAt: new Date().toISOString(),

            requestId: requestID
        });

    } catch (error) {
        return handleError(
            error,
            requestID
        );
    }
}

export async function onRequestPost(context) {
    const { request, env } = context;

    const requestID = crypto.randomUUID();

    diagnostic("submission.received", {
        requestID
    });

    try {
        validateHostname(request);
        validateOrigin(request);

        if (!env.DB) {
            diagnostic(
                "submission.database_missing",
                { requestID },
                "error"
            );

            return failure(
                "Recruitment service is temporarily unavailable.",
                503,
                "DATABASE_UNAVAILABLE",
                {
                    requestId: requestID
                }
            );
        }

        if (!getTurnstileSecret(env)) {
            diagnostic(
                "turnstile.secret_missing",
                { requestID },
                "error"
            );

            return failure(
                "Security verification is temporarily unavailable.",
                503,
                "SECURITY_UNAVAILABLE",
                {
                    requestId: requestID
                }
            );
        }

        const recruitment = await loadRecruitmentSettings(
            env
        );

        if (!recruitment.open) {
            diagnostic("submission.recruitment_closed", {
                requestID
            });

            return failure(
                "Portfolio submissions are not currently open.",
                503,
                "APPLICATIONS_CLOSED",
                {
                    recruitment: formatRecruitment(
                        recruitment
                    ),

                    requestId: requestID
                }
            );
        }

        const data = await readJSON(request);

        const application = validateApplication(
            data,
            recruitment
        );

        diagnostic("submission.validation_passed", {
            requestID
        });

        await verifyTurnstile(
            env,
            application.turnstileToken,
            request,
            requestID
        );

        const applicationID = await storeApplication(
            env,
            application,
            requestID
        );

        if (env.DISCORD_WEBHOOK_URL) {
            context.waitUntil(
                sendDiscordNotification(
                    env,
                    applicationID,
                    application
                )
            );
        }

        diagnostic("submission.completed", {
            requestID
        });

        return success({
            message:
                "Your portfolio has been successfully submitted to Obsidian Crown.",

            applicationID,

            status: "pending",

            requestId: requestID
        }, 201);

    } catch (error) {
        return handleError(
            error,
            requestID
        );
    }
}

export async function onRequestOptions() {
    return failure(
        "Cross-origin requests are not supported.",
        405,
        "METHOD_NOT_ALLOWED"
    );
}

export async function onRequestPut() {
    return failure(
        "Method not allowed.",
        405,
        "METHOD_NOT_ALLOWED"
    );
}

export async function onRequestPatch() {
    return failure(
        "Method not allowed.",
        405,
        "METHOD_NOT_ALLOWED"
    );
}

export async function onRequestDelete() {
    return failure(
        "Method not allowed.",
        405,
        "METHOD_NOT_ALLOWED"
    );
}
