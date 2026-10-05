// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "files" — Archivos adjuntos de las tareas (fotos, PDF, Office)
// ────────────────────────────────────────────────────────────────
//  Los archivos se guardan APARTE de los datos de la persona (antes iban
//  dentro, como texto, y hacían pesado cada guardado). La tarea solo guarda
//  nombre, tamaño y tipo.
//  Seguridad:
//   - Solo con sesión válida (misma regla que data.js, incluido el vencimiento).
//   - La clave de cada archivo la arma ESTA función: "usuario/idArchivo". Nadie
//     puede leer, subir ni borrar archivos de otra cuenta.
//   - Tipos permitidos: imágenes, PDF, Word, Excel, PowerPoint, texto y CSV.
//   - Máx. 4 MB por archivo (límite de Netlify por llamada) y una cuota por
//     persona (FILES_QUOTA_MB, por defecto 100 MB).
//  Acciones: upload, download, usage, reconcile (borra archivos que ya no usa
//  ninguna tarea, con un margen de 1 hora para no tocar subidas recientes).
// ────────────────────────────────────────────────────────────────

const { getStore } = require("@netlify/blobs");

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}
function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
const SESSION_MS = (parseInt(process.env.SESSION_DAYS || "90", 10) || 90) * 24 * 3600 * 1000;
function sessionExpired(rec) {
  const last = Date.parse((rec && rec.lastSeenAt) || "");
  return !!last && Date.now() - last > SESSION_MS;
}

const MAX_BYTES = 4 * 1024 * 1024;
const QUOTA = (parseInt(process.env.FILES_QUOTA_MB || "100", 10) || 100) * 1024 * 1024;
const GRACE_MS = 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const TYPES = /^(image\/(png|jpeg|jpg|webp|gif|heic|heif)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|application\/vnd\.ms-excel|application\/vnd\.ms-powerpoint|text\/plain|text\/csv)$/i;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Cuerpo inválido" }); }
  const { action, token } = body;
  if (!token) return json(401, { error: "Falta token de sesión" });

  try {
    const rec = await store("sessions").get(token, { type: "json" });
    if (!rec || !rec.username || sessionExpired(rec)) return json(401, { error: "Sesión inválida o expirada, vuelve a iniciar sesión" });
    const username = rec.username;
    const files = store("attachments");
    const idx = store("attachments_index");
    const readIndex = async () => (await idx.get(username, { type: "json" })) || { files: {} };
    const used = (ix) => Object.values(ix.files).reduce((a, f) => a + (f.size || 0), 0);

    if (action === "usage") {
      const ix = await readIndex();
      return json(200, { used: used(ix), quota: QUOTA, count: Object.keys(ix.files).length });
    }

    if (action === "upload") {
      const id = String(body.fileId || "");
      if (!ID_RE.test(id)) return json(400, { error: "Identificador de archivo inválido" });
      const type = String(body.type || "").toLowerCase().split(";")[0];
      if (!TYPES.test(type)) return json(415, { error: "Ese tipo de archivo no se puede adjuntar. Usa imágenes, PDF, Word, Excel, PowerPoint o texto." });
      const data = String(body.data || "");
      if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) return json(400, { error: "Archivo vacío o dañado" });
      const buf = Buffer.from(data, "base64");
      if (!buf.length) return json(400, { error: "Archivo vacío" });
      if (buf.length > MAX_BYTES) return json(413, { error: "El archivo pesa más de 4 MB." });
      const ix = await readIndex();
      if (ix.files[id]) return json(200, { ok: true, file: Object.assign({ id }, ix.files[id]), used: used(ix), quota: QUOTA }); // reintento: no duplica
      if (used(ix) + buf.length > QUOTA) return json(413, { error: `Llegaste al límite de ${Math.round(QUOTA / 1048576)} MB de archivos. Quita adjuntos que ya no necesites.` });
      await files.set(`${username}/${id}`, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
      const meta = { name: String(body.name || "archivo").slice(0, 160), type, size: buf.length, uploadedAt: new Date().toISOString() };
      ix.files[id] = meta;
      await idx.set(username, JSON.stringify(ix));
      return json(200, { ok: true, file: Object.assign({ id }, meta), used: used(ix), quota: QUOTA });
    }

    if (action === "download") {
      const id = String(body.fileId || "");
      if (!ID_RE.test(id)) return json(400, { error: "Identificador de archivo inválido" });
      const ab = await files.get(`${username}/${id}`, { type: "arrayBuffer" });
      if (!ab) return json(404, { error: "Ese archivo ya no existe" });
      const ix = await readIndex();
      const meta = ix.files[id] || {};
      return json(200, { name: meta.name || "archivo", type: meta.type || "application/octet-stream", data: Buffer.from(ab).toString("base64") });
    }

    if (action === "reconcile") {
      // ids que todavía usa alguna tarea (incluida la papelera); el resto se borra
      const keep = new Set((Array.isArray(body.keep) ? body.keep : []).map(String));
      const ix = await readIndex();
      let removed = 0;
      const l = await files.list({ prefix: `${username}/` });
      for (const e of l.blobs || []) {
        const id = e.key.slice(username.length + 1);
        if (keep.has(id)) continue;
        const meta = ix.files[id];
        if (!meta) continue;                                                  // sin datos: no se toca
        if (Date.now() - Date.parse(meta.uploadedAt || 0) < GRACE_MS) continue; // subido hace poco (ventana abierta)
        await files.delete(e.key);
        delete ix.files[id];
        removed++;
      }
      if (removed) await idx.set(username, JSON.stringify(ix));
      return json(200, { ok: true, removed, used: used(ix), quota: QUOTA });
    }

    return json(400, { error: "Acción no reconocida" });
  } catch (err) {
    return json(500, { error: "Error interno: " + err.message });
  }
};
