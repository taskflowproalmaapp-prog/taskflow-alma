// ────────────────────────────────────────────────────────────────
//  FUNCIÓN PROGRAMADA "send-weekly-report" — corre sola cada hora
//  (ver netlify.toml). Para cada persona que activó "🌱 Resumen
//  semanal" en Configuración, revisa si AHORA coincide con el día y
//  la hora que ella eligió (según SU huso horario) y, si coincide,
//  le manda el correo.
//
//  Importante: como esta función tiene "schedule" en netlify.toml,
//  Netlify bloquea que se la llame directo por su URL (por seguridad,
//  solo la puede disparar el reloj interno de Netlify). Por eso el
//  botón "Enviarme un resumen de prueba ahora" NO usa esta función —
//  usa "send-weekly-report-test.js", que es idéntica por dentro pero
//  sin horario, así que sí se puede llamar directo.
// ────────────────────────────────────────────────────────────────

const { store, localDowAndHour, buildAndSendFor } = require("./weekly-report-lib");

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
