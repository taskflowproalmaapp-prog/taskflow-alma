// ────────────────────────────────────────────────────────────────
//  FUNCIÓN PROGRAMADA "send-weekly-report" — corre sola, una vez a
//  la semana (ver netlify.toml). Le manda a cada persona que activó
//  "🌱 Resumen semanal" en Configuración un correo con cómo le fue
//  esta semana: cuánto completó, qué quedó atascado en "Parcial"
//  más de una vez, y cuánto tiene atrasado ahora mismo.
//
//  Reutiliza la MISMA cuenta de Gmail que ya usa "auth.js" para
//  mandar los correos de recuperar clave (GMAIL_USER /
//  GMAIL_APP_PASSWORD en las variables de entorno de Netlify) — no
//  hace falta configurar nada nuevo para que esto funcione.
// ────────────────────────────────────────────────────────────────

const nodemailer = require("nodemailer");
const { getStore } = require("@netlify/blobs");

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}

function todayISOFor(utcOffsetHours) {
  const localMs = Date.now() + utcOffsetHours * 3600 * 1000;
  return new Date(localMs).toISOString().slice(0, 10);
}
function daysAgoISO(isoDate, n) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
// Día de la semana (0=domingo…6=sábado) y hora "HH:00" según el huso horario
// DE ESA PERSONA — para comparar contra lo que eligió en Configuración.
function localDowAndHour(utcOffsetHours) {
  const local = new Date(Date.now() + utcOffsetHours * 3600 * 1000);
  const hh = String(local.getUTCHours()).padStart(2, "0");
  return { dow: local.getUTCDay(), hour: `${hh}:00` };
}

function buildWeeklyStats(tasks, utcOffsetHours) {
  const today = todayISOFor(utcOffsetHours);
  const weekAgo = daysAgoISO(today, 7);

  let completedThisWeek = 0;
  let overdueNow = 0;
  let partialNow = 0;
  let unscheduledNow = 0; // activas, sin día+hora agendados todavía ("Por agendar")
  const repeatedPartials = []; // títulos que quedaron "parcial" 2+ veces

  (tasks || []).forEach((t) => {
    if (!t || t.archived) return;
    const isActive = t.status !== "completada" && t.status !== "cancelada";

    if (t.status === "completada" && t.updatedAt && t.updatedAt >= weekAgo && t.updatedAt <= today) {
      completedThisWeek++;
    }
    if (isActive && t.dueDate && t.dueDate < today) overdueNow++;
    if (isActive && !t.executionTime) unscheduledNow++;
    if (t.status === "parcial") partialNow++;

    const partialHits = (t.updates || []).filter((u) => u && u.status === "parcial").length;
    if (partialHits >= 2) repeatedPartials.push({ title: t.title, hits: partialHits });
  });

  repeatedPartials.sort((a, b) => b.hits - a.hits);
  return { completedThisWeek, overdueNow, partialNow, unscheduledNow, repeatedPartials: repeatedPartials.slice(0, 5) };
}

// Le pide a Gemini que redacte el saludo/comentario inicial en el tono de
// Alma, PERO le pasamos los números ya calculados y le pedimos que los use
// tal cual — la IA nunca inventa una cifra, solo la redacta con calidez.
// Si falla por cualquier motivo (sin API key, sin cuota, sin internet), se
// usa un saludo genérico de respaldo y el correo se manda igual.
async function buildAiGreeting(username, stats) {
  const apiKey = process.env.GEMINI_API_KEY;
  const fallback = `Hola ${username || ""}, así te fue esta semana en TaskFlow Pro:`.trim();
  if (!apiKey) return fallback;

  const { completedThisWeek, overdueNow, partialNow, unscheduledNow } = stats;
  const prompt = `Eres "Alma", la asistente personal dentro de la app TaskFlow Pro. Escríbele a ${username || "la persona"} un saludo cálido y breve (máximo 3 frases, sin markdown, sin emojis, texto plano) para el resumen semanal de su correo. Usa EXACTAMENTE estos datos, sin inventar ni cambiar ningún número: completó ${completedThisWeek} tarea(s) esta semana, tiene ${overdueNow} tarea(s) atrasada(s) ahora mismo, ${partialNow} quedaron "parcial" (a medias), y ${unscheduledNow} todavía no tienen día y hora agendados. Tono cercano, chileno-neutro, alentador pero honesto — si hay atrasadas o sin agendar, menciónalo con suavidad, no como regaño. No repitas la palabra "resumen". No agregues saludo tipo "Estimado/a".`;

  try {
    const modelo = "gemini-3.5-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const datos = await resp.json();
    const texto = datos?.candidates?.[0]?.content?.parts?.[0]?.text;
    return (texto && texto.trim()) || fallback;
  } catch (err) {
    console.error("buildAiGreeting: fallo Gemini, uso saludo de respaldo.", err.message);
    return fallback;
  }
}

