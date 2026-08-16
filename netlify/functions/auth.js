// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "auth" — Registro (con código de invitación), login,
//  verificación de sesión, y recuperar/restablecer clave por correo.
// ────────────────────────────────────────────────────────────────
//  Guarda usuarios y sesiones en Netlify Blobs. Las claves NUNCA se
//  guardan en texto plano: se guardan con hash + sal (crypto de Node).
//  Para recuperar clave, se manda un correo con un link de un solo
//  uso, usando la cuenta de Gmail del proyecto vía SMTP.
// ────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");
const nodemailer = require("nodemailer");

// En algunos despliegues, Netlify Blobs no se configura solo dentro de la función
// y hay que decirle explícitamente a qué sitio conectarse y con qué credencial.
// Si NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN están configurados, los usamos; si no,
// dejamos que se configure automáticamente (comportamiento normal en Netlify).
function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) {
    return getStore({ name, siteID, token });
  }
  return getStore(name);
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function sendResetEmail(toEmail, resetLink) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("Falta configurar GMAIL_USER / GMAIL_APP_PASSWORD en Netlify");
  }
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
  await transporter.sendMail({
    from: `"TaskFlow Pro" <${user}>`,
    to: toEmail,
    subject: "Recupera tu clave de TaskFlow Pro",
    text: `Recibimos una solicitud para restablecer tu clave.\n\nEntra a este link para elegir una clave nueva (válido por 1 hora):\n${resetLink}\n\nSi no fuiste tú, ignora este correo.`,
    html: `<p>Recibimos una solicitud para restablecer tu clave.</p><p><a href="${resetLink}">Haz clic aquí para elegir una clave nueva</a> (válido por 1 hora).</p><p>Si no fuiste tú, ignora este correo.</p>`,
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Método no permitido" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Cuerpo de la petición inválido" });
  }

  const { action, username, password, token, email, inviteCode, siteUrl } = body;

  try {
    const users = store("users");
    const sessions = store("sessions");
    const resets = store("password_resets");

    if (action === "register") {
      const requiredInvite = process.env.INVITE_CODE;
      if (requiredInvite && requiredInvite.trim() && inviteCode !== requiredInvite) {
        return json(403, { error: "Código de invitación incorrecto" });
      }
      if (!username || !password || !email) return json(400, { error: "Falta usuario, clave o correo" });
      const uname = String(username).trim().toLowerCase();
      if (!/^[a-z0-9_.-]{3,30}$/.test(uname)) {
        return json(400, { error: "El usuario debe tener 3-30 caracteres: letras, números, punto, guion o guion bajo" });
      }
      if (String(password).length < 6) {
        return json(400, { error: "La clave debe tener al menos 6 caracteres" });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
        return json(400, { error: "Ese correo no parece válido" });
      }
      const existing = await users.get(uname, { type: "json" });
      if (existing) return json(409, { error: "Ese nombre de usuario ya existe" });

      const salt = crypto.randomBytes(16).toString("hex");
      const hash = hashPassword(password, salt);
      await users.set(uname, JSON.stringify({
        hash, salt, email: String(email).trim(), createdAt: new Date().toISOString(),
      }));

      const tok = randomToken();
      await sessions.set(tok, JSON.stringify({ username: uname, createdAt: new Date().toISOString() }));
      return json(200, { token: tok, username: uname });
    }

    if (action === "login") {
      if (!username || !password) return json(400, { error: "Falta usuario o clave" });
      const uname = String(username).trim().toLowerCase();
      const rec = await users.get(uname, { type: "json" });
      if (!rec) return json(401, { error: "Usuario o clave incorrectos" });
      const hash = hashPassword(password, rec.salt);
      if (hash !== rec.hash) return json(401, { error: "Usuario o clave incorrectos" });

      const tok = randomToken();
      await sessions.set(tok, JSON.stringify({ username: uname, createdAt: new Date().toISOString() }));
      return json(200, { token: tok, username: uname });
    }

    if (action === "verify") {
      if (!token) return json(400, { error: "Falta token" });
      const rec = await sessions.get(token, { type: "json" });
      if (!rec) return json(200, { valid: false });
      return json(200, { valid: true, username: rec.username });
    }

    if (action === "logout") {
      if (token) await sessions.delete(token);
      return json(200, { ok: true });
    }

    if (action === "forgotPassword") {
      if (!username) return json(400, { error: "Falta el usuario" });
      const uname = String(username).trim().toLowerCase();
      const rec = await users.get(uname, { type: "json" });
      // Por seguridad, respondemos "ok" igual exista o no la cuenta (para no revelar
      // qué usuarios existen), pero solo mandamos el correo si sí existe.
      if (rec && rec.email) {
        const resetTok = randomToken();
        await resets.set(resetTok, JSON.stringify({
          username: uname,
          expiresAt: Date.now() + 60 * 60 * 1000, // 1 hora
        }));
        const base = (siteUrl || "").replace(/\/$/, "");
        const link = `${base}/?reset=${resetTok}`;
        try {
          await sendResetEmail(rec.email, link);
        } catch (mailErr) {
          return json(500, { error: "No se pudo enviar el correo: " + mailErr.message });
        }
      }
      return json(200, { ok: true });
    }

    if (action === "resetPassword") {
      const { newPassword } = body;
      if (!token || !newPassword) return json(400, { error: "Falta información para restablecer la clave" });
      if (String(newPassword).length < 6) return json(400, { error: "La clave debe tener al menos 6 caracteres" });
      const rec = await resets.get(token, { type: "json" });
      if (!rec || rec.expiresAt < Date.now()) {
        return json(400, { error: "El link para restablecer la clave ya no es válido. Solicita uno nuevo." });
      }
      const userRec = await users.get(rec.username, { type: "json" });
      if (!userRec) return json(404, { error: "Esa cuenta ya no existe" });
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = hashPassword(newPassword, salt);
      await users.set(rec.username, JSON.stringify(Object.assign({}, userRec, { hash, salt })));
      await resets.delete(token);
      return json(200, { ok: true });
    }

    return json(400, { error: "Acción no reconocida" });
  } catch (err) {
    return json(500, { error: "Error interno: " + err.message });
  }
};
