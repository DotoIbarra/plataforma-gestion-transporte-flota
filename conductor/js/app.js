/* ==========================================================================
   MIS RUTAS — app del conductor
   Usa el MISMO proyecto Supabase que el panel web (js/supabase-config.js),
   pero autenticado (Supabase Auth). Cada conductor solo ve y administra
   sus propias rutas — lo aplica Postgres con Row Level Security, esto en
   el navegador es solo la interfaz.
   ========================================================================== */

// persistSession:false => la sesión NO se guarda en localStorage del teléfono.
// Cada vez que se abre/recarga la app se exige login de nuevo, así nunca se
// "arrastra" por error la cuenta de otro conductor que haya usado este mismo
// teléfono antes (pruebas, préstamo del teléfono, etc). La identidad de cada
// carga siempre sale de un login real contra el servidor, nunca de un token
// viejo cacheado en el navegador.
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});
const EMAIL_DOMAIN = "conductor.flota.app"; // dominio interno, el conductor nunca lo ve

let session = null;
let profile = null;      // fila propia de "conductores"
let flotaPlacas = [];    // [{value,label}]
let estadosCat = ["Disponible","En viaje","En mantenimiento","No disponible"];
let rutas = [];
let authBusy = false;
let realtimeChannel = null;

/* ---------------------------------------------------------------- utils */
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const todayISO = () => new Date().toISOString().slice(0,10);
const fmtDate = iso => { if(!iso) return "—"; const d = new Date(iso+"T00:00:00"); return isNaN(d) ? iso : d.toLocaleDateString("es-CL", {day:"2-digit",month:"short",year:"numeric"}); };
const fmtMoney = n => Math.round(Number(n)||0).toLocaleString("es-CL");

function toast(msg){
  const t = $("#toast");
  clearTimeout(toast._t);
  t.textContent = msg;
  t.classList.add("show");
  toast._t = setTimeout(()=> t.classList.remove("show"), 2600);
}

/* Teléfono → solo dígitos, 8 a 15 (evita inyectar caracteres raros en el
   correo interno que arma la cuenta). */
function normalizePhone(raw){ return String(raw||"").replace(/\D/g, ""); }
function isValidPhone(digits){ return /^[0-9]{8,15}$/.test(digits); }
function phoneToEmail(digits){ return `driver${digits}@${EMAIL_DOMAIN}`; }

function isValidPassword(pw){
  return typeof pw === "string" && pw.length >= 8 && pw.length <= 72 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}

function mapAuthError(error){
  const m = (error && error.message) || "";
  if(/Invalid login credentials/i.test(m)) return "Teléfono o contraseña incorrectos.";
  if(/already registered|already exists|User already registered/i.test(m)) return "Ese teléfono ya tiene una cuenta. Inicia sesión.";
  if(/Password should be|password/i.test(m) && /least/i.test(m)) return "La contraseña no cumple los requisitos mínimos.";
  if(/rate limit|too many/i.test(m)) return "Demasiados intentos. Espera un minuto y vuelve a intentar.";
  if(/network/i.test(m)) return "No hay conexión a internet.";
  return "No se pudo completar la operación. Intenta de nuevo.";
}

