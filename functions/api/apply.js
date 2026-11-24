
const CONFIG = Object.freeze({
    SERVICE_NAME: "Obsidian Crown Recruitment",
    VERSION: "2.0.0",
    PRIVACY_VERSION: "1.0",
    MAX_BODY_SIZE: 16384,
    DUPLICATE_WINDOW_HOURS: 24,

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

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store, max-age=0",
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

function failure(message, status = 400, code = "BAD_REQUEST") {
    return json({
        success: false,
        code,
        message
    }, status);
}

function applicationsOpen(env) {
    return String(env.APPLICATIONS_OPEN || "")
        .trim()
        .toLowerCase() === "true";
}

function backendConfigured(env) {
    return Boolean(
        env.DB &&
        env.TURNSTILE_SECRET
    );
}

function normalizeText(value) {
    if (typeof value !== "string") {
        return "";
    }

    return value
        .normalize("NFKC")
        .replace(/\r\n/g, "\n")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
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

function validateOrigin(request) {
    const origin = request.headers.get("Origin");

    if (!origin || !CONFIG.ALLOWED_ORIGINS.includes(origin)) {
        throw new APIError(
            "This request is not permitted.",
            403,
            "INVALID_ORIGIN"
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

    if (!data || typeof data !== "object" || Array.isArray(data)) {
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

    return url.href;
}

function validateApplication(data) {
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

    const discipline = normalizeText(data.discipline);

    if (!CONFIG.DISCIPLINES.includes(discipline)) {
        throw new APIError(
            "Please select a valid discipline.",
            400,
            "INVALID_DISCIPLINE"
        );
    }

    const experience = normalizeText(data.experience);

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
        data.privacyVersion !== CONFIG.PRIVACY_VERSION
    ) {
        throw new APIError(
            "Please review and acknowledge the current privacy policy.",
            400,
            "PRIVACY_REQUIRED"
        );
    }

    const turnstileToken = requiredText(
        data.turnstileToken,
        "Security verification",
        1,
        2048
    );

    return {
        displayName,
        robloxUsername,
        discordUsername: discordUsername || null,
        discipline,
        experience,
        portfolioURL,
        introduction,
        turnstileToken
    };
}

async function verifyTurnstile(env, token, request) {
    if (!env.TURNSTILE_SECRET) {
        throw new APIError(
            "Security verification is temporarily unavailable.",
            503,
            "SECURITY_UNAVAILABLE"
        );
    }

    const form = new URLSearchParams();

    form.set("secret", env.TURNSTILE_SECRET);
    form.set("response", token);
    form.set("idempotency_key", crypto.randomUUID());

    const ip = request.headers.get("CF-Connecting-IP");

    if (ip) {
        form.set("remoteip", ip);
    }

    let response;
    let result;

    try {
        response = await fetch(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: form.toString(),
                signal: AbortSignal.timeout(10000)
            }
        );

        if (!response.ok) {
            throw new Error("Verification service unavailable.");
        }

        result = await response.json();

    } catch {
        throw new APIError(
            "Security verification is temporarily unavailable. Please try again.",
            503,
            "SECURITY_UNAVAILABLE"
        );
    }

    if (!result.success) {
        throw new APIError(
            "Security verification failed. Please complete a new verification.",
            403,
            "TURNSTILE_FAILED"
        );
    }

    if (!CONFIG.ALLOWED_HOSTNAMES.includes(result.hostname)) {
        throw new APIError(
            "Security verification was issued for an invalid hostname.",
            403,
            "INVALID_HOSTNAME"
        );
    }

    if (result.action !== "recruitment") {
        throw new APIError(
            "Invalid security verification action.",
            403,
            "INVALID_ACTION"
        );
    }

    return true;
}

function generateApplicationID() {
    const bytes = new Uint8Array(12);

    crypto.getRandomValues(bytes);

    const reference = Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("")
        .toUpperCase();

    return `OC-${reference}`;
}

async function storeApplication(env, application) {
    const applicationID = generateApplicationID();

    const duplicateWindow =
        `-${CONFIG.DUPLICATE_WINDOW_HOURS} hours`;

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
            ?,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        WHERE NOT EXISTS (
            SELECT 1
            FROM applications
            WHERE LOWER(roblox_username) = LOWER(?)
            AND discipline = ?
            AND created_at >= datetime('now', ?)
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
        CONFIG.PRIVACY_VERSION,
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
            CURRENT_TIMESTAMP
        FROM applications
        WHERE application_id = ?
    `).bind(applicationID);

    const results = await env.DB.batch([
        insert,
        history
    ]);

    if (results[0].meta.changes !== 1) {
        throw new APIError(
            "An application for this Roblox username and discipline has already been submitted within the last 24 hours.",
            409,
            "DUPLICATE_APPLICATION"
        );
    }

    return applicationID;
}

async function sendDiscordNotification(env, applicationID, application) {
    if (!env.DISCORD_WEBHOOK_URL) {
        return;
    }

    let webhook;

    try {
        webhook = new URL(env.DISCORD_WEBHOOK_URL);

        if (
            webhook.protocol !== "https:" ||
            webhook.hostname !== "discord.com" ||
            !webhook.pathname.startsWith("/api/webhooks/") ||
            webhook.username ||
            webhook.password ||
            webhook.port
        ) {
            console.error("Invalid recruitment webhook configuration.");
            return;
        }

    } catch {
        console.error("Invalid recruitment webhook configuration.");
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
        const response = await fetch(webhook.href, {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify(payload),

            redirect: "error",

            signal: AbortSignal.timeout(10000)
        });

        if (!response.ok) {
            console.error(
                "Recruitment notification failed:",
                response.status
            );
        }

    } catch {
        console.error("Recruitment notification delivery failed.");
    }
}

function handleError(error) {
    if (error instanceof APIError) {
        return failure(
            error.message,
            error.status,
            error.code
        );
    }

    console.error("Unexpected recruitment API error.");

    return failure(
        "An unexpected error occurred. Please try again later.",
        500,
        "INTERNAL_ERROR"
    );
}

export async function onRequestGet(context) {
    const { env } = context;

    try {
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

        const configured = backendConfigured(env);

        return success({
            service: CONFIG.SERVICE_NAME,
            version: CONFIG.VERSION,
            database: "connected",
            status: configured
                ? "operational"
                : "configuration_required",
            applicationsOpen:
                configured && applicationsOpen(env),
            privacyVersion: CONFIG.PRIVACY_VERSION
        });

    } catch (error) {
        return handleError(error);
    }
}

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        validateOrigin(request);

        if (!backendConfigured(env)) {
            return failure(
                "Recruitment service is temporarily unavailable.",
                503,
                "SERVICE_UNAVAILABLE"
            );
        }

        if (!applicationsOpen(env)) {
            return failure(
                "Portfolio submissions are not currently open.",
                503,
                "APPLICATIONS_CLOSED"
            );
        }

        const data = await readJSON(request);

        const application = validateApplication(data);

        await verifyTurnstile(
            env,
            application.turnstileToken,
            request
        );

        const applicationID = await storeApplication(
            env,
            application
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

        return success({
            message:
                "Your portfolio has been successfully submitted to Obsidian Crown.",
            applicationID,
            status: "pending"
        }, 201);

    } catch (error) {
        return handleError(error);
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
