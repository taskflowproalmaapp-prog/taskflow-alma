// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "send-doc" — Envía por correo un documento de Alma Brainstorm
// ────────────────────────────────────────────────────────────────
//  Seguridad:
//   - Solo personas con sesión iniciada (mismo token que data.js).
//   - El correo lo ARMA ESTA FUNCIÓN a partir del contenido del documento
//     (todo escapado). No acepta HTML desde afuera: así nadie puede usar tu
//     Gmail para mandar correos falsos o spam con tu nombre.
//   - Máx. 5 destinatarios por envío y SEND_DOC_DAILY_LIMIT envíos por
//     persona al día (por defecto 20).
//  Usa la misma cuenta de Gmail que el resumen semanal
//  (GMAIL_USER / GMAIL_APP_PASSWORD en Netlify).
// ────────────────────────────────────────────────────────────────

const nodemailer = require("nodemailer");
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

// Una sesión vence tras SESSION_DAYS días (por defecto 90) sin usarse —
// misma regla que en auth.js (allí se renueva cada vez que se abre la app).
const SESSION_MS = (parseInt(process.env.SESSION_DAYS || "90", 10) || 90) * 24 * 3600 * 1000;
function sessionExpired(rec) {
  const last = Date.parse((rec && rec.lastSeenAt) || ""); // sin fecha = sesión anterior a esta regla: vigente
  return !!last && Date.now() - last > SESSION_MS;
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
const list = (arr, n, len) => (Array.isArray(arr) ? arr : []).slice(0, n).map((x) => clip(x, len));

function buildHtml(doc, senderName) {
  const sec = (title, arr) => arr.length
    ? `<h2 style="font-size:14px;color:#ED3F7C;text-transform:uppercase;letter-spacing:.5px;margin:22px 0 6px;">${esc(title)}</h2>
       <ul style="margin:0;padding-left:18px;">${arr.map((x) => `<li style="margin:4px 0;">${esc(x)}</li>`).join("")}</ul>` : "";
  const actions = doc.actions.length
    ? `<h2 style="font-size:14px;color:#ED3F7C;text-transform:uppercase;letter-spacing:.5px;margin:22px 0 6px;">Tareas y responsables</h2>
       <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px;">
       <tr><th align="left" style="padding:6px 4px;border-bottom:2px solid #f0e6ea;">Tarea</th><th align="left" style="padding:6px 4px;border-bottom:2px solid #f0e6ea;">Responsable</th><th align="left" style="padding:6px 4px;border-bottom:2px solid #f0e6ea;">Plazo</th></tr>
       ${doc.actions.map((a) => `<tr><td style="padding:6px 4px;border-bottom:1px solid #f3eef0;">${esc(a.title)}</td><td style="padding:6px 4px;border-bottom:1px solid #f3eef0;">${esc(a.owner || "—")}</td><td style="padding:6px 4px;border-bottom:1px solid #f3eef0;">${esc(a.due || "—")}</td></tr>`).join("")}
       </table>` : "";
  return `<!DOCTYPE html><html><body style="margin:0;background:#F8F4F1;font-family:Arial,Helvetica,sans-serif;color:#2B1B2E;">
  <div style="max-width:640px;margin:0 auto;padding:24px 16px;">
    <div style="background:linear-gradient(125deg,#FF6B45 0%,#ED3F7C 52%,#8157EF 100%);background-color:#ED3F7C;border-radius:16px;padding:22px 24px;color:#fff;">
      <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;font-weight:bold;">Alma Brainstorm · TaskFlow Pro</div>
      <div style="font-size:22px;font-weight:bold;margin-top:6px;">${esc(doc.title || "Lluvia de ideas")}</div>
      <div style="font-size:13px;margin-top:4px;opacity:.95;">${esc(doc.date)}${senderName ? ` · Enviado por ${esc(senderName)}` : ""}</div>
    </div>
    <div style="background:#fff;border-radius:16px;padding:20px 24px;margin-top:12px;font-size:14px;line-height:1.55;">
      ${doc.summary ? `<h2 style="font-size:14px;color:#ED3F7C;text-transform:uppercase;letter-spacing:.5px;margin:0 0 6px;">Resumen</h2><p style="margin:0;">${esc(doc.summary)}</p>` : ""}
      ${doc.context ? `<h2 style="font-size:14px;color:#ED3F7C;text-transform:uppercase;letter-spacing:.5px;margin:22px 0 6px;">Contexto</h2><p style="margin:0;">${esc(doc.context)}</p>` : ""}
      ${doc.topics.length ? `<h2 style="font-size:14px;color:#ED3F7C;text-transform:uppercase;letter-spacing:.5px;margin:22px 0 6px;">Temas tratados</h2>${doc.topics.map((t) => `<div style="margin:10px 0;"><b>${esc(t.title)}</b>${t.detail ? `<p style="margin:4px 0;">${esc(t.detail)}</p>` : ""}${t.points.length ? `<ul style="margin:0;padding-left:18px;">${t.points.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</div>`).join("")}` : ""}
      ${doc.figures.length ? `<h2 style="font-size:14px;color:#ED3F7C;text-transform:uppercase;letter-spacing:.5px;margin:22px 0 6px;">Cifras y datos clave</h2><table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:14px;"><tr><th align="left" style="padding:6px 4px;border-bottom:2px solid #f0e6ea;">Dato</th><th align="left" style="padding:6px 4px;border-bottom:2px solid #f0e6ea;">Valor</th><th align="left" style="padding:6px 4px;border-bottom:2px solid #f0e6ea;">A qué corresponde</th></tr>${doc.figures.map((f) => `<tr><td style="padding:6px 4px;border-bottom:1px solid #f3eef0;">${esc(f.dato)}</td><td style="padding:6px 4px;border-bottom:1px solid #f3eef0;"><b>${esc(f.valor)}</b></td><td style="padding:6px 4px;border-bottom:1px solid #f3eef0;">${esc(f.contexto)}${f.quien ? ` — ${esc(f.quien)}` : ""}</td></tr>`).join("")}</table>` : ""}
      ${sec("Ideas clave", doc.ideas)}${sec("Decisiones", doc.decisions)}${actions}${sec("Puntos abiertos", doc.openPoints)}${sec("Riesgos", doc.risks)}${sec("Próximos pasos", doc.nextSteps)}
      ${doc.transcript ? `<h2 style="font-size:14px;color:#ED3F7C;text-transform:uppercase;letter-spacing:.5px;margin:22px 0 6px;">Transcripción</h2><div style="white-space:pre-wrap;font-size:13px;color:#555;">${esc(doc.transcript)}</div>` : ""}
    </div>
    <div style="font-size:11px;color:#9a8a9c;text-align:center;margin-top:14px;">Documento generado con IA a partir de una conversación. Revisa los datos importantes antes de actuar.</div>
  </div></body></html>`;
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "Cuerpo de la petición inválido" }); }

  // 1) Sesión
  const { token } = body;
  if (!token) return json(401, { error: "Falta token de sesión" });
  let username;
  try {
    const rec = await store("sessions").get(token, { type: "json" });
    if (!rec || !rec.username || sessionExpired(rec)) return json(401, { error: "Sesión inválida o expirada, vuelve a iniciar sesión" });
    username = rec.username;
  } catch (e) { return json(500, { error: "No se pudo validar la sesión: " + e.message }); }

  // 2) Destinatarios
  const to = (Array.isArray(body.to) ? body.to : []).map((x) => String(x).trim()).filter(Boolean);
  if (!to.length) return json(400, { error: "Falta al menos un destinatario" });
  if (to.length > 5) return json(400, { error: "Máximo 5 destinatarios por envío" });
  const bad = to.find((x) => !EMAIL_RE.test(x));
  if (bad) return json(400, { error: "Correo inválido: " + bad });

  // 3) Límite diario por persona
  const limit = parseInt(process.env.SEND_DOC_DAILY_LIMIT || "20", 10);
  const usage = store("send_doc_usage");
  const key = `${username}:${new Date().toISOString().slice(0, 10)}`;
  let used = 0;
  try {
    used = parseInt((await usage.get(key)) || "0", 10) || 0;
    if (used >= limit) return json(429, { error: `Llegaste al límite de ${limit} envíos por hoy.` });
  } catch (e) { console.error("send_doc_usage:", e.message); }

  // 4) Contenido (recortado y escapado: nunca se acepta HTML de afuera)
  const d = body.doc || {};
  const doc = {
    title: clip(d.title, 120), date: clip(d.date, 80), summary: clip(d.summary, 5000), context: clip(d.context, 1500),
    topics: (Array.isArray(d.topics) ? d.topics : []).slice(0, 20).map((t) => ({ title: clip(t && t.title, 140), detail: clip(t && t.detail, 1500), points: list(t && t.points, 10, 300) })),
    figures: (Array.isArray(d.figures) ? d.figures : []).slice(0, 40).map((f) => ({ dato: clip(f && f.dato, 140), valor: clip(f && f.valor, 80), contexto: clip(f && f.contexto, 300), quien: clip(f && f.quien, 80) })),
    openPoints: list(d.openPoints, 15, 400), risks: list(d.risks, 10, 400),
    ideas: list(d.ideas, 15, 400), decisions: list(d.decisions, 15, 400), nextSteps: list(d.nextSteps, 10, 400),
    actions: (Array.isArray(d.actions) ? d.actions : []).slice(0, 25).map((a) => ({ title: clip(a && a.title, 200), owner: clip(a && a.owner, 80), due: clip(a && a.due, 20) })),
    transcript: clip(d.transcript, 150000),
  };
  if (!doc.summary && !doc.ideas.length && !doc.actions.length && !doc.topics.length) return json(400, { error: "El documento está vacío" });
  const subject = clip(body.subject || ("Resumen: " + (doc.title || "Lluvia de ideas")), 150).replace(/[\r\n]+/g, " ");

  // 5) Quién envía (para el "responder a") — desde sus propios datos
  let senderName = username, replyTo;
  try {
    const data = await store("userdata").get(username, { type: "json" });
    const cfg = (data && data.config) || {};
    if (cfg.userName) senderName = clip(cfg.userName, 60);
    if (cfg.userEmail && EMAIL_RE.test(cfg.userEmail)) replyTo = cfg.userEmail;
  } catch (e) { /* sin datos extra: se envía igual */ }

  // 6) Enviar
  const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return json(500, { error: "Falta configurar GMAIL_USER / GMAIL_APP_PASSWORD en Netlify" });
  try {
    const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
    await transporter.sendMail({
      from: `"${senderName.replace(/["\r\n]/g, "")} vía TaskFlow Pro" <${user}>`,
      to: to.join(", "),
      replyTo,
      subject,
      html: buildHtml(doc, senderName),
    });
    try { await usage.set(key, String(used + 1)); } catch (e) { /* no bloquea */ }
    return json(200, { ok: true, sentTo: to });
  } catch (e) {
    return json(500, { error: "No se pudo enviar el correo: " + e.message });
  }
};