function fileToCompressedDataURL(file, maxDim=1000, quality=0.72){
  return new Promise((resolve, reject) => {
    if(!file.type.startsWith("image/")){ reject(new Error("El archivo seleccionado no es una imagen")); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if(width > maxDim || height > maxDim){
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width*scale); height = Math.round(height*scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("No se pudo procesar la imagen"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("No se pudo leer la imagen"));
    reader.readAsDataURL(file);
  });
}

/* ==========================================================================
   PANTALLA DE ACCESO (login / registro)
   ========================================================================== */
function renderAuth(mode="login"){
  const app = $("#app");
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-brand">
        <div class="mark"><span>🗺️</span></div>
        <b>Mis Rutas</b>
        <small>Acceso de conductores</small>
      </div>
      <div class="auth-card">
        <div class="auth-tabs">
          <button class="auth-tab ${mode==='login'?'active':''}" data-tab="login">Iniciar sesión</button>
          <button class="auth-tab ${mode==='signup'?'active':''}" data-tab="signup">Registrarme</button>
        </div>
        <div class="auth-error" id="authError"></div>
        <form id="authForm">
          ${mode === "signup" ? `
          <div class="field-row">
            <div class="field"><label>Nombres</label><input id="fNombres" type="text" maxlength="60" autocomplete="given-name" required></div>
            <div class="field"><label>Apellidos</label><input id="fApellidos" type="text" maxlength="60" autocomplete="family-name" required></div>
          </div>` : ``}
          <div class="field">
            <label>Número de teléfono</label>
            <input id="fTelefono" type="tel" inputmode="numeric" maxlength="15" placeholder="Ej: 912345678" autocomplete="tel" required>
          </div>
          <div class="field">
            <label>Contraseña</label>
            <input id="fPassword" type="password" maxlength="72" autocomplete="${mode==='signup'?'new-password':'current-password'}" required>
            ${mode === "signup" ? `<small class="hint">Mínimo 8 caracteres, con letras y números.</small>` : ``}
          </div>
          ${mode === "signup" ? `
          <div class="field">
            <label>Confirmar contraseña</label>
            <input id="fPassword2" type="password" maxlength="72" autocomplete="new-password" required>
          </div>` : ``}
          <button type="submit" class="btn btn-accent" id="authSubmit">${mode==='signup' ? "Crear mi cuenta" : "Entrar"}</button>
        </form>
        <p class="auth-note">${mode==='signup'
          ? "Con tu teléfono y una contraseña. Nadie más puede crear una cuenta con tu número."
          : "Usa el mismo teléfono y contraseña con los que te registraste."}</p>
      </div>
    </div>`;

  $$('.auth-tab').forEach(b => b.addEventListener('click', () => renderAuth(b.dataset.tab)));
  $("#authForm").addEventListener("submit", e => { e.preventDefault(); mode === "signup" ? doSignup() : doLogin(); });
}

function showAuthError(msg){
  const el = $("#authError");
  if(!el) return;
  el.textContent = msg;
  el.classList.add("show");
}

async function doLogin(){
  if(authBusy) return;
  const digits = normalizePhone($("#fTelefono").value);
  const password = $("#fPassword").value;
  $("#authError").classList.remove("show");

  if(!isValidPhone(digits)){ showAuthError("Ingresa un teléfono válido (8 a 15 dígitos)."); return; }
  if(!password){ showAuthError("Ingresa tu contraseña."); return; }

  setAuthBusy(true, "Entrando…");
  // Por seguridad, siempre se cierra cualquier sesión que haya quedado
  // guardada en este dispositivo antes de iniciar con las credenciales que
  // se acaban de ingresar. Así el login SIEMPRE corresponde a la cuenta
  // escrita en el formulario, nunca a una sesión anterior.
  await supabaseClient.auth.signOut();
  const { error } = await supabaseClient.auth.signInWithPassword({ email: phoneToEmail(digits), password });
  setAuthBusy(false, "Entrar");
  if(error){ showAuthError(mapAuthError(error)); return; }
  // onAuthStateChange se encarga de cargar la app
}

async function doSignup(){
  if(authBusy) return;
  const nombres = $("#fNombres").value.trim();
  const apellidos = $("#fApellidos").value.trim();
  const digits = normalizePhone($("#fTelefono").value);
  const password = $("#fPassword").value;
  const password2 = $("#fPassword2").value;
  $("#authError").classList.remove("show");

  if(!nombres || !apellidos){ showAuthError("Ingresa tu nombre y apellido."); return; }
  if(!isValidPhone(digits)){ showAuthError("Ingresa un teléfono válido (8 a 15 dígitos)."); return; }
  if(!isValidPassword(password)){ showAuthError("La contraseña debe tener al menos 8 caracteres, con letras y números."); return; }
  if(password !== password2){ showAuthError("Las contraseñas no coinciden."); return; }

  setAuthBusy(true, "Creando cuenta…");
  const { data, error } = await supabaseClient.auth.signUp({
    email: phoneToEmail(digits),
    password,
    options: { data: { telefono: digits, nombres, apellidos } }
  });
  if(error){ setAuthBusy(false, "Crear mi cuenta"); showAuthError(mapAuthError(error)); return; }

  if(!data.session){
    // Por si el proyecto tiene "confirmar correo" activado igual se intenta
    // entrar directo, porque el correo interno no es real y no puede confirmarse.
    const { error: loginErr } = await supabaseClient.auth.signInWithPassword({ email: phoneToEmail(digits), password });
    setAuthBusy(false, "Crear mi cuenta");
    if(loginErr){ showAuthError("Tu cuenta se creó, pero no se pudo iniciar sesión automáticamente. Contacta al administrador."); return; }
    return;
  }
  setAuthBusy(false, "Crear mi cuenta");
}

let authCooldown = null;
function setAuthBusy(busy, label){
  authBusy = busy;
  const btn = $("#authSubmit");
  if(!btn) return;
  btn.disabled = busy;
  if(label) btn.textContent = busy ? label : label;
}

/* ==========================================================================
   CARGA DE DATOS PROPIOS
   ========================================================================== */
async function loadProfileAndData(){
  $("#app").innerHTML = `<div class="center-loading"><div class="spinner"></div><p>Cargando tus rutas…</p></div>`;

  // La fila de "conductores" la crea/vincula un trigger en el servidor justo
  // al registrarse; puede tardar una fracción de segundo en verse reflejada.
  // Se llama primero a la auto-reparación server-side: vincula la fila de
  // "conductores" si faltaba (cuenta creada antes del trigger, o a mano) y
  // engancha cualquier ruta que el admin le haya creado por nombre y que
  // todavía no tenga conductorAuthId. Es idempotente — no hace nada si ya
  // estaba todo enlazado, así que es seguro llamarla en cada carga.
  let prof = null;
  const { data: repaired, error: repairErr } = await supabaseClient.rpc("link_my_conductor_profile");
  if(!repairErr && repaired && repaired.nro) prof = repaired;

  // Si aún así no aparece (posible carrera justo después del registro,
  // mientras el trigger de creación todavía no terminaba), se reintenta
  // la lectura directa unos segundos.
  for(let i=0; i<5 && !prof; i++){
    const { data } = await supabaseClient.from("conductores").select("*").eq("authUserId", session.user.id).maybeSingle();
    if(data){ prof = data; break; }
    await new Promise(r => setTimeout(r, 400));
  }

  profile = prof;

  const [{ data: flota }, { data: cat }, { data: misRutas }] = await Promise.all([
    supabaseClient.from("flota").select("placa,marca,modelo").order("placa"),
    supabaseClient.from("app_storage").select("value").eq("key", "flota_catalogos_v1").maybeSingle(),
    supabaseClient.from("rutas").select("*").order("fechaSalida", { ascending: false }),
  ]);

  flotaPlacas = (flota || []).map(v => ({ value: v.placa, label: `${v.placa} — ${v.marca} ${v.modelo}` }));
  if(cat && cat.value && Array.isArray(cat.value.estadosVehiculo)) estadosCat = cat.value.estadosVehiculo;
  rutas = await purgeClosedRoutes(misRutas || []);

  renderApp();
  watchRealtime();
}

function watchRealtime(){
  if(realtimeChannel) supabaseClient.removeChannel(realtimeChannel);
  realtimeChannel = supabaseClient
    .channel("mis-rutas-" + (session?.user?.id || "anon"))
    .on("postgres_changes",
      { event: "*", schema: "public", table: "rutas", filter: `conductorAuthId=eq.${session.user.id}` },
      async () => {
        const { data } = await supabaseClient.from("rutas").select("*").order("fechaSalida", { ascending: false });
        rutas = await purgeClosedRoutes(data || []);
        if($("#routeList")) renderRouteList();
      })
    .subscribe();
}

// Una ruta cerrada (con report/fotoFin) ya no le sirve al conductor en su
// lista: se oculta de su vista local. IMPORTANTE: "rutas" es una tabla
// compartida con el panel de admin (y de ahí nace el registro "espejo" en
// Fletes), así que esto NUNCA debe borrar la fila en Supabase — solo se
// filtra del arreglo que ve el conductor en su propia pantalla.
function purgeClosedRoutes(list){
  return list.filter(r => !isRouteClosed(r));
}

/* ==========================================================================
   APP PRINCIPAL
   ========================================================================== */
function computeIngreso(r){ return (Number(r.pesoCarga)||0) * (Number(r.costoPorKg)||0); }

// Una ruta queda "cerrada" en cuanto tiene foto de report (fotoFin) guardada.
// A partir de ahí ya no se puede editar ni eliminar desde la app.
function isRouteClosed(r){ return !!(r && r.fotoFin); }

function estadoBadgeClass(estado){
  if(estado === "En viaje") return "badge-accent";
  if(estado === "Disponible") return "badge-ok";
  return "badge-neutral";
}

function renderApp(){
  const nombreCompleto = profile ? `${profile.nombres||""} ${profile.apellidos||""}`.trim() : "Conductor";
  $("#app").innerHTML = `
    <div class="topbar">
      <div class="who"><b>${esc(nombreCompleto || "Conductor")}</b><small>Mis rutas de viaje</small></div>
      <button id="btnLogout">Salir</button>
    </div>
    <div class="list-wrap" id="routeList"></div>
  `;
  renderRouteList();
  $("#btnLogout").addEventListener("click", async () => {
    const { error } = await supabaseClient.auth.signOut();
    if(error) toast("No se pudo cerrar sesión, revisa tu conexión e intenta de nuevo.");
  });
}

function renderRouteList(){
  const wrap = $("#routeList");
  if(!wrap) return;
  if(!rutas.length){
    wrap.innerHTML = `<div class="list-empty"><span class="ico">🗺️</span>Todavía no tienes rutas registradas.<br>Toca el botón <b>+</b> para crear la primera.</div>`;
    return;
  }
  wrap.innerHTML = rutas.map(r => {
    return `
    <div class="route-card">
      <div class="rc-top">
        <div class="rc-route">${esc(r.origen||"—")}<span class="arrow">→</span>${esc(r.destino||"—")}</div>
        ${r.estado ? `<span class="badge ${estadoBadgeClass(r.estado)}">${esc(r.estado)}</span>` : ``}
      </div>
      <div class="rc-meta">
        <span>📅 <b>${fmtDate(r.fechaSalida)}</b>${r.fechaLlegada ? ` → ${fmtDate(r.fechaLlegada)}` : ``}</span>
        ${r.placa ? `<span>🚚 <b>${esc(r.placa)}</b></span>` : ``}
        ${(r.pesoCarga || r.costoPorKg) ? `<span>💵 <b>$${fmtMoney(computeIngreso(r))}</b></span>` : ``}
      </div>
      <div class="rc-actions">
        <button data-edit="${r.nro}">✎ Editar</button>
      </div>
    </div>`;
  }).join("");
  $$('[data-edit]', wrap).forEach(b => b.addEventListener('click', () => openRouteForm(rutas.find(r => String(r.nro) === b.dataset.edit))));
}

/* ---------------------------------------------------------------- formulario de ruta */
function openRouteForm(existing){
  if(existing && isRouteClosed(existing)){ toast("Esta ruta ya está cerrada y no se puede editar."); return; }
  const isEdit = !!existing;
  const draft = existing ? { ...existing } : { fechaSalida: todayISO(), estado: estadosCat[0] || "" };
  const imageDraft = { fotoInicio: draft.fotoInicio || "", fotoFin: draft.fotoFin || "" };

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.id = "overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-head">
        <h3>${isEdit ? "Editar ruta" : "Nueva ruta"}</h3>
        <button class="sheet-close" id="sheetClose">✕</button>
      </div>
      <form id="routeForm">
        <div class="field"><label>Conductor</label><div class="field-static">${esc(`${profile?.nombres||""} ${profile?.apellidos||""}`.trim() || "Yo")}</div></div>
        <div class="field-row">
          <div class="field"><label>Fecha salida *</label><input type="date" id="fFechaSalida" value="${esc(draft.fechaSalida||"")}" required></div>
          <div class="field"><label>Fecha llegada</label><input type="date" id="fFechaLlegada" value="${esc(draft.fechaLlegada||"")}"></div>
        </div>
        <div class="field">
          <label>Placa *</label>
          <select id="fPlaca" required>
            <option value="">— Seleccionar —</option>
            ${flotaPlacas.map(p => `<option value="${esc(p.value)}" ${draft.placa===p.value?"selected":""}>${esc(p.label)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>Estado del vehículo</label>
          <select id="fEstado">
            ${estadosCat.map(e => `<option value="${esc(e)}" ${draft.estado===e?"selected":""}>${esc(e)}</option>`).join("")}
          </select>
        </div>
        <div class="field-row">
          <div class="field"><label>Origen</label><input type="text" id="fOrigen" maxlength="200" value="${esc(draft.origen||"")}"></div>
          <div class="field"><label>Destino</label><input type="text" id="fDestino" maxlength="200" value="${esc(draft.destino||"")}"></div>
        </div>
        <div class="image-field" data-image-field="fotoInicio">
          <label>Foto de inicio de ruta</label>
          <div class="image-preview-box">${imageDraft.fotoInicio ? `<img src="${imageDraft.fotoInicio}">` : `<span class="image-placeholder">📷 Sin foto</span>`}</div>
          <div class="image-actions">
            <button type="button" class="btn-sm" data-image-pick-camera="fotoInicio">📷 Tomar foto</button>
            <button type="button" class="btn-sm" data-image-pick-gallery="fotoInicio">🖼️ Galería</button>
            ${imageDraft.fotoInicio ? `<button type="button" class="btn-sm danger" data-image-remove="fotoInicio">Quitar</button>` : ``}
          </div>
          <input type="file" accept="image/*" capture="environment" id="file-camera-fotoInicio" hidden>
          <input type="file" accept="image/*" id="file-gallery-fotoInicio" hidden>
        </div>
        <div class="image-field" data-image-field="fotoFin">
          <label>Report</label>
          <div class="image-preview-box">${imageDraft.fotoFin ? `<img src="${imageDraft.fotoFin}">` : `<span class="image-placeholder">📷 Sin foto</span>`}</div>
          <div class="image-actions">
            <button type="button" class="btn-sm" data-image-pick-camera="fotoFin">📷 Tomar foto</button>
            <button type="button" class="btn-sm" data-image-pick-gallery="fotoFin">🖼️ Galería</button>
            ${imageDraft.fotoFin ? `<button type="button" class="btn-sm danger" data-image-remove="fotoFin">Quitar</button>` : ``}
          </div>
          <small class="hint">Al guardar con esta foto, la ruta queda cerrada y ya no se podrá editar ni eliminar.</small>
          <input type="file" accept="image/*" capture="environment" id="file-camera-fotoFin" hidden>
          <input type="file" accept="image/*" id="file-gallery-fotoFin" hidden>
        </div>
        <div class="field-row">
          <div class="field"><label>Peso carga (Kg)</label><input type="number" step="any" id="fPeso" value="${draft.pesoCarga ?? ""}"></div>
          <div class="field"><label>Costo x Kg ($)</label><input type="number" step="any" id="fCosto" value="${draft.costoPorKg ?? ""}"></div>
        </div>
        <div class="field"><label>Observaciones</label><textarea id="fObs" maxlength="2000" rows="3">${esc(draft.observaciones||"")}</textarea></div>
        <button type="submit" class="btn btn-accent" id="routeSubmit">${isEdit ? "Guardar cambios" : "Crear ruta"}</button>
      </form>
    </div>`;
  document.body.appendChild(overlay);

  const closeSheet = () => overlay.remove();
  $("#sheetClose", overlay).addEventListener("click", closeSheet);
  overlay.addEventListener("click", e => { if(e.target.id === "overlay") closeSheet(); });

  ["fotoInicio","fotoFin"].forEach(key => {
    const handlePicked = async e => {
      const file = e.target.files[0];
      if(!file) return;
      try{
        imageDraft[key] = await fileToCompressedDataURL(file);
        rerenderImageField(overlay, key, imageDraft);
      }catch(err){ toast(err.message || "No se pudo procesar la imagen"); }
    };
    $(`[data-image-pick-camera="${key}"]`, overlay).addEventListener("click", () => $(`#file-camera-${key}`, overlay).click());
    $(`[data-image-pick-gallery="${key}"]`, overlay).addEventListener("click", () => $(`#file-gallery-${key}`, overlay).click());
    $(`#file-camera-${key}`, overlay).addEventListener("change", handlePicked);
    $(`#file-gallery-${key}`, overlay).addEventListener("change", handlePicked);
    const removeBtn = $(`[data-image-remove="${key}"]`, overlay);
    if(removeBtn) removeBtn.addEventListener("click", () => { imageDraft[key] = ""; rerenderImageField(overlay, key, imageDraft); });
  });

  $("#routeForm", overlay).addEventListener("submit", e => {
    e.preventDefault();
    submitRoute(existing, imageDraft, overlay);
  });
}

function rerenderImageField(overlay, key, imageDraft){
  const box = $(`[data-image-field="${key}"]`, overlay);
  const val = imageDraft[key];
  box.querySelector(".image-preview-box").innerHTML = val ? `<img src="${val}">` : `<span class="image-placeholder">📷 Sin foto</span>`;
  box.querySelector(".image-actions").innerHTML = `
    <button type="button" class="btn-sm" data-image-pick-camera="${key}">📷 Tomar foto</button>
    <button type="button" class="btn-sm" data-image-pick-gallery="${key}">🖼️ Galería</button>
    ${val ? `<button type="button" class="btn-sm danger" data-image-remove="${key}">Quitar</button>` : ``}`;
  box.querySelector(`[data-image-pick-camera="${key}"]`).addEventListener("click", () => $(`#file-camera-${key}`, overlay).click());
  box.querySelector(`[data-image-pick-gallery="${key}"]`).addEventListener("click", () => $(`#file-gallery-${key}`, overlay).click());
  const rb = box.querySelector(`[data-image-remove="${key}"]`);
  if(rb) rb.addEventListener("click", () => { imageDraft[key] = ""; rerenderImageField(overlay, key, imageDraft); });
}

async function submitRoute(existing, imageDraft, overlay){
  const nombreCompleto = `${profile?.nombres||""} ${profile?.apellidos||""}`.trim();
  const placa = $("#fPlaca", overlay).value;
  const fechaSalida = $("#fFechaSalida", overlay).value;
  if(!placa || !fechaSalida){ toast("Falta completar Placa o Fecha salida"); return; }

  const payload = {
    fechaSalida,
    fechaLlegada: $("#fFechaLlegada", overlay).value || null,
    placa,
    estado: $("#fEstado", overlay).value || "",
    conductor: nombreCompleto,
    origen: $("#fOrigen", overlay).value.trim(),
    destino: $("#fDestino", overlay).value.trim(),
    fotoInicio: imageDraft.fotoInicio || "",
    fotoFin: imageDraft.fotoFin || "",
    pesoCarga: $("#fPeso", overlay).value === "" ? null : Number($("#fPeso", overlay).value),
    costoPorKg: $("#fCosto", overlay).value === "" ? null : Number($("#fCosto", overlay).value),
    observaciones: $("#fObs", overlay).value.trim(),
  };

  const btn = $("#routeSubmit", overlay);
  btn.disabled = true;

  if(existing){
    const { error } = await supabaseClient.from("rutas").update(payload).eq("nro", existing.nro);
    btn.disabled = false;
    if(error){ console.error(error); toast("No se pudo guardar la ruta"); return; }
    const idx = rutas.findIndex(r => r.nro === existing.nro);
    if(idx !== -1) rutas[idx] = { ...rutas[idx], ...payload };
    toast("Ruta actualizada");
  } else {
    // Sin "nro": la base de datos lo asigna sola (secuencia compartida con
    // el panel web), así nunca choca con una ruta creada por otro conductor
    // o por el administrador al mismo tiempo.
    const { data, error } = await supabaseClient.from("rutas").insert(payload).select().single();
    btn.disabled = false;
    if(error){ console.error(error); toast("No se pudo crear la ruta"); return; }
    rutas.unshift(data);
    toast("Ruta creada");
  }
  overlay.remove();
  renderRouteList();
}

/* ==========================================================================
   INIT
   ========================================================================== */
supabaseClient.auth.onAuthStateChange((event, s) => {
  session = s;
  if(event === "SIGNED_IN" || (event === "INITIAL_SESSION" && s)){
    loadProfileAndData();
  } else if(event === "SIGNED_OUT"){
    if(realtimeChannel){ supabaseClient.removeChannel(realtimeChannel); realtimeChannel = null; }
    profile = null; rutas = [];
    renderAuth("login");
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  const { data } = await supabaseClient.auth.getSession();
  session = data.session;
  if(!session){ renderAuth("login"); return; }

  // getSession() solo lee lo que quedó guardado en este dispositivo; antes
  // de confiar en eso, se confirma contra el servidor de Supabase que ese
  // usuario sigue siendo válido (getUser() sí consulta el servidor). Si no
  // lo es (token viejo, cuenta borrada, etc.), se limpia todo y se vuelve a
  // pedir login en vez de arrastrar datos de una sesión vieja.
  const { data: userData, error: userErr } = await supabaseClient.auth.getUser();
  if(userErr || !userData?.user){
    await supabaseClient.auth.signOut();
    session = null;
    renderAuth("login");
    return;
  }

  await loadProfileAndData();
});
