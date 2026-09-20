// ────────────────────────────────────────────────────────────────
//  "weekly-report-lib" — lógica compartida del resumen semanal.
//  La usan DOS funciones distintas:
//   - send-weekly-report.js       (programada, corre sola cada hora)
//   - send-weekly-report-test.js  (la llama el botón "Enviarme un
//     resumen de prueba ahora" — sin horario, para que SÍ se pueda
//     invocar directo desde el navegador; Netlify bloquea las
//     llamadas directas a funciones que tienen "schedule").
// ────────────────────────────────────────────────────────────────

const nodemailer = require("nodemailer");
const { getStore } = require("@netlify/blobs");
const { getValidGoogleAccessToken } = require("./google-helpers");

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
function localDowAndHour(utcOffsetHours) {
  const local = new Date(Date.now() + utcOffsetHours * 3600 * 1000);
  const hh = String(local.getUTCHours()).padStart(2, "0");
  return { dow: local.getUTCDay(), hour: `${hh}:00` };
}
function localTimeOfDay(utcOffsetHours) {
  const h = new Date(Date.now() + utcOffsetHours * 3600 * 1000).getUTCHours();
  if (h < 6) return "madrugada";
  if (h < 12) return "mañana";
  if (h < 19) return "tarde";
  return "noche";
}

function buildWeeklyStats(tasks, utcOffsetHours) {
  const today = todayISOFor(utcOffsetHours);
  const weekAgo = daysAgoISO(today, 7);

  let completedThisWeek = 0;
  let overdueNow = 0;
  let partialNow = 0;
  let unscheduledNow = 0;
  let taskHoursThisWeek = 0;
  const repeatedPartials = [];

  (tasks || []).forEach((t) => {
    if (!t || t.archived) return;
    const isActive = t.status !== "completada" && t.status !== "cancelada";

    if (t.status === "completada" && t.updatedAt && t.updatedAt >= weekAgo && t.updatedAt <= today) {
      completedThisWeek++;
    }
    if (isActive && t.dueDate && t.dueDate < today) overdueNow++;
    if (isActive && !t.executionTime) unscheduledNow++;
    if (t.status === "parcial") partialNow++;
    if (t.startDate && t.startDate >= weekAgo && t.startDate <= today) {
      taskHoursThisWeek += t.estimatedTime || 1;
    }

    const partialHits = (t.updates || []).filter((u) => u && u.status === "parcial").length;
    if (partialHits >= 2) repeatedPartials.push({ title: t.title, hits: partialHits });
  });

  repeatedPartials.sort((a, b) => b.hits - a.hits);
  return {
    completedThisWeek, overdueNow, partialNow, unscheduledNow,
    taskHoursThisWeek: Math.round(taskHoursThisWeek * 10) / 10,
    repeatedPartials: repeatedPartials.slice(0, 5),
  };
}

