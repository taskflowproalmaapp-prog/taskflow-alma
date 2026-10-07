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

// ── Sesiones que vencen ──
// Una sesión vence si pasa SESSION_DAYS días (por defecto 90) SIN usarse.
// Cada vez que la persona abre la app ("verify"), se renueva. Así nadie que
// usa la app seguido se ve afectado, pero una sesión olvidada en un
// computador ajeno se cierra sola.
const SESSION_MS = (parseInt(process.env.SESSION_DAYS || "90", 10) || 90) * 24 * 3600 * 1000;
function sessionExpired(rec) {
  // Las sesiones creadas antes de esta regla no tienen "lastSeenAt": se
  // consideran vigentes y empiezan a contar desde su próximo uso (así nadie
  // pierde la sesión de golpe al actualizar la app).
  const last = Date.parse((rec && rec.lastSeenAt) || "");
  if (!last) return false;
  return Date.now() - last > SESSION_MS;
}
// Devuelve el registro de sesión si es válido (y borra el vencido)
async function validSession(sessions, token) {
  if (!token) return null;
  const rec = await sessions.get(token, { type: "json" });
  if (!rec) return null;
  if (sessionExpired(rec)) { try { await sessions.delete(token); } catch (e) {} return null; }
  return rec;
}
// Compara hashes en tiempo constante (evita ataques de medición de tiempo)
function sameHash(a, b) {
  const A = Buffer.from(String(a), "hex"), B = Buffer.from(String(b), "hex");
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// ── Límite de intentos de login ──
// Máx. LOGIN_MAX_ATTEMPTS intentos fallidos (por defecto 8) por usuario en
// 15 minutos. Al acertar la clave, el contador se reinicia.
const LOGIN_MAX = parseInt(process.env.LOGIN_MAX_ATTEMPTS || "8", 10) || 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

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
      const nowIso = new Date().toISOString();
      await sessions.set(tok, JSON.stringify({ username: uname, createdAt: nowIso, lastSeenAt: nowIso }));
      return json(200, { token: tok, username: uname });
    }

    if (action === "login") {
      if (!username || !password) return json(400, { error: "Falta usuario o clave" });
      const uname = String(username).trim().toLowerCase();
      const attempts = store("login_attempts");
      const att = (await attempts.get(uname, { type: "json" })) || { count: 0, firstAt: 0 };
      if (Date.now() - att.firstAt > LOGIN_WINDOW_MS) { att.count = 0; att.firstAt = Date.now(); }
      if (att.count >= LOGIN_MAX) {
        const mins = Math.max(1, Math.ceil((att.firstAt + LOGIN_WINDOW_MS - Date.now()) / 60000));
        return json(429, { error: `Demasiados intentos. Espera ${mins} minuto${mins === 1 ? "" : "s"} o recupera tu clave.` });
      }
      const rec = await users.get(uname, { type: "json" });
      const ok = !!rec && sameHash(hashPassword(password, rec.salt), rec.hash);
      if (!ok) {
        att.count += 1; if (!att.firstAt) att.firstAt = Date.now();
        await attempts.set(uname, JSON.stringify(att));
        return json(401, { error: "Usuario o clave incorrectos" });
      }
      try { await attempts.delete(uname); } catch (e) {}

      const tok = randomToken();
      const nowIso = new Date().toISOString();
      await sessions.set(tok, JSON.stringify({ username: uname, createdAt: nowIso, lastSeenAt: nowIso }));
      return json(200, { token: tok, username: uname });
    }

    if (action === "verify") {
      if (!token) return json(400, { error: "Falta token" });
      const rec = await validSession(sessions, token);
      if (!rec) return json(200, { valid: false });
      // renovar: la sesión vence por INACTIVIDAD, no por antigüedad
      rec.lastSeenAt = new Date().toISOString();
      try { await sessions.set(token, JSON.stringify(rec)); } catch (e) {}
      return json(200, { valid: true, username: rec.username });
    }

    if (action === "logout") {
      if (token) await sessions.delete(token);
      return json(200, { ok: true });
    }

    // Le dice al front-end si la persona que inició sesión es la administradora
    // (para mostrarle o no la pantalla de "Usuarios"). Se define quién es admin
    // con la variable de entorno ADMIN_USERNAME en Netlify.
    if (action === "amIAdmin") {
      if (!token) return json(200, { isAdmin: false });
      const rec = await validSession(sessions, token);
      const adminUser = (process.env.ADMIN_USERNAME || "").trim().toLowerCase();
      const isAdmin = !!(rec && adminUser && rec.username === adminUser);
      return json(200, { isAdmin });
    }

    // Lista todos los usuarios registrados (usuario, correo, fecha de creación).
    // Solo responde si quien pregunta es realmente la cuenta admin — cualquier
    // otra persona recibe un error, aunque tenga sesión válida.
    if (action === "listUsers") {
      if (!token) return json(401, { error: "Falta token" });
      const rec = await validSession(sessions, token);
      const adminUser = (process.env.ADMIN_USERNAME || "").trim().toLowerCase();
      if (!rec || !adminUser || rec.username !== adminUser) {
        return json(403, { error: "No tienes permiso para ver esto" });
      }
      const listing = await users.list();
      const out = [];
      for (const entry of listing.blobs || []) {
        const u = await users.get(entry.key, { type: "json" });
        if (u) out.push({ username: entry.key, email: u.email || "", createdAt: u.createdAt || "" });
      }
      out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // más reciente primero
      return json(200, { users: out });
    }

    // Elimina por completo una cuenta (la cuenta en sí, sus datos guardados, y
    // cualquier sesión activa que tuviera) — solo la administradora puede hacerlo,
    // y no puede eliminarse a sí misma por accidente.
    if (action === "deleteUser") {
      if (!token) return json(401, { error: "Falta token" });
      const rec = await validSession(sessions, token);
      const adminUser = (process.env.ADMIN_USERNAME || "").trim().toLowerCase();
      if (!rec || !adminUser || rec.username !== adminUser) {
        return json(403, { error: "No tienes permiso para hacer esto" });
      }
      const targetUser = String(body.targetUsername || "").trim().toLowerCase();
      if (!targetUser) return json(400, { error: "Falta el usuario a eliminar" });
      if (targetUser === adminUser) {
        return json(400, { error: "No puedes eliminar tu propia cuenta de administrador" });
      }
      const exists = await users.get(targetUser, { type: "json" });
      if (!exists) return json(404, { error: "Ese usuario ya no existe" });

      await users.delete(targetUser);
      const userdata = store("userdata");
      await userdata.delete(targetUser);

      // Limpieza de datos menores de esa persona (contadores, avisos, intentos).
      // Sus sugerencias se conservan para el Panel de mejoras, pero sin su nombre.
      const cleanup = async (storeName, match) => {
        try {
          const st = store(storeName);
          const l = await st.list();
          for (const e of l.blobs || []) if (match(e.key)) await st.delete(e.key);
        } catch (e) { console.error("cleanup " + storeName, e.message); }
      };
      await cleanup("ia_usage", (k) => k.startsWith(targetUser + ":"));
await cleanup("ia_tokens", (k) => k.startsWith(targetUser + ":"));
      await cleanup("send_doc_usage", (k) => k.startsWith(targetUser + ":"));
      await cleanup("usage", (k) => k.endsWith(":" + targetUser));
      await cleanup("push_subscriptions", (k) => k === targetUser);
      await cleanup("login_attempts", (k) => k === targetUser);
      // su conexión con Google Calendar (acceso a su calendario) también se borra
      await cleanup("google_calendar_tokens", (k) => k === targetUser);
      // sus archivos adjuntos y su índice
      await cleanup("attachments", (k) => k.startsWith(targetUser + "/"));
      await cleanup("attachments_index", (k) => k === targetUser);
      try {
        const fb = store("feedback");
        const l = await fb.list({ prefix: "fb:" });
        for (const e of l.blobs || []) {
          const it = await fb.get(e.key, { type: "json" });
          if (it && it.username === targetUser) {
            // sus imágenes pueden tener datos personales: se borran
            for (let i = 0; i < (it.imagenes || 0); i++) { try { await store("feedback_images").delete(`${e.key}:${i}`); } catch (x) {} }
            it.username = "usuario eliminado"; it.conversacion = []; it.imagenes = 0; await fb.set(e.key, JSON.stringify(it));
          }
        }
      } catch (e) { console.error("cleanup feedback", e.message); }

      // cerramos cualquier sesión activa que tuviera esa persona, para que no
      // le quede la app abierta en su celular usando datos ya borrados.
      const sessionListing = await sessions.list();
      for (const entry of sessionListing.blobs || []) {
        const s = await sessions.get(entry.key, { type: "json" });
        if (s && s.username === targetUser) await sessions.delete(entry.key);
      }

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
      // Clave nueva = se cierran todas las sesiones abiertas de esa cuenta
      // (si alguien más tenía la sesión, queda fuera) y se limpian los intentos.
      try {
        const sl = await sessions.list();
        for (const e of sl.blobs || []) {
          const se = await sessions.get(e.key, { type: "json" });
          if (se && se.username === rec.username) await sessions.delete(e.key);
        }
        await store("login_attempts").delete(rec.username);
      } catch (e) { console.error("reset cleanup", e.message); }
      return json(200, { ok: true });
    }

    return json(400, { error: "Acción no reconocida" });
  } catch (err) {
    return json(500, { error: "Error interno: " + err.message });
  }
};
