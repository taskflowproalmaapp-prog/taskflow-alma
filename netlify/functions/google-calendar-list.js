// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "google-calendar-list" — Devuelve si la persona conectó su
//  Google Calendar, y en tal caso, la lista de sus calendarios (para
//  que elija cuál es "trabajo" y cuál "personal").
// ────────────────────────────────────────────────────────────────

const { getUsernameFromSession, getValidGoogleAccessToken, isGoogleCalendarConnected, disconnectGoogleCalendar } = require("./google-helpers");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Cuerpo inválido" }); }
  const { action, token } = body;

  try {
    const username = await getUsernameFromSession(token);
    if (!username) return json(401, { error: "Sesión inválida" });

    if (action === "status") {
      const connected = await isGoogleCalendarConnected(username);
      return json(200, { connected });
    }

    if (action === "disconnect") {
      await disconnectGoogleCalendar(username);
      return json(200, { ok: true });
    }

    if (action === "list") {
      const accessToken = await getValidGoogleAccessToken(username);
      if (!accessToken) return json(200, { connected: false, calendars: [] });

      const resp = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await resp.json();
      if (!resp.ok) return json(500, { error: data.error?.message || "No se pudo leer tus calendarios" });

      const calendars = (data.items || []).map((c) => ({
        id: c.id, summary: c.summary, primary: !!c.primary, backgroundColor: c.backgroundColor || "",
      }));
      return json(200, { connected: true, calendars });
    }

    return json(400, { error: "Acción no reconocida" });
  } catch (err) {
    return json(500, { error: "Error interno: " + err.message });
  }
};
