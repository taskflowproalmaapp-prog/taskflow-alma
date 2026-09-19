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

function buildWeeklyStats(tasks, utcOffsetHours) {
  const today = todayISOFor(utcOffsetHours);
  const weekAgo = daysAgoISO(today, 7);

  let completedThisWeek = 0;
  let overdueNow = 0;
  let partialNow = 0;
  const repeatedPartials = []; // títulos que quedaron "parcial" 2+ veces

  (tasks || []).forEach((t) => {
    if (!t || t.archived) return;

    if (t.status === "completada" && t.updatedAt && t.updatedAt >= weekAgo && t.updatedAt <= today) {
      completedThisWeek++;
    }
    if (t.status !== "completada" && t.status !== "cancelada" && t.dueDate && t.dueDate < today) {
      overdueNow++;
    }
    if (t.status === "parcial") partialNow++;

    const partialHits = (t.updates || []).filter((u) => u && u.status === "parcial").length;
    if (partialHits >= 2) repeatedPartials.push({ title: t.title, hits: partialHits });
  });

  repeatedPartials.sort((a, b) => b.hits - a.hits);
  return { completedThisWeek, overdueNow, partialNow, repeatedPartials: repeatedPartials.slice(0, 5) };
}

function buildEmailHtml(username, stats) {
  const { completedThisWeek, overdueNow, partialNow, repeatedPartials } = stats;

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
      <p style="font-size:14px;color:#2A2019;">Hola${username ? " " + escHtml(username) : ""}, así te fue esta semana en TaskFlow Pro:</p>
      <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap;">
        <div style="flex:1;min-width:130px;background:#EFFBF5;border-radius:12px;padding:14px;">
          <div style="font-size:22px;font-weight:700;color:#1FAE7A;">${completedThisWeek}</div>
          <div style="font-size:12.5px;color:#3D6B57;">Completadas</div>
        </div>
        <div style="flex:1;min-width:130px;background:#FFF0F0;border-radius:12px;padding:14px;">
          <div style="font-size:22px;font-weight:700;color:#E5484D;">${overdueNow}</div>
          <div style="font-size:12.5px;color:#8A3A3C;">Atrasadas ahora</div>
        </div>
        <div style="flex:1;min-width:130px;background:#FFF4E8;border-radius:12px;padding:14px;">
          <div style="font-size:22px;font-weight:700;color:#F0793C;">${partialNow}</div>
          <div style="font-size:12.5px;color:#946334;">Quedaron "parcial"</div>
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

exports.handler = async function () {
  const users = store("users");
  const userdata = store("userdata");

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

        const userRec = await users.get(username, { type: "json" });
        const toEmail = cfg.userEmail || (userRec && userRec.email) || "";
        if (!toEmail) { skipped++; continue; }

        const utcOffsetHours = typeof cfg.utcOffsetHours === "number" ? cfg.utcOffsetHours : -4;
        const stats = buildWeeklyStats(data.tasks, utcOffsetHours);
        const html = buildEmailHtml(username, stats);

        await sendReportEmail(toEmail, html);
        sent++;
      } catch (err) {
        failed++;
        console.error(`No se pudo mandar el resumen semanal a ${username}:`, err.message);
      }
    }
  } catch (err) {
    console.error("Error general en send-weekly-report:", err.message);
    return { statusCode: 500, body: "Error: " + err.message };
  }

  console.log(`Resumen semanal: ${sent} enviados, ${skipped} sin novedades/opt-out, ${failed} fallidos.`);
  return { statusCode: 200, body: JSON.stringify({ sent, skipped, failed }) };
};
