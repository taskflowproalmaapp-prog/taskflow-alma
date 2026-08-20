// ────────────────────────────────────────────────────────────────
//  FUNCIÓN PROGRAMADA "send-reminders" — corre sola, una vez al día
//  (ver netlify.toml). Revisa las tareas de CADA persona registrada
//  y, si tiene algo vencido o para hoy, le manda una notificación
//  push (aunque no tenga la app abierta).
// ────────────────────────────────────────────────────────────────

const webpush = require("web-push");
const { getStore } = require("@netlify/blobs");

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}

function todayISO() {
  // fecha de "hoy" en UTC — simplificación razonable para un recordatorio diario;
  // puede variar 1 día para personas en zonas horarias muy alejadas de UTC.
  return new Date().toISOString().slice(0, 10);
}

function summarizeTasks(tasks) {
  const today = todayISO();
  let overdue = 0, dueToday = 0;
  (tasks || []).forEach((t) => {
    if (!t || t.status === "completada" || t.archived) return;
    if (t.dueDate && t.dueDate < today) overdue++;
    else if (t.dueDate === today || t.startDate === today) dueToday++;
  });
  return { overdue, dueToday };
}

exports.handler = async function () {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || "mailto:taskflowpro.alma.app@gmail.com";
  if (!vapidPublic || !vapidPrivate) {
    console.error("Faltan VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY — no se pueden enviar notificaciones.");
    return { statusCode: 500, body: "Faltan las claves VAPID" };
  }
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const pushSubs = store("push_subscriptions");
  const userdata = store("userdata");

  let sent = 0, skipped = 0, failed = 0;
  try {
    const listing = await pushSubs.list();
    for (const entry of listing.blobs || []) {
      const username = entry.key;
      const subscription = await pushSubs.get(username, { type: "json" });
      if (!subscription) continue;

      const data = await userdata.get(username, { type: "json" });
      const { overdue, dueToday } = summarizeTasks(data && data.tasks);

      if (overdue === 0 && dueToday === 0) { skipped++; continue; }

      const parts = [];
      if (overdue > 0) parts.push(`${overdue} vencida${overdue === 1 ? "" : "s"}`);
      if (dueToday > 0) parts.push(`${dueToday} para hoy`);
      const body = `Tienes ${parts.join(" y ")}. Échale un vistazo cuando puedas 🌱`;

      const payload = JSON.stringify({
        title: "TaskFlow Pro",
        body,
        url: "/",
        tag: "taskflow-daily-reminder",
      });

      try {
        await webpush.sendNotification(subscription, payload);
        sent++;
      } catch (err) {
        failed++;
        // si el navegador ya no tiene esa suscripción activa (410/404), la borramos
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pushSubs.delete(username);
        } else {
          console.error(`No se pudo notificar a ${username}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error("Error general en send-reminders:", err.message);
    return { statusCode: 500, body: "Error: " + err.message };
  }

  console.log(`Recordatorios: ${sent} enviados, ${skipped} sin novedades, ${failed} fallidos.`);
  return { statusCode: 200, body: JSON.stringify({ sent, skipped, failed }) };
};
