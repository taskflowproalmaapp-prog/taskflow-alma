// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "google-calendar-event-action" — Edita o cancela una
//  reunión REAL de Google Calendar, directo desde TaskFlow (sin
//  tener que abrir Google Calendar aparte).
// ────────────────────────────────────────────────────────────────

const { getUsernameFromSession, getValidGoogleAccessToken } = require("./google-helpers");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Cuerpo inválido" }); }
  const { action, token, calendarId, eventId, summary, startIso, endIso } = body;

  try {
    const username = await getUsernameFromSession(token);
    if (!username) return json(401, { error: "Sesión inválida" });
    if (!calendarId || !eventId) return json(400, { error: "Falta identificar la reunión" });

    const accessToken = await getValidGoogleAccessToken(username);
    if (!accessToken) return json(200, { connected: false });

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

    if (action === "delete") {
      const resp = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
      if (resp.status !== 204 && resp.status !== 200) {
        const d = await resp.json().catch(() => ({}));
        return json(500, { error: d.error?.message || "No se pudo cancelar la reunión" });
      }
      return json(200, { ok: true });
    }

    if (action === "update") {
      const patchBody = {};
      if (summary) patchBody.summary = summary;
      if (startIso) patchBody.start = { dateTime: startIso };
      if (endIso) patchBody.end = { dateTime: endIso };
      const resp = await fetch(url, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      const data = await resp.json();
      if (!resp.ok) return json(500, { error: data.error?.message || "No se pudo editar la reunión" });
      return json(200, { ok: true });
    }

    return json(400, { error: "Acción no reconocida" });
  } catch (err) {
    return json(500, { error: "Error interno: " + err.message });
  }
};
