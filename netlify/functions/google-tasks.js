// ────────────────────────────────────────────────────────────────
//  FUNCIÓN "google-tasks" — Trae tus tareas de Google Tasks (las que
//  creas en Gmail con "Agregar a Tareas") y marca como completadas las
//  que terminas en TaskFlow.
//  Usa la misma conexión con Google que Google Calendar (google-helpers).
//  Acciones:
//   - status   → ¿hay permiso de Google Tasks? + tus listas
//   - sync     → tareas de las listas elegidas (solo los campos necesarios)
//   - complete → marca una tarea como completada en Google
//   - reopen   → la vuelve a dejar pendiente (por si deshaces en TaskFlow)
// ────────────────────────────────────────────────────────────────

const { getUsernameFromSession, getValidGoogleAccessToken } = require("./google-helpers");

function json(statusCode, obj) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) };
}
const API = "https://tasks.googleapis.com/tasks/v1";
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const clip = (v, n) => String(v || "").slice(0, n);

async function gfetch(accessToken, path, opts) {
  const r = await fetch(API + path, Object.assign({}, opts || {}, {
    headers: Object.assign({ Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, (opts && opts.headers) || {}),
  }));
  let body = null;
  try { body = await r.json(); } catch (e) {}
  return { ok: r.ok, status: r.status, body };
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") return json(405, { error: "Método no permitido" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "Cuerpo inválido" }); }
  const { token, action } = body;

  try {
    const username = await getUsernameFromSession(token);
    if (!username) return json(401, { error: "Sesión inválida" });
    const accessToken = await getValidGoogleAccessToken(username);
    if (!accessToken) return json(200, { connected: false });

    if (action === "status") {
      const r = await gfetch(accessToken, "/users/@me/lists?maxResults=100");
      // 403 = la conexión con Google existe, pero sin el permiso de Google Tasks (hay que reconectar)
      if (r.status === 403 || r.status === 401) return json(200, { connected: true, needsScope: true });
      if (!r.ok) return json(502, { error: "Google Tasks no respondió" });
      const lists = ((r.body && r.body.items) || []).map((l) => ({ id: l.id, title: clip(l.title, 120) }));
      return json(200, { connected: true, needsScope: false, lists });
    }

    if (action === "sync") {
      const listIds = (Array.isArray(body.lists) ? body.lists : []).map(String).filter((x) => ID_RE.test(x)).slice(0, 10);
      const out = [];
      for (const listId of listIds) {
        let pageToken = "", pages = 0;
        do {
          const q = new URLSearchParams({ maxResults: "100", showCompleted: "true", showHidden: "true", showDeleted: "true" });
          if (pageToken) q.set("pageToken", pageToken);
          const r = await gfetch(accessToken, `/lists/${encodeURIComponent(listId)}/tasks?` + q.toString());
          if (r.status === 403 || r.status === 401) return json(200, { connected: true, needsScope: true });
          if (r.status === 404) break; // la lista ya no existe
          if (!r.ok) return json(502, { error: "Google Tasks no respondió" });
          for (const t of (r.body && r.body.items) || []) {
            if (!t.title && !t.notes) continue; // tareas vacías
            const email = (t.links || []).find((l) => l && l.type === "email");
            out.push({
              id: t.id, listId, title: clip(t.title, 200), notes: clip(t.notes, 1500),
              due: t.due ? String(t.due).slice(0, 10) : "",       // Google solo guarda el día (sin hora)
              status: t.status === "completed" ? "completed" : "needsAction",
              deleted: !!t.deleted, updated: t.updated || "",
              emailLink: email ? clip(email.link, 500) : "", emailSubject: email ? clip(email.description, 200) : "",
            });
          }
          pageToken = (r.body && r.body.nextPageToken) || "";
          pages++;
        } while (pageToken && pages < 10);
      }
      return json(200, { connected: true, needsScope: false, tasks: out });
    }

    if (action === "complete" || action === "reopen") {
      const listId = String(body.listId || ""), taskId = String(body.taskId || "");
      if (!ID_RE.test(listId) || !ID_RE.test(taskId)) return json(400, { error: "Tarea no válida" });
      const patch = action === "complete" ? { status: "completed" } : { status: "needsAction", completed: null };
      const r = await gfetch(accessToken, `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, { method: "PATCH", body: JSON.stringify(patch) });
      if (r.status === 403 || r.status === 401) return json(200, { ok: false, needsScope: true });
      if (r.status === 404) return json(200, { ok: false, notFound: true });
      if (!r.ok) return json(502, { error: "Google Tasks no respondió" });
      return json(200, { ok: true, status: r.body && r.body.status });
    }

    return json(400, { error: "Acción no reconocida" });
  } catch (err) {
    return json(500, { error: "Error interno: " + err.message });
  }
};
