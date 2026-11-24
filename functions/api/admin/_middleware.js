const JWKS_CACHE_DURATION = 300000;
const CLOCK_TOLERANCE = 30;

const jwksCache = new Map();

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store, private, max-age=0",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
            "X-Robots-Tag": "noindex, nofollow"
        }
    });
}

function decodeBase64Url(value) {
    const normalized = value
        .replace(/-/g, "+")
        .replace(/_/g, "/");

    const padded = normalized.padEnd(
        Math.ceil(normalized.length / 4) * 4,
        "="
    );

    return Uint8Array.from(
        atob(padded),
        character => character.charCodeAt(0)
    );
}

function decodeJSON(value) {
    return JSON.parse(
        new TextDecoder().decode(
            decodeBase64Url(value)
        )
    );
}

function getConfiguration(env) {
    const teamDomain = String(
        env.CF_ACCESS_TEAM_DOMAIN || ""
    )
        .trim()
        .replace(/^https:\/\//i, "")
        .replace(/\/+$/, "")
        .toLowerCase();

    const audience = String(
        env.CF_ACCESS_AUD || ""
    ).trim();

    const administrators = new Set(
        String(env.ADMIN_EMAILS || "")
            .split(",")
            .map(email => email.trim().toLowerCase())
            .filter(Boolean)
    );

    if (
        !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)
    ) {
        throw new Error("Invalid Cloudflare Access team domain");
    }

    if (!audience) {
        throw new Error("Missing Cloudflare Access audience");
    }

    if (administrators.size === 0) {
        throw new Error("No administrators configured");
    }

    return {
        teamDomain,
        issuer: `https://${teamDomain}`,
        audience,
        administrators
    };
}

async function getSigningKeys(teamDomain, forceRefresh = false) {
    const cached = jwksCache.get(teamDomain);

    if (
        !forceRefresh &&
        cached &&
        cached.expiresAt > Date.now()
    ) {
        return cached.keys;
    }

    const response = await fetch(
        `https://${teamDomain}/cdn-cgi/access/certs`,
        {
            method: "GET",
            redirect: "manual",
            headers: {
                Accept: "application/json"
            },
            signal: AbortSignal.timeout(5000)
        }
    );

    if (
        response.status >= 300 &&
        response.status < 400
    ) {
        throw new Error("Unexpected signing key redirect");
    }

    if (!response.ok) {
        throw new Error(
            `Unable to retrieve signing keys: HTTP ${response.status}`
        );
    }

    const data = await response.json();

    if (
        !data ||
        !Array.isArray(data.keys) ||
        data.keys.length === 0
    ) {
        throw new Error("Invalid signing key response");
    }

    const validKeys = data.keys.filter(
        key =>
            key &&
            key.kty === "RSA" &&
            typeof key.kid === "string" &&
            typeof key.n === "string" &&
            typeof key.e === "string" &&
            (!key.alg || key.alg === "RS256") &&
            (!key.use || key.use === "sig")
    );

    if (validKeys.length === 0) {
        throw new Error("No valid RSA signing keys found");
    }

    jwksCache.set(teamDomain, {
        keys: validKeys,
        expiresAt: Date.now() + JWKS_CACHE_DURATION
    });

    return validKeys;
}

async function getSigningKey(teamDomain, keyId) {
    let keys = await getSigningKeys(teamDomain);

    let key = keys.find(
        item =>
            item.kid === keyId &&
            item.kty === "RSA"
    );

    if (!key) {
        keys = await getSigningKeys(teamDomain, true);

        key = keys.find(
            item =>
                item.kid === keyId &&
                item.kty === "RSA"
        );
    }

    if (!key) {
        throw new Error("Unknown signing key");
    }

    return crypto.subtle.importKey(
        "jwk",
        key,
        {
            name: "RSASSA-PKCS1-v1_5",
            hash: "SHA-256"
        },
        false,
        ["verify"]
    );
}