function buildEmailHtml(greeting, stats) {
  const { completedThisWeek, overdueNow, partialNow, unscheduledNow, repeatedPartials } = stats;

  const repeatedBlock = repeatedPartials.length
    ? `<div style="margin-top:16px;padding:14px 16px;background:#FFF4E8;border-radius:12px;">
         <div style="font-weight:700;color:#B5540A;margin-bottom:6px;">🔁 Estas se te siguen quedando a medias:</div>
         <ul style="margin:0;padding-left:18px;color:#7C4A12;font-size:13.5px;">
           ${repeatedPartials.map(p => `<li>${escHtml(p.title)} (quedó "parcial" ${p.hits} veces)</li>`).join("")}
         </ul>
         <div style="font-size:12.5px;color:#946334;margin-top:8px;">Si una tarea vuelve una y otra vez, probablemente esté pidiendo más tiempo del que le estás dando, o convenga partirla en pasos más chicos.</div>
       </div>`
    : "";

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;margin:0 auto;color:#2A2019;">
    <div style="background:linear-gradient(135deg,#FF7A45,#E8447A);border-radius:16px;padding:24px 22px;color:#fff;">
      <div style="font-size:13px;opacity:.9;">TaskFlow Pro · Alma</div>
      <div style="font-size:20px;font-weight:700;margin-top:4px;">Tu semana, en resumen 🌱</div>
    </div>
    <div style="padding:20px 4px;">
      <p style="font-size:14px;color:#2A2019;">${escHtml(greeting)}</p>
      <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;">
        <div style="flex:1;min-width:110px;background:#EFFBF5;border-radius:12px;padding:14px;">
          <div style="font-size:22px;font-weight:700;color:#1FAE7A;">${completedThisWeek}</div>
          <div style="font-size:12.5px;color:#3D6B57;">Completadas</div>
        </div>
        <div style="flex:1;min-width:110px;background:#FFF0F0;border-radius:12px;padding:14px;">
          <div style="font-size:22px;font-weight:700;color:#E5484D;">${overdueNow}</div>
          <div style="font-size:12.5px;color:#8A3A3C;">Atrasadas ahora</div>
        </div>
        <div style="flex:1;min-width:110px;background:#FFF4E8;border-radius:12px;padding:14px;">
          <div style="font-size:22px;font-weight:700;color:#F0793C;">${partialNow}</div>
          <div style="font-size:12.5px;color:#946334;">Quedaron "parcial"</div>
        </div>
        <div style="flex:1;min-width:110px;background:#F1EEFC;border-radius:12px;padding:14px;">
          <div style="font-size:22px;font-weight:700;color:#7C5CD9;">${unscheduledNow}</div>
          <div style="font-size:12.5px;color:#564689;">Sin agendar aún</div>
        </div>
      </div>
      ${repeatedBlock}
      <p style="font-size:12.5px;color:#7C6E64;margin-top:20px;">Lo importante es que nada se te pase — para eso está Alma. Que tengas una buena semana. 💪</p>
      <p style="font-size:11px;color:#A99C91;margin-top:18px;">¿No quieres recibir este correo? Puedes desactivarlo en TaskFlow Pro → Configuración → Notificaciones por correo.</p>
    </div>
  </div>`;
}
function escHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function sendReportEmail(toEmail, html) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Falta configurar GMAIL_USER / GMAIL_APP_PASSWORD en Netlify");
  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  await transporter.sendMail({
    from: `"TaskFlow Pro" <${user}>`,
    to: toEmail,
    subject: "Tu resumen semanal de TaskFlow Pro 🌱",
    html,
  });
}

async function buildAndSendFor(username, data, userRec) {
  const cfg = data.config || {};
  const toEmail = cfg.userEmail || (userRec && userRec.email) || "";
  if (!toEmail) return { ok: false, error: "Esa cuenta no tiene un correo configurado (ni en Configuración ni en el registro)." };

  const utcOffsetHours = typeof cfg.utcOffsetHours === "number" ? cfg.utcOffsetHours : -4;
  const stats = buildWeeklyStats(data.tasks, utcOffsetHours);
  const greeting = await buildAiGreeting(username, stats);
  const html = buildEmailHtml(greeting, stats);
  await sendReportEmail(toEmail, html);
  return { ok: true, sentTo: toEmail };
}

exports.handler = async function (event) {
  const users = store("users");
  const userdata = store("userdata");

  // ---- Modo PRUEBA: lo dispara el botón "Enviarme un resumen de prueba
  // ahora" en Configuración. Manda de inmediato SOLO a quien apretó el
  // botón, sin importar el día/hora configurados ni si el checkbox de
  // "Resumen semanal" está activado — es justamente para probarlo antes.
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch (e) { /* invocación programada: sin body */ }

  if (body && body.test) {
    if (!body.token) return { statusCode: 401, body: JSON.stringify({ error: "Falta sesión" }) };
    const sessions = store("sessions");
    const rec = await sessions.get(body.token, { type: "json" });
    if (!rec) return { statusCode: 401, body: JSON.stringify({ error: "Sesión inválida, vuelve a iniciar sesión" }) };
    const username = rec.username;
    try {
      const data = await userdata.get(username, { type: "json" });
      if (!data) return { statusCode: 400, body: JSON.stringify({ error: "Todavía no tienes datos guardados." }) };
      const userRec = await users.get(username, { type: "json" });
      const result = await buildAndSendFor(username, data, userRec);
      return { statusCode: result.ok ? 200 : 400, body: JSON.stringify(result) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ---- Modo PROGRAMADO: corre cada hora (ver netlify.toml) y revisa, para
  // cada persona con el "Resumen semanal" activado, si AHORA coincide con
  // el día y la hora que eligió en Configuración (según SU huso horario).
  let sent = 0, skipped = 0, failed = 0;
  try {
    const listing = await users.list();
    for (const entry of listing.blobs || []) {
      const username = entry.key;
      try {
        const data = await userdata.get(username, { type: "json" });
        if (!data) { skipped++; continue; }
        const cfg = data.config || {};
        const emailPrefs = cfg.emailNotifications || {};
        if (!emailPrefs.weeklyReport) { skipped++; continue; }

        const utcOffsetHours = typeof cfg.utcOffsetHours === "number" ? cfg.utcOffsetHours : -4;
        const wantDow = typeof cfg.weeklyReportDow === "number" ? cfg.weeklyReportDow : 0; // domingo por defecto
        const wantHour = cfg.weeklyReportHour || "18:00";
        const { dow, hour } = localDowAndHour(utcOffsetHours);
        if (dow !== wantDow || hour !== wantHour) { skipped++; continue; }

        const userRec = await users.get(username, { type: "json" });
        const result = await buildAndSendFor(username, data, userRec);
        if (result.ok) sent++; else skipped++;
      } catch (err) {
        failed++;
        console.error(`No se pudo mandar el resumen semanal a ${username}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Error general en send-weekly-report:", err.message);
    return { statusCode: 500, body: "Error: " + err.message };
  }

  console.log(`Resumen semanal: ${sent} enviados, ${skipped} sin novedades/fuera de horario, ${failed} fallidos.`);
  return { statusCode: 200, body: JSON.stringify({ sent, skipped, failed }) };
};
