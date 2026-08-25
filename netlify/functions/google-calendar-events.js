// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "google-calendar-events" — Trae los eventos de Google
//  Calendar de una persona, para un día (o rango) específico, de
//  todos sus calendarios (o solo los que indique).
// ────────────────────────────────────────────────────────────────

const { getUsernameFromSession, getValidGoogleAccessToken } = require("./google-helpers");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

// Intenta encontrar un link de videollamada (Meet, Zoom, etc.) en el evento.
function extractJoinLink(ev) {
  if (ev.hangoutLink) return ev.hangoutLink;
  if (ev.conferenceData && ev.conferenceData.entryPoints) {
    const video = ev.conferenceData.entryPoints.find((e) => e.entryPointType === "video");
    if (video) return video.uri;
  }
  const text = `${ev.location || ""} ${ev.description || ""}`;
  const match = text.match(/https?:\/\/[^\s<>"]+/);
  return match ? match[0] : null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Cuerpo inválido" }); }
  const { token, timeMin, timeMax, calendarIds } = body;

  try {
    const username = await getUsernameFromSession(token);
    if (!username) return json(401, { error: "Sesión inválida" });

    const accessToken = await getValidGoogleAccessToken(username);
    if (!accessToken) return json(200, { connected: false, events: [] });

    if (!timeMin || !timeMax) return json(400, { error: "Falta el rango de fechas" });

    let calIds = calendarIds;
    if (!Array.isArray(calIds) || !calIds.length) {
      const listResp = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const listData = await listResp.json();
      calIds = (listData.items || []).map((c) => c.id);
    }

    const allEvents = [];
    for (const calId of calIds) {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`);
      url.searchParams.set("timeMin", timeMin);
      url.searchParams.set("timeMax", timeMax);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("maxResults", "50");
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!resp.ok) continue; // si un calendario falla, seguimos con los demás
      const data = await resp.json();
      (data.items || []).forEach((ev) => {
        if (ev.status === "cancelled") return;
        allEvents.push({
          id: ev.id,
          calendarId: calId,
          title: ev.summary || "(Sin título)",
          start: ev.start?.dateTime || ev.start?.date || null,
          end: ev.end?.dateTime || ev.end?.date || null,
          allDay: !ev.start?.dateTime,
          location: ev.location || "",
          joinLink: extractJoinLink(ev),
          htmlLink: ev.htmlLink || null,
        });
      });
    }
    allEvents.sort((a, b) => (a.start || "").localeCompare(b.start || ""));

    return json(200, { connected: true, events: allEvents });
  } catch (err) {
    return json(500, { error: "Error interno: " + err.message });
  }
};
