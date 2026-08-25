// ────────────────────────────────────────────────────────────────
//  Ayudante compartido — usado por las funciones de Google Calendar
//  para obtener un access_token válido (renovándolo solo si ya venció).
// ────────────────────────────────────────────────────────────────

const { getStore } = require("@netlify/blobs");

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}

async function getUsernameFromSession(sessionToken) {
  if (!sessionToken) return null;
  const sessions = store("sessions");
  const rec = await sessions.get(sessionToken, { type: "json" });
  return rec ? rec.username : null;
}

// Devuelve un access_token válido para esa persona (lo renueva solo si ya
// venció), o null si nunca conectó su calendario.
async function getValidGoogleAccessToken(username) {
  const calTokens = store("google_calendar_tokens");
  const rec = await calTokens.get(username, { type: "json" });
  if (!rec) return null;

  if (rec.access_token && rec.expires_at && rec.expires_at > Date.now() + 60000) {
    return rec.access_token; // todavía es válido
  }
  if (!rec.refresh_token) return null; // no se puede renovar, tendrá que reconectar

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: rec.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    console.error("No se pudo renovar el token de Google:", data);
    return null;
  }
  const updated = {
    ...rec,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
  await calTokens.set(username, JSON.stringify(updated));
  return data.access_token;
}

async function isGoogleCalendarConnected(username) {
  const calTokens = store("google_calendar_tokens");
  const rec = await calTokens.get(username, { type: "json" });
  return !!(rec && rec.refresh_token);
}

async function disconnectGoogleCalendar(username) {
  const calTokens = store("google_calendar_tokens");
  await calTokens.delete(username);
}

module.exports = { store, getUsernameFromSession, getValidGoogleAccessToken, isGoogleCalendarConnected, disconnectGoogleCalendar };
