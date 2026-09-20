// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "send-weekly-report-test" — la llama el botón "Enviarme
//  un resumen de prueba ahora" en Configuración. A propósito NO
//  tiene "schedule" en netlify.toml: las funciones programadas no
//  se pueden invocar directo desde el navegador (Netlify responde
//  403), así que esta es una gemela sin horario, solo para pruebas
//  manuales — manda de inmediato a quien apretó el botón, sin
//  importar el día/hora configurados ni si el checkbox de "Resumen
//  semanal" está activado.
// ────────────────────────────────────────────────────────────────

const { store, buildAndSendFor } = require("./weekly-report-lib");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Cuerpo inválido" }); }
  if (!body.token) return json(401, { error: "Falta sesión" });

  try {
    const sessions = store("sessions");
    const rec = await sessions.get(body.token, { type: "json" });
    if (!rec) return json(401, { error: "Sesión inválida, vuelve a iniciar sesión" });

    const username = rec.username;
    const userdata = store("userdata");
    const users = store("users");

    const data = await userdata.get(username, { type: "json" });
    if (!data) return json(400, { error: "Todavía no tienes datos guardados." });

    const userRec = await users.get(username, { type: "json" });
    const result = await buildAndSendFor(username, data, userRec);
    return json(result.ok ? 200 : 400, result);
  } catch (err) {
    return json(500, { error: err.message });
  }
};
