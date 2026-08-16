// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "data" — Guarda y lee los datos privados de cada usuario
// ────────────────────────────────────────────────────────────────
//  Cada persona tiene su propio espacio en Netlify Blobs, identificado
//  por su nombre de usuario. Solo se puede leer/escribir si el token
//  de sesión enviado es válido (se valida contra la función "auth").
// ────────────────────────────────────────────────────────────────

const { getStore } = require("@netlify/blobs");

// Igual que en auth.js: si Netlify no configura Blobs solo dentro de esta función,
// nos conectamos manualmente con NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN.
function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name, siteID, token });
  }
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

  const { action, token, data } = body;
  if (!token) return json(401, { error: "Falta token de sesión" });

  try {
    const sessions = store("sessions");
    const rec = await sessions.get(token, { type: "json" });
    if (!rec) return json(401, { error: "Sesión inválida o expirada, vuelve a iniciar sesión" });
    const username = rec.username;
    const userdata = store("userdata");

    if (action === "get") {
      const stored = await userdata.get(username, { type: "json" });
      return json(200, { data: stored || null });
    }

    if (action === "save") {
      if (typeof data === "undefined") return json(400, { error: "Falta el contenido a guardar" });
      await userdata.set(username, JSON.stringify(data));
      return json(200, { ok: true });
    }

    return json(400, { error: "Acción no reconocida" });
  } catch (err) {
    return json(500, { error: "Error interno: " + err.message });
  }
};
