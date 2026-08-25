// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "google-oauth-callback" — Google redirige aquí después de
//  que la persona autoriza el acceso a su calendario. Cambiamos el
//  "code" que manda Google por un access_token + refresh_token, y
//  los guardamos (asociados a esa persona) para usarlos después.
// ────────────────────────────────────────────────────────────────

const { getStore } = require("@netlify/blobs");

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}

const REDIRECT_URI = "https://taskflow-alma.netlify.app/.netlify/functions/google-oauth-callback";

function redirectTo(path) {
  return {
    statusCode: 302,
    headers: { Location: `https://taskflow-alma.netlify.app${path}` },
    body: "",
  };
}

exports.handler = async function (event) {
  const params = event.queryStringParameters || {};
  const { code, state, error: googleError } = params;

  if (googleError) {
    return redirectTo(`/?calendar=error&reason=${encodeURIComponent(googleError)}`);
  }
  if (!code || !state) {
    return redirectTo("/?calendar=error&reason=faltan_datos");
  }

  try {
    const sessions = store("sessions");
    const sessionRec = await sessions.get(state, { type: "json" });
    if (!sessionRec) {
      return redirectTo("/?calendar=error&reason=sesion_invalida");
    }
    const username = sessionRec.username;

    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) {
      console.error("Error al obtener tokens de Google:", tokenData);
      return redirectTo("/?calendar=error&reason=token");
    }

    const calTokens = store("google_calendar_tokens");
    const existing = (await calTokens.get(username, { type: "json" })) || {};
    await calTokens.set(username, JSON.stringify({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || existing.refresh_token, // Google solo manda refresh_token la primera vez
      expires_at: Date.now() + (tokenData.expires_in || 3600) * 1000,
      connectedAt: existing.connectedAt || new Date().toISOString(),
    }));

    return redirectTo("/?calendar=connected");
  } catch (err) {
    console.error("Error en google-oauth-callback:", err.message);
    return redirectTo("/?calendar=error&reason=interno");
  }
};
