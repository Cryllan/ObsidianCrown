export async function onRequestGet(context) {
    const { data, env } = context;

    const administrator = data.admin;

    if (!administrator) {
        return Response.json({
            success: false,
            error: "Authentication required"
        }, {
            status: 401
        });
    }

    const database = await env.DB
        .prepare("SELECT 1 AS connected")
        .first();

    return Response.json({
        success: true,
        service: "Obsidian Crown Administration",
        version: "1.0.0",
        authenticated: true,
        administrator: {
            email: administrator.email,
            role: "Administrator"
        },
        session: {
            issuedAt: new Date(
                administrator.issuedAt * 1000
            ).toISOString(),
            expiresAt: new Date(
                administrator.expiresAt * 1000
            ).toISOString()
        },
        database: database?.connected === 1
            ? "connected"
            : "unavailable",
        status: "operational",
        requestId: data.requestId
    }, {
        headers: {
            "Cache-Control": "no-store, private"
        }
    });
}
