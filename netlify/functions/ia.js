// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "ia" — El recepcionista seguro que habla con Gemini
// ────────────────────────────────────────────────────────────────
//  Tu app (index.html) le pide cosas a esta función.
//  Esta función tiene la clave secreta (guardada en Netlify, NO en el código)
//  y es la única que habla con Gemini. Así tu clave nunca queda expuesta.
//  Acepta texto (prompt) y, opcionalmente, una imagen (para leer fotos).
// ────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Método no permitido" }) };
  }

  const API_KEY = process.env.GEMINI_API_KEY;
  if (!API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "Falta configurar GEMINI_API_KEY en Netlify" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const prompt = body.prompt;
    const image = body.image; // opcional: { data: base64, mediaType }
    if (!prompt) {
      return { statusCode: 400, body: JSON.stringify({ error: "Falta el prompt" }) };
    }

    const modelo = "gemini-3.5-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${API_KEY}`;

    const parts = [{ text: prompt }];
    if (image && image.data) {
      parts.push({ inline_data: { mime_type: image.mediaType || "image/png", data: image.data } });
    }

    const respuesta = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }] }),
    });

    const datos = await respuesta.json();
    const texto = datos?.candidates?.[0]?.content?.parts?.[0]?.text || "No obtuve respuesta de la IA.";

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texto }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Error al hablar con la IA: " + error.message }),
    };
  }
};
