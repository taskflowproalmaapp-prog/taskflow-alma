// ────────────────────────────────────────────────────────────────
//  FUNCIÓN PROGRAMADA "send-activity-alerts" — corre sola cada 15
//  minutos (ver netlify.toml). A diferencia de "send-reminders" (el
//  resumen general de la mañana/noche), esta avisa puntualmente de
//  UNA tarea/actividad con hora específica, con la anticipación que
//  cada persona eligió (ej. "avísame 3 horas antes").
// ────────────────────────────────────────────────────────────────

const webpush = require("web-push");
const { getStore } = require("@netlify/blobs");

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}

// Convierte fecha+hora "locales" (según el huso horario que la persona eligió
// en Configuración) a un timestamp UTC real, para poder compararlo con "ahora".
function localToUtcMs(dateStr, timeStr, utcOffsetHours) {
  const naiveUtcMs = Date.parse(`${dateStr}T${timeStr}:00Z`);
  if (isNaN(naiveUtcMs)) return null;
  return naiveUtcMs - utcOffsetHours * 3600 * 1000;
}

exports.handler = async function () {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || "mailto:taskflowpro.alma.app@gmail.com";
  if (!vapidPublic || !vapidPrivate) {
    console.error("Faltan las claves VAPID.");
    return { statusCode: 500, body: "Faltan las claves VAPID" };
  }
  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const pushSubs = store("push_subscriptions");
  const userdata = store("userdata");
  const alertState = store("activity_alert_state");

  const nowMs = Date.now();
  const todayISO = new Date().toISOString().slice(0, 10);
  let checked = 0, sent = 0, failed = 0;

  try {
    const listing = await pushSubs.list();
    for (const entry of listing.blobs || []) {
      const username = entry.key;
      const subscription = await pushSubs.get(username, { type: "json" });
      if (!subscription) continue;

      const data = await userdata.get(username, { type: "json" });
      if (!data || !Array.isArray(data.tasks)) continue;
      const cfg = data.config || {};
      const utcOffsetHours = typeof cfg.utcOffsetHours === "number" ? cfg.utcOffsetHours : -4; // Chile por defecto
      const hoursBefore = typeof cfg.pushAlertHoursBefore === "number" ? cfg.pushAlertHoursBefore : 3;

      // recordamos a quién ya le avisamos hoy, para no repetir el mismo aviso
      let state = await alertState.get(username, { type: "json" });
      if (!state || state.date !== todayISO) state = { date: todayISO, notified: [] };

      let stateChanged = false;
      for (const t of data.tasks) {
        checked++;
        if (!t || t.status === "completada" || t.archived) continue;
        if (!t.startDate || !t.executionTime) continue; // solo tareas/actividades con hora específica
        if (state.notified.includes(t.id)) continue;

        const targetMs = localToUtcMs(t.startDate, t.executionTime, utcOffsetHours);
        if (targetMs == null) continue;
        const hoursUntil = (targetMs - nowMs) / 3600000;
        if (hoursUntil < 0 || hoursUntil > hoursBefore) continue; // fuera de la ventana de anticipación

        const payload = JSON.stringify({
          title: "TaskFlow Pro",
          body: `⏰ "${t.title}" es a las ${t.executionTime}${t.startDate === todayISO ? " de hoy" : ""}.`,
          url: "/",
          tag: "taskflow-activity-" + t.id,
        });
        try {
          await webpush.sendNotification(subscription, payload);
          sent++;
          state.notified.push(t.id);
          stateChanged = true;
        } catch (err) {
          failed++;
          if (err.statusCode === 404 || err.statusCode === 410) {
            await pushSubs.delete(username);
            break; // ya no tiene sentido seguir revisando sus otras tareas
          }
        }
      }
      if (stateChanged) await alertState.set(username, JSON.stringify(state));
    }
  } catch (err) {
    console.error("Error general en send-activity-alerts:", err.message);
    return { statusCode: 500, body: "Error: " + err.message };
  }

  console.log(`Alertas de actividad: ${checked} tareas revisadas, ${sent} avisos enviados, ${failed} fallidos.`);
  return { statusCode: 200, body: JSON.stringify({ checked, sent, failed }) };
};