async function verifyAccessToken(token, config) {
    if (
        typeof token !== "string" ||
        token.length === 0 ||
        token.length > 16384
    ) {
        throw new Error("Invalid access token");
    }

    const parts = token.split(".");

    if (
        parts.length !== 3 ||
        parts.some(
            part => !/^[A-Za-z0-9_-]+$/.test(part)
        )
    ) {
        throw new Error("Malformed access token");
    }

    const [
        encodedHeader,
        encodedPayload,
        encodedSignature
    ] = parts;

    const header = decodeJSON(encodedHeader);
    const payload = decodeJSON(encodedPayload);

    if (
        !header ||
        typeof header !== "object" ||
        !payload ||
        typeof payload !== "object"
    ) {
        throw new Error("Invalid token structure");
    }

    if (
        header.alg !== "RS256" ||
        typeof header.kid !== "string" ||
        !header.kid
    ) {
        throw new Error("Unsupported token signature");
    }

    const now = Math.floor(Date.now() / 1000);

    if (payload.iss !== config.issuer) {
        throw new Error("Invalid token issuer");
    }

    const audiences = Array.isArray(payload.aud)
        ? payload.aud
        : [payload.aud];

    if (!audiences.includes(config.audience)) {
        throw new Error("Invalid token audience");
    }

    if (
        !Number.isFinite(payload.exp) ||
        payload.exp <= now
    ) {
        throw new Error("Expired access token");
    }

    if (
        !Number.isFinite(payload.iat) ||
        payload.iat > now + CLOCK_TOLERANCE
    ) {
        throw new Error("Invalid token issuance time");
    }

    if (payload.exp <= payload.iat) {
        throw new Error("Invalid token lifetime");
    }

    if (
        payload.nbf !== undefined &&
        (
            !Number.isFinite(payload.nbf) ||
            payload.nbf > now + CLOCK_TOLERANCE
        )
    ) {
        throw new Error("Token is not active");
    }

    if (
        typeof payload.sub !== "string" ||
        !payload.sub.trim() ||
        typeof payload.email !== "string" ||
        !payload.email.trim()
    ) {
        throw new Error("Invalid administrator identity");
    }

    const signingKey = await getSigningKey(
        config.teamDomain,
        header.kid
    );

    const signature = decodeBase64Url(
        encodedSignature
    );

    const signedData = new TextEncoder().encode(
        `${encodedHeader}.${encodedPayload}`
    );

    const validSignature = await crypto.subtle.verify(
        {
            name: "RSASSA-PKCS1-v1_5"
        },
        signingKey,
        signature,
        signedData
    );

    if (!validSignature) {
        throw new Error("Invalid token signature");
    }

    return {
        email: payload.email.trim().toLowerCase(),
        subject: payload.sub,
        issuedAt: payload.iat,
        expiresAt: payload.exp
    };
}

export async function onRequest(context) {
    const {
        request,
        env,
        next,
        data
    } = context;

    const requestId = crypto.randomUUID();
    const url = new URL(request.url);

    if (
        url.protocol !== "https:" ||
        url.hostname !== "obsidiancrown.org"
    ) {
        return jsonResponse({
            success: false,
            error: "Forbidden host",
            requestId
        }, 403);
    }

    let config;

    try {
        config = getConfiguration(env);

    } catch (error) {
        console.error(
            "[Admin Configuration]",
            requestId,
            error.message
        );

        return jsonResponse({
            success: false,
            error: "Administration service unavailable",
            requestId
        }, 503);
    }

    const token = request.headers.get(
        "Cf-Access-Jwt-Assertion"
    );

    if (!token) {
        console.warn(
            "[Admin Authentication]",
            requestId,
            "Missing Cloudflare Access token"
        );

        return jsonResponse({
            success: false,
            error: "Authentication required",
            requestId
        }, 401);
    }

    let administrator;

    try {
        administrator = await verifyAccessToken(
            token,
            config
        );

    } catch (error) {
        console.warn(
            "[Admin Authentication]",
            requestId,
            error.message
        );

        return jsonResponse({
            success: false,
            error: "Invalid or expired authentication",
            requestId
        }, 401);
    }

    if (
        !config.administrators.has(
            administrator.email
        )
    ) {
        console.warn(
            "[Admin Authorization]",
            requestId,
            "Administrator not authorized"
        );

        return jsonResponse({
            success: false,
            error: "Administrator access denied",
            requestId
        }, 403);
    }

    const safeMethods = [
        "GET",
        "HEAD",
        "OPTIONS"
    ];

    if (!safeMethods.includes(request.method)) {
        const origin = request.headers.get("Origin");

        if (origin !== "https://obsidiancrown.org") {
            console.warn(
                "[Admin Security]",
                requestId,
                "Invalid request origin"
            );

            return jsonResponse({
                success: false,
                error: "Invalid request origin",
                requestId
            }, 403);
        }
    }

    if (!env.DB) {
        console.error(
            "[Admin Database]",
            requestId,
            "Missing D1 database binding"
        );

        return jsonResponse({
            success: false,
            error: "Database unavailable",
            requestId
        }, 503);
    }

    data.admin = administrator;
    data.requestId = requestId;

    console.info(
        "[Admin Authentication]",
        requestId,
        "Authentication successful"
    );

    try {
        const response = await next();

        const headers = new Headers(
            response.headers
        );

        headers.set(
            "Cache-Control",
            "no-store, private, max-age=0"
        );

        headers.set(
            "Pragma",
            "no-cache"
        );

        headers.set(
            "X-Content-Type-Options",
            "nosniff"
        );

        headers.set(
            "X-Frame-Options",
            "DENY"
        );

        headers.set(
            "Referrer-Policy",
            "no-referrer"
        );

        headers.set(
            "X-Robots-Tag",
            "noindex, nofollow"
        );

        headers.set(
            "X-Request-ID",
            requestId
        );

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers
        });

    } catch (error) {
        console.error(
            "[Admin API]",
            requestId,
            error.message
        );

        return jsonResponse({
            success: false,
            error: "Internal administration error",
            requestId
        }, 500);
    }
}
