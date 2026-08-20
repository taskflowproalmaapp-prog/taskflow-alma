// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "push-subscribe" — Guarda o borra la suscripción de
//  notificaciones push de cada usuario (a qué "buzón" del navegador
//  hay que mandarle los avisos).
// ────────────────────────────────────────────────────────────────

const { getStore } = require("@netlify/blobs");

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Método no permitido" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Cuerpo de la petición inválido" });
  }

  const { action, token, subscription } = body;
  if (!token) return json(401, { error: "Falta token de sesión" });

  try {
    const sessions = store("sessions");
    const rec = await sessions.get(token, { type: "json" });
    if (!rec) return json(401, { error: "Sesión inválida o expirada" });
    const username = rec.username;
    const pushSubs = store("push_subscriptions");

    if (action === "subscribe") {
      if (!subscription || !subscription.endpoint) return json(400, { error: "Falta la suscripción" });
      await pushSubs.set(username, JSON.stringify(subscription));
      return json(200, { ok: true });
    }

    if (action === "unsubscribe") {
      await pushSubs.delete(username);
      return json(200, { ok: true });
    }

    return json(400, { error: "Acción no reconocida" });
  } catch (err) {
    return json(500, { error: "Error interno: " + err.message });
  }
};