// Igual que el panel "Tu semana en números" del Calendario, calculado en el
// servidor. Si no tiene Google Calendar conectado, devuelve null.
async function getWeeklyMeetingStats(username, utcOffsetHours, workCalendarIds) {
  try {
    const accessToken = await getValidGoogleAccessToken(username);
    if (!accessToken) return null;

    const nowLocal = new Date(Date.now() + utcOffsetHours * 3600 * 1000);
    const timeMax = nowLocal.toISOString();
    const weekAgoLocal = new Date(nowLocal); weekAgoLocal.setUTCDate(weekAgoLocal.getUTCDate() - 7);
    const timeMin = weekAgoLocal.toISOString();

    const listResp = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listResp.ok) return null;
    const listData = await listResp.json();
    const calIds = (listData.items || []).map((c) => c.id);
    const workSet = new Set(Array.isArray(workCalendarIds) ? workCalendarIds : []);

    let workHours = 0, personalHours = 0;
    for (const calId of calIds) {
      const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`);
      url.searchParams.set("timeMin", timeMin);
      url.searchParams.set("timeMax", timeMax);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("maxResults", "100");
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!resp.ok) continue;
      const data = await resp.json();
      (data.items || []).forEach((ev) => {
        if (ev.status === "cancelled") return;
        if (ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.taskflowOrigin === "true") return;
        if (!ev.start || !ev.start.dateTime || !ev.end || !ev.end.dateTime) return;
        const h = (new Date(ev.end.dateTime) - new Date(ev.start.dateTime)) / 3600000;
        if (h <= 0) return;
        if (workSet.has(calId)) workHours += h; else personalHours += h;
      });
    }
    return {
      workHours: Math.round(workHours * 10) / 10,
      personalHours: Math.round(personalHours * 10) / 10,
      totalHours: Math.round((workHours + personalHours) * 10) / 10,
    };
  } catch (err) {
    console.error("getWeeklyMeetingStats:", err.message);
    return null;
  }
}

// Respuesta de respaldo si Gemini falla o no hay API key — el correo se
// manda igual, solo con un contenido más simple (nunca se cae por esto).
function fallbackContent(username, stats) {
  const { completedThisWeek } = stats;
  return {
    headline: `${username || "Hola"}, así fue tu semana`,
    body: `Completaste ${completedThisWeek} tarea${completedThisWeek === 1 ? "" : "s"} esta semana en TaskFlow Pro.`,
    quote: "La semana no tiene que ser perfecta para haber sido valiosa.",
    insight: "Revisa el detalle abajo para ver dónde se fue tu tiempo.",
    suggestion: "Dale una fecha a lo que todavía no la tiene — así no se te acumula.",
    cta: "Ir a TaskFlow Pro",
  };
}

// Le pide a Gemini que arme el contenido del correo en el tono de Alma —
// coach personal, cálida, con humor suave, nunca corporativa ni robótica.
// Le pasamos los números ya calculados y le pedimos que los use tal cual —
// nunca inventa una cifra, solo les pone las palabras. Devuelve SIEMPRE un
// objeto con las mismas claves (con respaldo si Gemini falla), así la
// plantilla del correo nunca se rompe por un problema de IA.
async function buildAiContent(username, stats, meetingStats, timeOfDay) {
  const fallback = fallbackContent(username, stats);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fallback;

  const { completedThisWeek, overdueNow, partialNow, unscheduledNow, taskHoursThisWeek } = stats;
  const meetingLine = meetingStats
    ? `Tuvo ${meetingStats.totalHours}h en reuniones esta semana (${meetingStats.workHours}h trabajo, ${meetingStats.personalHours}h personal), frente a ${taskHoursThisWeek}h planificadas en tareas.`
    : `No tiene Google Calendar conectado, así que no hay datos de reuniones.`;

  const prompt = `Eres "Alma", la coach personal dentro de la app TaskFlow Pro — cercana, honesta, con humor suave, nunca corporativa ni robótica. Es de ${timeOfDay} para ${username || "la persona"} ahora mismo.

Datos EXACTOS de su semana (no inventes ni cambies ningún número): completó ${completedThisWeek} tarea(s), tiene ${overdueNow} atrasada(s) ahora mismo, ${partialNow} quedaron "parcial" (a medias), ${unscheduledNow} sin día y hora agendados todavía. ${meetingLine}

Devuelve SOLO un objeto JSON válido (nada de texto antes o después, nada de markdown ni backticks) con exactamente estas claves de texto plano (sin emojis):
{
  "headline": "título corto y personal, 4 a 9 palabras, con su nombre si suena natural, que resuma el tono de su semana",
  "body": "2 a 3 frases usando los datos exactos de arriba — si le fue muy bien celébrala de verdad (que se note el orgullo, sin exagerar), si le fue floja anímala con cariño sin culpa ni sermón",
  "quote": "una frase corta tipo aforismo o coach, relacionada a su semana, sin comillas dentro del texto",
  "insight": "1 a 2 frases: qué patrón notaste en su semana (ej: dominada por reuniones, muchas tareas a medias, buen ritmo constante, etc.) — algo específico a SUS datos, no genérico",
  "suggestion": "1 a 2 frases: una sugerencia CONCRETA y accionable para la próxima semana, específica a lo que más le convenga según sus datos",
  "cta": "2 a 4 palabras para un botón, en infinitivo o imperativo, ej: Planificar mi semana"
}

Tono chileno-neutro, como una amiga que te quiere ver bien, no como un jefe ni un reporte de empresa. Profesional pero cálido — nada cursi ni sobreactuado.`;

  try {
    const modelo = "gemini-3.5-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });
    const datos = await resp.json();
    const texto = datos?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!texto) return fallback;
    const cleaned = texto.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
    const parsed = JSON.parse(cleaned);
    return {
      headline: parsed.headline || fallback.headline,
      body: parsed.body || fallback.body,
      quote: parsed.quote || fallback.quote,
      insight: parsed.insight || fallback.insight,
      suggestion: parsed.suggestion || fallback.suggestion,
      cta: parsed.cta || fallback.cta,
    };
  } catch (err) {
    console.error("buildAiContent: fallo Gemini/JSON, uso contenido de respaldo.", err.message);
    return fallback;
  }
}

function escHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const SITE_URL = "https://taskflow-alma.netlify.app/?view=agendar";

// Plantilla final "Impulso" (naranjo de marca, bien marcada visualmente):
// hero con degradado + título grande, círculo de "victoria de la semana",
// 3 stats grandes, panel oscuro de reuniones-vs-tareas, caja de sugerencia
// con botón, y la lista de tareas que se repiten como "parcial".
function buildEmailHtml(content, stats, meetingStats) {
  const { headline, body, insight, suggestion, cta } = content;
  const { completedThisWeek, overdueNow, partialNow, unscheduledNow, taskHoursThisWeek, repeatedPartials } = stats;

  const meetPct = meetingStats
    ? Math.max(4, Math.min(96, Math.round((meetingStats.totalHours / Math.max(0.1, meetingStats.totalHours + taskHoursThisWeek)) * 100)))
    : 0;
  const restPct = 100 - meetPct;

  // Barra "reuniones vs. tareas" hecha con celdas de tabla (dos <td> lado a
  // lado cuyo ancho en % representa la proporción) — el truco de "gap" con
  // flexbox no se ve en la mayoría de los clientes de correo.
  const balanceBlock = meetingStats ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;background-color:#1A1025;border-radius:18px;">
        <tr><td style="padding:22px;">
          <div style="font-weight:bold;color:#ffffff;font-size:16px;margin-bottom:14px;font-family:Arial,Helvetica,sans-serif;">⏱️ Reuniones vs. tareas esta semana</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" height="16" style="border-radius:8px;overflow:hidden;">
            <tr>
              <td width="${meetPct}%" bgcolor="#FF7A45" style="background-color:#FF7A45;font-size:1px;line-height:16px;">&nbsp;</td>
              <td width="${restPct}%" bgcolor="#3A2E4D" style="background-color:#3A2E4D;font-size:1px;line-height:16px;">&nbsp;</td>
            </tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
            <tr>
              <td align="left" style="font-size:14px;color:#ffffff;font-weight:bold;font-family:Arial,Helvetica,sans-serif;">🗓️ ${meetingStats.totalHours}h en reuniones</td>
              <td align="right" style="font-size:14px;color:#ffffff;font-weight:bold;font-family:Arial,Helvetica,sans-serif;">✅ ${taskHoursThisWeek}h en tareas</td>
            </tr>
          </table>
          <div style="font-size:12.5px;color:#B8A9CE;margin-top:8px;font-family:Arial,Helvetica,sans-serif;">${escHtml(insight)}</div>
        </td></tr>
      </table>` : `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;background-color:#FAF7F5;border-radius:18px;">
        <tr><td style="padding:20px;">
          <div style="font-weight:bold;color:#1A1025;font-size:14.5px;margin-bottom:6px;font-family:Arial,Helvetica,sans-serif;">💡 Lo que Alma detectó</div>
          <div style="font-size:13.5px;color:#5C4A3E;line-height:1.55;font-family:Arial,Helvetica,sans-serif;">${escHtml(insight)}</div>
        </td></tr>
      </table>`;

  const decisionsBlock = repeatedPartials.length ? `
      <div style="margin-top:24px;">
        <div style="font-weight:bold;color:#1A1025;font-size:17px;margin-bottom:14px;font-family:Arial,Helvetica,sans-serif;">🔁 Pendientes que merecen una decisión</div>
        ${repeatedPartials.map(p => `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#FAF7F5;border-radius:12px;margin-bottom:8px;">
          <tr>
            <td width="24" style="padding:14px 0 14px 14px;" valign="top">
              <table role="presentation" cellpadding="0" cellspacing="0" width="10" height="10"><tr><td bgcolor="#FF7A45" style="background-color:#FF7A45;border-radius:5px;font-size:1px;line-height:10px;width:10px;height:10px;">&nbsp;</td></tr></table>
            </td>
            <td style="padding:14px 14px 14px 10px;font-family:Arial,Helvetica,sans-serif;">
              <span style="font-size:14px;color:#1A1025;font-weight:bold;">${escHtml(p.title)}</span><br>
              <span style="color:#A99C91;font-weight:normal;font-size:12.5px;">Quedó "parcial" ${p.hits} veces</span>
            </td>
          </tr>
        </table>`).join("")}
      </div>` : "";

  // Insignia de "victoria de la semana": un círculo simple (tabla redonda de
  // ancho/alto fijo con border-radius), sin conic-gradient — esa propiedad
  // no la soportan Gmail/Outlook y por eso se veía descuadrada.
  const badge = `
    <table role="presentation" cellpadding="0" cellspacing="0" width="72" height="72" style="background-color:#FF7A45;border-radius:36px;">
      <tr><td align="center" valign="middle" style="width:72px;height:72px;border-radius:36px;">
        <div style="font-size:26px;font-weight:bold;color:#ffffff;line-height:1.1;font-family:Arial,Helvetica,sans-serif;">${completedThisWeek}</div>
        <div style="font-size:9px;color:#FFE1D0;font-weight:bold;font-family:Arial,Helvetica,sans-serif;">completadas</div>
      </td></tr>
    </table>`;

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:0 auto;background-color:#ffffff;border-radius:20px;font-family:Arial,Helvetica,sans-serif;">

    <!-- HERO -->
    <tr>
      <td bgcolor="#F0447A" style="background-color:#F0447A;background-image:linear-gradient(135deg,#FF7A45 0%,#F0447A 55%,#8B5CF6 100%);border-radius:20px 20px 0 0;padding:36px 30px;color:#ffffff;">
        <div style="font-size:12px;font-weight:bold;letter-spacing:1px;color:#ffffff;">✨ TASKFLOW PRO · TU RESUMEN SEMANAL</div>
        <div style="font-size:26px;font-weight:bold;margin-top:14px;line-height:1.28;color:#ffffff;">${escHtml(headline)}</div>
        <div style="font-size:14.5px;margin-top:12px;line-height:1.55;color:#ffffff;">${escHtml(body)}</div>
      </td>
    </tr>

    <tr>
      <td style="padding:28px 26px 8px;">

        <!-- VICTORIA -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#FFF0E8" style="background-color:#FFF0E8;border-radius:18px;">
          <tr>
            <td width="92" style="padding:20px;" valign="middle">${badge}</td>
            <td style="padding:20px 20px 20px 0;" valign="middle">
              <div style="font-size:11px;font-weight:bold;color:#E8447A;letter-spacing:.5px;">🏆 TU VICTORIA DE LA SEMANA</div>
              <div style="font-size:15px;font-weight:bold;color:#1A1025;margin-top:6px;line-height:1.35;">${escHtml((suggestion.split(".")[0] || "Seguiste avanzando esta semana").trim())}.</div>
            </td>
          </tr>
        </table>

        <!-- STATS: tabla de 3 columnas con celdas espaciadoras (nada de "gap") -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;">
          <tr>
            <td width="32%" bgcolor="#FFEDED" style="background-color:#FFEDED;border-radius:14px;padding:16px 8px;text-align:center;">
              <div style="font-size:26px;font-weight:bold;color:#E5484D;">${overdueNow}</div>
              <div style="font-size:11px;color:#B33338;font-weight:bold;margin-top:2px;">Atrasadas</div>
            </td>
            <td width="2%"></td>
            <td width="32%" bgcolor="#FFF4E8" style="background-color:#FFF4E8;border-radius:14px;padding:16px 8px;text-align:center;">
              <div style="font-size:26px;font-weight:bold;color:#E8602A;">${partialNow}</div>
              <div style="font-size:11px;color:#B3491E;font-weight:bold;margin-top:2px;">Parciales</div>
            </td>
            <td width="2%"></td>
            <td width="32%" bgcolor="#F1EEFC" style="background-color:#F1EEFC;border-radius:14px;padding:16px 8px;text-align:center;">
              <div style="font-size:26px;font-weight:bold;color:#7C5CD9;">${unscheduledNow}</div>
              <div style="font-size:11px;color:#564689;font-weight:bold;margin-top:2px;">Sin agendar</div>
            </td>
          </tr>
        </table>

        ${balanceBlock}

        <!-- SUGERENCIA -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#FFF0EA" style="background-color:#FFF0EA;border-radius:18px;margin-top:20px;">
          <tr><td style="padding:22px;">
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td width="26" valign="middle">
                <table role="presentation" cellpadding="0" cellspacing="0" width="24" height="24" bgcolor="#FF7A45" style="background-color:#FF7A45;border-radius:12px;">
                  <tr><td align="center" valign="middle" style="color:#ffffff;font-size:15px;font-weight:bold;">+</td></tr>
                </table>
              </td>
              <td style="padding-left:8px;font-weight:bold;color:#1A1025;font-size:15px;" valign="middle">Una mejora simple para tu próxima semana</td>
            </tr></table>
            <div style="font-size:14px;color:#5C4A3E;line-height:1.6;margin-top:10px;">${escHtml(suggestion)}</div>
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px;">
              <tr><td bgcolor="#1A1025" style="background-color:#1A1025;border-radius:12px;">
                <a href="${SITE_URL}" style="display:block;padding:13px 24px;color:#ffffff;text-decoration:none;font-size:14px;font-weight:bold;">${escHtml(cta)} →</a>
              </td></tr>
            </table>
          </td></tr>
        </table>

        ${decisionsBlock}

        <div style="text-align:center;margin-top:30px;padding-bottom:28px;">
          <div style="font-size:20px;">🌱</div>
          <p style="font-size:14px;color:#5C4A3E;font-weight:bold;margin-top:8px;">Alma te ayuda a recordar, priorizar y cerrar.</p>
          <p style="font-size:13px;color:#A99C91;margin-top:2px;">Tú sigues tomando las decisiones.</p>
          <p style="font-size:11px;color:#C9BEB2;margin-top:18px;">¿No quieres recibir este correo? Desactívalo en TaskFlow Pro → Configuración → Notificaciones por correo.</p>
        </div>
      </td>
    </tr>
  </table>`;
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
  const meetingStats = await getWeeklyMeetingStats(username, utcOffsetHours, cfg.workCalendarIds);
  const timeOfDay = localTimeOfDay(utcOffsetHours);
  const content = await buildAiContent(username, stats, meetingStats, timeOfDay);
  const html = buildEmailHtml(content, stats, meetingStats);
  await sendReportEmail(toEmail, html);
  return { ok: true, sentTo: toEmail };
}

module.exports = { store, localDowAndHour, buildAndSendFor };
