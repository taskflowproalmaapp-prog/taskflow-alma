// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "feedback" — Uso de la app y sugerencias de mejora
// ────────────────────────────────────────────────────────────────
//  Para TODOS (con sesión):
//   - "track": suma cuántas veces usó cada función (SOLO conteos, nunca
//     contenido de tareas ni documentos). Una "caja" por persona y mes.
//   - "submitFeedback": guarda una sugerencia conversada con Alma.
//   - "myFeedback": la persona ve sus propias sugerencias y su estado.
//  Solo ADMIN (ADMIN_USERNAME en Netlify, igual que en auth.js):
//   - "adminOverview": uso por persona y mes + todas las sugerencias.
//   - "setFeedbackStatus": marcar una sugerencia (en revisión, hecho…).
// ────────────────────────────────────────────────────────────────

const crypto = require("crypto");
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
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
const monthOf = (d) => (d || new Date()).toISOString().slice(0, 7);          // "2026-10"
const KEY_RE = /^[a-z0-9_.-]{1,40}$/;
const TIPOS = ["idea", "mejora", "problema", "elogio", "otro"];
const ESTADOS = ["nuevo", "en revision", "planificado", "hecho", "descartado"];

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Cuerpo inválido" }); }

  const { action, token } = body;
  if (!token) return json(401, { error: "Falta token de sesión" });

  try {
    const rec = await store("sessions").get(token, { type: "json" });
    if (!rec || !rec.username) return json(401, { error: "Sesión inválida o expirada" });
    const username = rec.username;
    const adminUser = (process.env.ADMIN_USERNAME || "").trim().toLowerCase();
    const isAdmin = !!adminUser && username === adminUser;

    const usage = store("usage");
    const feedback = store("feedback");

    // ── Conteo de uso (solo números) ──
    if (action === "track") {
      const counts = body.counts && typeof body.counts === "object" ? body.counts : {};
      const keys = Object.keys(counts).filter((k) => KEY_RE.test(k)).slice(0, 60);
      if (!keys.length) return json(200, { ok: true });
      const now = new Date();
      const key = `${monthOf(now)}:${username}`;
      const cur = (await usage.get(key, { type: "json" })) || { counts: {}, days: {} };
      keys.forEach((k) => {
        const n = Math.max(0, Math.min(500, parseInt(counts[k], 10) || 0));
        if (n) cur.counts[k] = (cur.counts[k] || 0) + n;
      });
      cur.days[now.toISOString().slice(8, 10)] = 1;
      cur.lastSeen = now.toISOString();
      await usage.set(key, JSON.stringify(cur));
      return json(200, { ok: true });
    }

    // ── Enviar una sugerencia ──
    if (action === "submitFeedback") {
      const it = body.item || {};
      const titulo = clip(it.titulo, 120).trim();
      const detalle = clip(it.detalle, 2000).trim();
      if (!titulo && !detalle) return json(400, { error: "La sugerencia está vacía" });
      // máximo 10 por persona al día
      const today = new Date().toISOString().slice(0, 10);
      const limKey = `limit:${today}:${username}`;
      const used = parseInt((await feedback.get(limKey)) || "0", 10) || 0;
      if (used >= 10) return json(429, { error: "Ya enviaste 10 sugerencias hoy. ¡Gracias! Vuelve mañana." });
      const id = `fb:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`;
      const conv = (Array.isArray(it.conversacion) ? it.conversacion : []).slice(0, 14)
        .map((m) => ({ role: m && m.role === "alma" ? "alma" : "usuario", text: clip(m && m.text, 1000) }));
      const item = {
        id, username, createdAt: new Date().toISOString(), status: "nuevo",
        tipo: TIPOS.includes(it.tipo) ? it.tipo : "otro",
        area: clip(it.area, 60), titulo: titulo || clip(detalle, 80), detalle,
        impacto: ["alto", "medio", "bajo"].includes(it.impacto) ? it.impacto : "medio",
        conversacion: conv,
      };
      await feedback.set(id, JSON.stringify(item));
      await feedback.set(limKey, String(used + 1));
      return json(200, { ok: true, id });
    }

    // ── Mis sugerencias (solo las propias) ──
    if (action === "myFeedback") {
      const out = [];
      const listing = await feedback.list({ prefix: "fb:" });
      for (const e of (listing.blobs || []).slice(-300)) {
        const it = await feedback.get(e.key, { type: "json" });
        if (it && it.username === username) out.push({ id: it.id, titulo: it.titulo, tipo: it.tipo, status: it.status, createdAt: it.createdAt });
      }
      out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return json(200, { items: out.slice(0, 50) });
    }

    // ── Desde aquí: solo admin ──
    if (!isAdmin) return json(403, { error: "No tienes permiso para ver esto" });

    if (action === "adminOverview") {
      const month = /^\d{4}-\d{2}$/.test(body.month || "") ? body.month : monthOf();
      const people = [];
      const ul = await usage.list({ prefix: month + ":" });
      for (const e of ul.blobs || []) {
        const u = await usage.get(e.key, { type: "json" });
        if (u) people.push({ username: e.key.slice(8), counts: u.counts || {}, activeDays: Object.keys(u.days || {}).length, lastSeen: u.lastSeen || "" });
      }
      const items = [];
      const fl = await feedback.list({ prefix: "fb:" });
      for (const e of (fl.blobs || []).slice(-300)) {
        const it = await feedback.get(e.key, { type: "json" });
        if (it) items.push(it);
      }
      items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      // total de cuentas registradas (para "activos de X")
      let totalUsers = null;
      try { const all = await store("users").list(); totalUsers = (all.blobs || []).length; } catch (e) {}
      return json(200, { month, people, feedback: items, totalUsers });
    }

    if (action === "setFeedbackStatus") {
      const id = String(body.id || "");
      if (!id.startsWith("fb:")) return json(400, { error: "Falta la sugerencia" });
      if (!ESTADOS.includes(body.status)) return json(400, { error: "Estado no válido" });
      const it = await feedback.get(id, { type: "json" });
      if (!it) return json(404, { error: "Esa sugerencia ya no existe" });
      it.status = body.status; it.statusAt = new Date().toISOString();
      await feedback.set(id, JSON.stringify(it));
      return json(200, { ok: true });
    }

    return json(400, { error: "Acción no reconocida" });
  } catch (err) {
    return json(500, { error: "Error interno: " + err.message });
  }
};
