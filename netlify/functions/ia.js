// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "ia" — El recepcionista seguro que habla con Gemini
// ────────────────────────────────────────────────────────────────
//  Tu app (index.html) le pide cosas a esta función.
//  Esta función tiene la clave secreta (guardada en Netlify, NO en el código)
//  y es la única que habla con Gemini. Así tu clave nunca queda expuesta.
//
//  Seguridad (nuevo):
//   - Solo responde a personas con sesión iniciada: valida el token igual
//     que data.js. Sin token válido → 401 (nadie de afuera puede usar tu clave).
//   - Límite diario por persona (IA_DAILY_LIMIT, por defecto 400 llamadas)
//     para que una cuenta no pueda agotar la cuota de todos.
//
//  Opcional: json: true (respuesta solo JSON) y temperature (0–1, precisión).
//  Acepta texto (prompt) y, opcionalmente, UN archivo:
//   - media: { data: base64, mediaType }  → imagen o audio (para Brainstorm)
//   - image: { data, mediaType }          → formato antiguo, sigue funcionando
// ────────────────────────────────────────────────────────────────

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

// Tipos de archivo que aceptamos mandar a Gemini
const ALLOWED_MEDIA = /^(image\/(png|jpeg|jpg|webp|heic|heif|gif)|audio\/(webm|ogg|mp4|mpeg|mp3|wav|aac|x-m4a|m4a|flac))(;.*)?$/i;
// Netlify acepta hasta ~6 MB por llamada; dejamos margen para el resto del cuerpo
const MAX_MEDIA_BASE64 = 5.5 * 1024 * 1024;

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });

  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) return json(500, { error: "Falta configurar GEMINI_API_KEY en Netlify" });

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return json(400, { error: "Cuerpo de la petición inválido" }); }

  // 1) ¿Quién pide? Mismo chequeo de sesión que data.js
  const { token } = body;
  if (!token) return json(401, { error: "Falta token de sesión" });
  let username;
  try {
    const rec = await store("sessions").get(token, { type: "json" });
    if (!rec || !rec.username || sessionExpired(rec)) return json(401, { error: "Sesión inválida o expirada, vuelve a iniciar sesión" });
    username = rec.username;
  } catch (e) {
    return json(500, { error: "No se pudo validar la sesión: " + e.message });
  }

  // 2) Límite diario por persona (cuenta en Netlify Blobs, por día UTC)
  const limit = parseInt(process.env.IA_DAILY_LIMIT || "400", 10);
  try {
    const usage = store("ia_usage");
    const key = `${username}:${new Date().toISOString().slice(0, 10)}`;
    const used = parseInt((await usage.get(key)) || "0", 10) || 0;
    if (used >= limit) return json(429, { error: "Llegaste al límite diario de uso de Alma. Vuelve a intentar mañana." });
    await usage.set(key, String(used + 1));
  } catch (e) {
    // si el contador falla, no bloqueamos a la persona (solo lo registramos)
    console.error("ia_usage:", e.message);
  }

  // 3) Armar la petición a Gemini
  const prompt = body.prompt;
  if (!prompt || typeof prompt !== "string") return json(400, { error: "Falta el prompt" });

  const media = body.media || body.image; // "image" = formato antiguo
  const parts = [{ text: prompt }];
  if (media && media.data) {
    const mediaType = String(media.mediaType || "image/png");
    if (!ALLOWED_MEDIA.test(mediaType)) return json(415, { error: "Tipo de archivo no permitido: " + mediaType });
    if (String(media.data).length > MAX_MEDIA_BASE64) return json(413, { error: "El archivo es demasiado grande para enviarlo de una vez." });
    // Gemini espera el tipo sin parámetros extra (ej. "audio/webm;codecs=opus" → "audio/webm")
    parts.push({ inline_data: { mime_type: mediaType.split(";")[0], data: media.data } });
  }

  // Opcional (nuevo): "json: true" pide a Gemini responder SOLO JSON válido, y
  // "temperature" (0 a 1) baja la creatividad para tareas que exigen precisión
  // (ej. Alma Idiomas). Si no se envían, todo funciona como antes.
  let generationConfig = null;
  if (body.json === true || typeof body.temperature === "number") {
    generationConfig = {};
    if (body.json === true) generationConfig.responseMimeType = "application/json";
    if (typeof body.temperature === "number" && body.temperature >= 0 && body.temperature <= 1) generationConfig.temperature = body.temperature;
  }

  const modelo = "gemini-3.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${API_KEY}`;

  try {
    const respuesta = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ contents: [{ parts }] }, generationConfig ? { generationConfig } : {})),
    });
    const datos = await respuesta.json().catch(() => ({}));

    // Si Gemini responde con error (cuota agotada, clave inválida, etc.), lo
    // decimos claramente en vez de devolver un texto falso con código 200.
    if (!respuesta.ok) {
      const msg = (datos && datos.error && datos.error.message) || ("HTTP " + respuesta.status);
      console.error("Gemini error:", respuesta.status, msg);
      return json(respuesta.status === 429 ? 429 : 502, { error: "La IA no pudo responder: " + msg });
    }

    const texto = (datos?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || "").join("").trim();
    if (!texto) {
      const reason = datos?.promptFeedback?.blockReason || datos?.candidates?.[0]?.finishReason || "sin texto";
      return json(502, { error: "La IA no devolvió respuesta (" + reason + ")." });
    }
    // Medición de uso (para estimar costos): tokens que informa Gemini, por persona y día.
    // Solo números: nunca se guarda el contenido de la consulta.
    try {
      const um = datos.usageMetadata || {};
      const tk = store("ia_tokens");
      const key = `${username}:${new Date().toISOString().slice(0, 10)}`;
      const cur = (await tk.get(key, { type: "json" })) || { calls: 0, input: 0, output: 0, thinking: 0 };
      cur.calls += 1;
      cur.input += um.promptTokenCount || 0;
      cur.output += um.candidatesTokenCount || 0;
      cur.thinking += um.thoughtsTokenCount || 0;   // Google cobra el "pensamiento" como salida
      await tk.set(key, JSON.stringify(cur));
    } catch (e) { console.error("ia_tokens:", e.message); }
    return json(200, { texto });
  } catch (error) {
    return json(500, { error: "Error al hablar con la IA: " + error.message });
  }
};
