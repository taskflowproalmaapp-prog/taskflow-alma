// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "data" — Guarda y lee los datos privados de cada usuario
// ────────────────────────────────────────────────────────────────
//  Cada persona tiene su propio espacio en Netlify Blobs, identificado
//  por su nombre de usuario. Cada guardado sube un número de versión
//  ("rev"): si otro dispositivo guardó entremedio, el servidor no pisa
//  esos datos (responde 409) y la app combina los cambios antes de guardar. Solo se puede leer/escribir si el token
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

// Una sesión vence tras SESSION_DAYS días (por defecto 90) sin usarse —
// misma regla que en auth.js (allí se renueva cada vez que se abre la app).
const SESSION_MS = (parseInt(process.env.SESSION_DAYS || "90", 10) || 90) * 24 * 3600 * 1000;
function sessionExpired(rec) {
  const last = Date.parse((rec && rec.lastSeenAt) || ""); // sin fecha = sesión anterior a esta regla: vigente
  return !!last && Date.now() - last > SESSION_MS;
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
    if (!rec || sessionExpired(rec)) return json(401, { error: "Sesión inválida o expirada, vuelve a iniciar sesión" });
    const username = rec.username;
    const userdata = store("userdata");

    // Número de versión ("rev") por persona, en un espacio aparte: así el
    // formato de los datos guardados no cambia y las versiones antiguas de la
    // app siguen funcionando durante la transición.
    const revs = store("userdata_rev");
    const readRev = async () => {
      const r = await revs.get(username, { type: "json" });
      return (r && typeof r.rev === "number") ? r.rev : 0;
    };

    if (action === "get") {
      const stored = await userdata.get(username, { type: "json" });
      return json(200, { data: stored || null, rev: await readRev() });
    }

    if (action === "save") {
      if (typeof data === "undefined") return json(400, { error: "Falta el contenido a guardar" });
      const current = await readRev();
      // Si la app dice "partí de la versión X" y en el servidor ya hay otra,
      // es que otro dispositivo guardó entremedio: NO se pisa. Se devuelven
      // los datos actuales para que la app combine los cambios y reintente.
      if (typeof body.baseRev === "number" && body.baseRev !== current) {
        const latest = await userdata.get(username, { type: "json" });
        return json(409, { error: "conflict", rev: current, data: latest || null });
      }
      await userdata.set(username, JSON.stringify(data));
      const next = current + 1;
      await revs.set(username, JSON.stringify({ rev: next, updatedAt: new Date().toISOString() }));
      return json(200, { ok: true, rev: next });
    }

    return json(400, { error: "Acción no reconocida" });
  } catch (err) {
    return json(500, { error: "Error interno: " + err.message });
  }
};
