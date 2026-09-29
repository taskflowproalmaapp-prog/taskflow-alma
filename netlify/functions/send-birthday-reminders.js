// ────────────────────────────────────────────────────────────────
//  FUNCIÓN PROGRAMADA "send-birthday-reminders" — corre sola, una vez al
//  día (ver netlify.toml). Revisa los cumpleaños de CADA persona
//  registrada y, si alguno cae exactamente dentro de "X días de
//  anticipación" (lo que esa persona configuró para ese cumpleaños en
//  concreto), le manda un aviso por los canales que haya marcado
//  (email y/o notificación push).
// ────────────────────────────────────────────────────────────────

const webpush = require("web-push");
const nodemailer = require("nodemailer");
const { getStore } = require("@netlify/blobs");

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}

const MONTH_LABELS = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

function todayLocalParts(utcOffsetHours) {
  const localMs = Date.now() + utcOffsetHours * 3600 * 1000;
  const d = new Date(localMs);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
// Próxima ocurrencia de un cumpleaños (si ya pasó este año, el que viene) y
// cuántos días faltan desde "hoy" (en el huso horario de esa persona).
function daysUntilBirthday(b, todayParts) {
  const todayUTC = Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day);
  let occUTC = Date.UTC(todayParts.year, b.month - 1, b.day);
  let occYear = todayParts.year;
  if (occUTC < todayUTC) { occUTC = Date.UTC(todayParts.year + 1, b.month - 1, b.day); occYear = todayParts.year + 1; }
  return { daysLeft: Math.round((occUTC - todayUTC) / 86400000), occYear };
}

async function sendBirthdayEmail(toEmail, b, occYear, matchedLead) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Falta configurar GMAIL_USER / GMAIL_APP_PASSWORD en Netlify");
  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  const whenText = matchedLead === 0 ? "es hoy" : matchedLead === 1 ? "es mañana" : `es en ${matchedLead} días`;
  const ageText = b.year ? ` · cumple ${occYear - b.year} años` : "";
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;">
      <div style="background:linear-gradient(125deg,#FF6B45,#ED3F7C,#8157EF);border-radius:16px;padding:24px;color:#fff;">
        <div style="font-size:32px;">🎂</div>
        <div style="font-size:20px;font-weight:700;margin-top:8px;">El cumpleaños de ${b.name} ${whenText}</div>
      </div>
      <div style="padding:20px 4px;">
        <p style="font-size:14px;color:#2B1B2E;">${b.day} de ${MONTH_LABELS[b.month-1]}${ageText}${b.relationship?` · ${b.relationship}`:""}</p>
        <p style="font-size:13px;color:#826F78;">Alma te avisa con tiempo para que no se te pase. 💜</p>
      </div>
    </div>`;
  await transporter.sendMail({
    from: `"TaskFlow Pro" <${user}>`,
    to: toEmail,
    subject: `🎂 El cumpleaños de ${b.name} ${whenText}`,
    html,
  });
}

exports.handler = async function () {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || "mailto:taskflowpro.alma.app@gmail.com";
  if (vapidPublic && vapidPrivate) webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const pushSubs = store("push_subscriptions");
  const userdata = store("userdata");

  let emailsSent = 0, pushSent = 0, skipped = 0, failed = 0;
  try {
    const listing = await userdata.list();
    for (const entry of listing.blobs || []) {
      const username = entry.key;
      const data = await userdata.get(username, { type: "json" });
      const birthdays = (data && data.birthdays) || [];
      if (!birthdays.length) { skipped++; continue; }

      const cfg = (data && data.config) || {};
      const utcOffsetHours = typeof cfg.utcOffsetHours === "number" ? cfg.utcOffsetHours : -4;
      const todayParts = todayLocalParts(utcOffsetHours);
      const toEmail = cfg.userEmail || "";

      for (const b of birthdays) {
        if (!b || !b.day || !b.month) continue;
        // remindDaysBefore puede ser un número suelto (cumpleaños guardados
        // antes de que esto se volviera de selección múltiple) o un arreglo.
        const leadArr = Array.isArray(b.remindDaysBefore) ? b.remindDaysBefore : [typeof b.remindDaysBefore === "number" ? b.remindDaysBefore : 3];
        const { daysLeft, occYear } = daysUntilBirthday(b, todayParts);
        const matchedLead = leadArr.find(lead => lead === daysLeft);
        if (matchedLead === undefined) continue; // hoy no toca avisar de este

        const channels = b.channels || {};
        if (channels.email && toEmail) {
          try { await sendBirthdayEmail(toEmail, b, occYear, matchedLead); emailsSent++; }
          catch (err) { failed++; console.error(`Email cumpleaños (${username} → ${b.name}):`, err.message); }
        }
        if (channels.push) {
          try {
            const subscription = await pushSubs.get(username, { type: "json" });
            if (subscription) {
              const whenText = matchedLead === 0 ? "es hoy" : matchedLead === 1 ? "es mañana" : `es en ${matchedLead} días`;
              const payload = JSON.stringify({
                title: "🎂 Cumpleaños",
                body: `El cumpleaños de ${b.name} ${whenText} (${b.day} de ${MONTH_LABELS[b.month-1]}).`,
                url: "/?view=cumpleanos",
                tag: `taskflow-birthday-${b.id}`,
              });
              await webpush.sendNotification(subscription, payload);
              pushSent++;
            }
          } catch (err) {
            failed++;
            if (err.statusCode === 404 || err.statusCode === 410) await pushSubs.delete(username);
            else console.error(`Push cumpleaños (${username} → ${b.name}):`, err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error("Error general en send-birthday-reminders:", err.message);
    return { statusCode: 500, body: "Error: " + err.message };
  }

  console.log(`Cumpleaños: ${emailsSent} emails, ${pushSent} push, ${skipped} sin cumpleaños cargados, ${failed} fallidos.`);
  return { statusCode: 200, body: JSON.stringify({ emailsSent, pushSent, skipped, failed }) };
};
