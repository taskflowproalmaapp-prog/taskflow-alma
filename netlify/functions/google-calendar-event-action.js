// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "google-calendar-event-action" — Crea, edita o cancela un
//  evento de Google Calendar, directo desde TaskFlow (sin tener que
//  abrir Google Calendar aparte).
//
//  "create": se usa cuando el usuario agenda una tarea de TaskFlow con
//  día y hora — le crea automáticamente el evento reflejo en su Google
//  Calendar real, y devuelve el eventId para poder editarlo/borrarlo
//  después si la tarea se reagenda o se elimina.
// ────────────────────────────────────────────────────────────────

const { getUsernameFromSession, getValidGoogleAccessToken } = require("./google-helpers");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Cuerpo inválido" }); }
  const { action, token, calendarId, eventId, summary, description, startIso, endIso } = body;

  try {
    const username = await getUsernameFromSession(token);
    if (!username) return json(401, { error: "Sesión inválida" });

    const accessToken = await getValidGoogleAccessToken(username);
    if (!accessToken) return json(200, { connected: false });

    if (action === "create") {
      if (!startIso || !endIso) return json(400, { error: "Falta la fecha/hora de la tarea" });
      // Si no se especifica un calendario, usamos el calendario principal
      // (primary) de la persona — el mismo donde caen sus propias reuniones.
      const calId = calendarId || "primary";
      const createUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;
      const resp = await fetch(createUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          summary: summary || "Tarea de TaskFlow Pro",
          description: description || "",
          start: { dateTime: startIso },
          end: { dateTime: endIso },
          extendedProperties: { private: { taskflowOrigin: "true" } },
        }),
      });
      const data = await resp.json();
      if (!resp.ok) return json(500, { error: data.error?.message || "No se pudo crear el evento" });
      return json(200, { ok: true, eventId: data.id, calendarId: calId });
    }

    if (!calendarId || !eventId) return json(400, { error: "Falta identificar la reunión" });

    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;

    if (action === "delete") {
      const resp = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } });
      // 404/410: la persona ya lo había borrado a mano en Google Calendar —
      // el resultado que queríamos (que no exista) ya se cumple, así que no
      // es un error real para quien llamó a esta función (p.ej. al borrar
      // una tarea de TaskFlow).
      if (resp.status !== 204 && resp.status !== 200 && resp.status !== 404 && resp.status !== 410) {
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
