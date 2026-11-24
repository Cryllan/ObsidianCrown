
function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff"
        }
    });
}

export async function onRequestGet(context) {
    try {
        const db = context.env.DB;

        if (!db) {
            return json({
                success: false,
                message: "Service unavailable."
            }, 503);
        }

        await db.prepare(`
            SELECT application_id
            FROM applications
            LIMIT 0
        `).all();

        await db.prepare(`
            SELECT application_id
            FROM application_history
            LIMIT 0
        `).all();

        return json({
            success: true,
            service: "Obsidian Crown Recruitment",
            version: "1.0.0",
            database: "connected",
            status: "operational",
            applicationsOpen: false
        });

    } catch (error) {
        console.error("Recruitment database check failed:", error);

        return json({
            success: false,
            message: "Service unavailable."
        }, 503);
    }
}

export async function onRequestPost() {
    return json({
        success: false,
        message: "Portfolio submissions are not currently open."
    }, 503);
}
