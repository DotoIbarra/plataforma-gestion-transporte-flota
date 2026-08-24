/* ==========================================================================
   MIS RUTAS — app del conductor
   Habla con la API propia (PHP + MySQL) en vez de Supabase. Cada conductor
   solo ve y administra sus propias rutas — lo aplica el servidor
   (api/conductor_rutas/*.php), esto en el navegador es solo la interfaz.
   ========================================================================== */

// La API vive en public_html/api/, un nivel arriba de public_html/conductor/.
const API_BASE = "../api";

async function apiFetch(path, opts = {}){
  let res;
  try{
    res = await fetch(`${API_BASE}/${path}`, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "include", // imprescindible: así viaja la cookie de sesión del conductor
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch(networkErr){
    return { data: null, error: "No hay conexión a internet." };
  }
  let json = null;
  try{ json = await res.json(); } catch(parseErr){}
  if(!res.ok){
    return { data: null, error: (json && json.error) || `Error ${res.status}` };
  }
  return { data: json, error: null };
}

let profile = null;      // fila propia de "conductores"
let flotaPlacas = [];    // [{value,label}]
let estadosCat = ["Disponible","En viaje","En mantenimiento","No disponible"];
let obrasCat = [];       // catálogo de obras (mismo que usa el panel admin)
let rutas = [];
let incidencias = [];
let tiposIncidenciaCat = ["Accidente de tránsito","Falla mecánica","Retraso de entrega","Daño de carga","Problema con cliente","Robo o pérdida","Conducta del conductor","Otro"];
let gravedadCat = ["Baja","Media","Alta","Crítica"];
let currentTab = "rutas"; // "rutas" | "incidencias"
let authBusy = false;
let realtimeChannel = null; // ahora es un id de setInterval, no un canal de Supabase
let ubicacionInterval = null; // id del setInterval que manda pings de GPS
let avisoUbicacionMostrado = false; // para no repetir el toast de "sin permiso" cada vez

// Flujo de estados del servicio: qué botón mostrarle al conductor según el
// estado actual, y a qué estado avanza al tocarlo (ver api/conductor_rutas/estado.php).
const SIGUIENTE_ESTADO = {
  "Asignado":  { estado: "Aceptado",  label: "✅ Aceptar viaje" },
  "Aceptado":  { estado: "En ruta",   label: "🚚 Iniciar ruta" },
  "En ruta":   { estado: "En destino",label: "📍 Llegué a destino" },
};

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

/* Teléfono → solo dígitos, 8 a 15. */
function normalizePhone(raw){ return String(raw||"").replace(/\D/g, ""); }
function isValidPhone(digits){ return /^[0-9]{8,15}$/.test(digits); }

function isValidPassword(pw){
  return typeof pw === "string" && pw.length >= 8 && pw.length <= 72 && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}

/* El backend ya devuelve mensajes de error en español, listos para mostrar
   directo (ver api/conductor_auth/register.php y login.php) — ya no hace
   falta traducir mensajes de Supabase Auth como antes. */

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
  const { data, error } = await apiFetch("conductor_auth/login.php", { method: "POST", body: { telefono: digits, password } });
  setAuthBusy(false, "Entrar");
  if(error){ showAuthError(error); return; }
  profile = data.conductor;
  await loadProfileAndData();
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
  const { data, error } = await apiFetch("conductor_auth/register.php", {
    method: "POST",
    body: { nombres, apellidos, telefono: digits, password, password2 }
  });
  setAuthBusy(false, "Crear mi cuenta");
  if(error){ showAuthError(error); return; }
  // register.php ya deja la sesión iniciada (igual que hacía Supabase al registrarse).
  profile = data.conductor;
  await loadProfileAndData();
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

  // Ya no hace falta reparar/reintentar el enlace de la cuenta: el backend
  // (api/conductor_auth/login.php y register.php) siempre deja la ficha de
  // "conductores" enlazada de una, sin condiciones de carrera que reparar.
  const [profileRes, refRes, rutasRes, incidenciasRes] = await Promise.all([
    apiFetch("conductor_auth/me.php"),
    apiFetch("conductor_data/reference.php"),
    apiFetch("conductor_rutas/list.php"),
    apiFetch("conductor_incidencias/list.php"),
  ]);

  if(profileRes.error || !profileRes.data.logged_in){
    profile = null; rutas = []; incidencias = [];
    renderAuth("login");
    return;
  }
  profile = profileRes.data.conductor;

  const ref = refRes.data || { flota: [], catalogos: {} };
  flotaPlacas = (ref.flota || []).map(v => ({ value: v.placa, label: `${v.placa} — ${v.marca} ${v.modelo}` }));
  if(Array.isArray(ref.catalogos?.estadosVehiculo)) estadosCat = ref.catalogos.estadosVehiculo;
  // Mismo catálogo de Obras que usa el panel admin, para que la ruta creada
  // por el conductor quede con la misma Obra disponible ahí — sin esto,
  // "obra" quedaba vacío y el flete espejo en Fletes no se podía asociar.
  if(Array.isArray(ref.catalogos?.obras)) obrasCat = ref.catalogos.obras.slice().sort((a,b)=>a.localeCompare(b,"es"));
  if(Array.isArray(ref.catalogos?.tiposIncidencia)) tiposIncidenciaCat = ref.catalogos.tiposIncidencia;
  if(Array.isArray(ref.catalogos?.gravedadIncidencia)) gravedadCat = ref.catalogos.gravedadIncidencia;

  rutas = purgeClosedRoutes((rutasRes.data && rutasRes.data.rows) || []);
  incidencias = (incidenciasRes.data && incidenciasRes.data.rows) || [];

  renderApp();
  watchRealtime();
  actualizarSeguimientoUbicacion();
}

/* ==========================================================================
   SEGUIMIENTO GPS (interino, vía navegador) — mientras la flota no tenga
   GPS instalado en los vehículos, la ubicación se toma del teléfono con el
   que el conductor usa esta app, y solo mientras tiene un servicio activo
   (Aceptado / En ruta / En destino). No se pide ubicación en segundo plano
   ni fuera de esos estados. El día que haya GPS embarcado, esto se puede
   reemplazar o complementar sin tocar el resto del sistema (mismo endpoint,
   misma tabla: ver api/conductor_rutas/ubicacion.php).
   ========================================================================== */
const ESTADOS_CON_SEGUIMIENTO = ["Aceptado","En ruta","En destino"];

function pingUbicacion(nro){
  if(!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      apiFetch("conductor_rutas/ubicacion.php", {
        method: "POST",
        body: { nro, lat: pos.coords.latitude, lng: pos.coords.longitude, precision: Math.round(pos.coords.accuracy || 0) },
      }).catch(()=>{});
    },
    () => {
      if(!avisoUbicacionMostrado){
        avisoUbicacionMostrado = true;
        toast("Activa la ubicación del teléfono para que la empresa pueda ver tu recorrido en el mapa");
      }
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

// Manda un ping ahora mismo y arranca (o detiene) el envío periódico según
// si el conductor tiene algún servicio en curso. Se llama tras cargar los
// datos y cada vez que cambia el estado de una ruta.
function actualizarSeguimientoUbicacion(){
  const activas = rutas.filter(r => ESTADOS_CON_SEGUIMIENTO.includes(r.estadoServicio));
  activas.forEach(r => pingUbicacion(r.nro));

  if(ubicacionInterval){ clearInterval(ubicacionInterval); ubicacionInterval = null; }
  if(activas.length){
    ubicacionInterval = setInterval(() => {
      rutas.filter(r => ESTADOS_CON_SEGUIMIENTO.includes(r.estadoServicio)).forEach(r => pingUbicacion(r.nro));
    }, 120000); // cada 2 minutos, para no drenar la batería del teléfono
  }
}

function watchRealtime(){
  // DIFERENCIA respecto a la versión con Supabase: Postgres avisaba al
  // instante cuando algo cambiaba (Realtime). MySQL no tiene un equivalente
  // disponible en hosting compartido, así que acá se sondea cada 30
  // segundos en su lugar — sigue siendo automático, solo un poco menos
  // inmediato.
  if(realtimeChannel) clearInterval(realtimeChannel);
  realtimeChannel = setInterval(async () => {
    const [rutasRes, incidenciasRes] = await Promise.all([
      apiFetch("conductor_rutas/list.php"),
      apiFetch("conductor_incidencias/list.php"),
    ]);
    if(!rutasRes.error) rutas = purgeClosedRoutes(rutasRes.data.rows || []);
    if(!incidenciasRes.error) incidencias = incidenciasRes.data.rows || [];
    if(currentTab === "rutas" && $("#routeList")) renderRouteList();
    if(currentTab === "incidencias" && $("#incidentList")) renderIncidentList();
    actualizarSeguimientoUbicacion();
  }, 30000);
}

// Una ruta cerrada (con report/fotoFin) ya no le sirve al conductor en su
// lista: se oculta de su vista local. IMPORTANTE: "rutas" es una tabla
// compartida con el panel de admin (y de ahí nace el registro "espejo" en
// Fletes), así que esto NUNCA debe borrar la fila en el servidor — solo se
// filtra del arreglo que ve el conductor en su propia pantalla.
function purgeClosedRoutes(list){
  return list.filter(r => !isRouteClosed(r));
}

/* ==========================================================================
   APP PRINCIPAL
   ========================================================================== */
function computeIngreso(r){ return (Number(r.pesoCarga)||0) * (Number(r.costoPorKg)||0); }

// Una ruta queda "cerrada" en cuanto tiene foto de report (fotoFin) guardada,
// o su estado de servicio ya llegó a un estado terminal (Finalizado/Cancelado).
// A partir de ahí ya no se puede editar ni eliminar desde la app.
function isRouteClosed(r){
  return !!(r && (r.fotoFin || r.estadoServicio === "Finalizado" || r.estadoServicio === "Cancelado"));
}

function estadoBadgeClass(estado){
  if(estado === "En viaje") return "badge-accent";
  if(estado === "Disponible") return "badge-ok";
  return "badge-neutral";
}

// Badge para el ESTADO DEL SERVICIO (asignado→...→finalizado), distinto del
// estado del vehículo (estadoBadgeClass, más arriba).
function servicioBadgeClass(estado){
  if(estado === "En ruta") return "badge-accent";
  if(estado === "En destino" || estado === "Aceptado") return "badge-ok";
  if(estado === "Cancelado") return "badge-danger";
  return "badge-neutral";
}

function gravedadBadgeClass(gravedad){
  if(gravedad === "Alta" || gravedad === "Crítica") return "badge-danger";
  if(gravedad === "Media") return "badge-accent";
  return "badge-neutral";
}

function renderApp(){
  const nombreCompleto = profile ? `${profile.nombres||""} ${profile.apellidos||""}`.trim() : "Conductor";
  $("#app").innerHTML = `
    <div class="topbar">
      <div class="who"><b>${esc(nombreCompleto || "Conductor")}</b><small>${currentTab === "rutas" ? "Mis rutas de viaje" : "Mis incidencias reportadas"}</small></div>
      <button id="btnLogout">Salir</button>
    </div>
    <div class="tabbar">
      <div class="auth-tabs">
        <button class="auth-tab ${currentTab==='rutas'?'active':''}" data-tab="rutas">🗺️ Rutas</button>
        <button class="auth-tab ${currentTab==='incidencias'?'active':''}" data-tab="incidencias">⚠️ Incidencias</button>
      </div>
    </div>
    <div class="list-wrap" id="routeList" style="${currentTab==='rutas'?'':'display:none'}"></div>
    <div class="list-wrap" id="incidentList" style="${currentTab==='incidencias'?'':'display:none'}"></div>
    ${currentTab==='incidencias' ? `<button class="fab" id="btnFab" title="Reportar incidencia">+</button>` : ``}
  `;
  renderRouteList();
  renderIncidentList();
  $("#btnLogout").addEventListener("click", async () => {
    await apiFetch("conductor_auth/logout.php", { method: "POST" });
    if(realtimeChannel){ clearInterval(realtimeChannel); realtimeChannel = null; }
    profile = null; rutas = []; incidencias = [];
    renderAuth("login");
  });
  $$('[data-tab]', $(".tabbar")).forEach(b => b.addEventListener('click', () => {
    currentTab = b.dataset.tab;
    renderApp();
  }));
  // El FAB (+) solo existe en la pestaña de Incidencias: crear rutas es
  // exclusivo del panel admin (el conductor solo ve y avanza las que ya
  // le asignaron), así que en la pestaña "Rutas" no se muestra el botón.
  const btnFab = $("#btnFab");
  if(btnFab) btnFab.addEventListener("click", () => openIncidentForm());
}

function renderRouteList(){
  const wrap = $("#routeList");
  if(!wrap) return;
  if(!rutas.length){
    wrap.innerHTML = `<div class="list-empty"><span class="ico">🗺️</span>Todavía no tienes rutas asignadas.<br>Cuando el equipo de operaciones te asigne un servicio, va a aparecer acá.</div>`;
    return;
  }
  wrap.innerHTML = rutas.map(r => {
    const estadoServicio = r.estadoServicio || "Asignado";
    const siguiente = SIGUIENTE_ESTADO[estadoServicio];
    return `
    <div class="route-card">
      <div class="rc-top">
        <div class="rc-route">${esc(r.origen||"—")}<span class="arrow">→</span>${esc(r.destino||"—")}</div>
        <span class="badge ${servicioBadgeClass(estadoServicio)}">${esc(estadoServicio)}</span>
      </div>
      <div class="rc-meta">
        <span>📅 <b>${fmtDate(r.fechaSalida)}</b>${r.fechaLlegada ? ` → ${fmtDate(r.fechaLlegada)}` : ``}</span>
        ${r.placa ? `<span>🚚 <b>${esc(r.placa)}</b></span>` : ``}
        ${(r.pesoCarga || r.costoPorKg) ? `<span>💵 <b>$${fmtMoney(computeIngreso(r))}</b></span>` : ``}
      </div>
      <div class="rc-actions">
        ${siguiente ? `<button data-avanzar="${r.nro}" data-estado="${siguiente.estado}">${siguiente.label}</button>` : ``}
        ${estadoServicio === "En destino" ? `<button data-edit="${r.nro}">📷 Cerrar con Report</button>` : `<button data-edit="${r.nro}">✎ Editar</button>`}
      </div>
    </div>`;
  }).join("");
  $$('[data-edit]', wrap).forEach(b => b.addEventListener('click', () => openRouteForm(rutas.find(r => String(r.nro) === b.dataset.edit))));
  $$('[data-avanzar]', wrap).forEach(b => b.addEventListener('click', () => cambiarEstadoServicio(Number(b.dataset.avanzar), b.dataset.estado)));
}

// Avanza el estado de un servicio (o lo cancela) usando el endpoint dedicado
// que solo toca esa columna — así nunca se pisa el resto de la ruta.
async function cambiarEstadoServicio(nro, estadoServicio){
  const { data, error } = await apiFetch("conductor_rutas/estado.php", { method: "POST", body: { nro, estadoServicio } });
  if(error){ toast(error); return; }
  const idx = rutas.findIndex(r => r.nro === nro);
  if(idx !== -1) rutas[idx].estadoServicio = data.estadoServicio;
  if(estadoServicio === "Cancelado") rutas = purgeClosedRoutes(rutas);
  toast(estadoServicio === "Cancelado" ? "Servicio cancelado" : `Estado actualizado: ${estadoServicio}`);
  renderRouteList();
  actualizarSeguimientoUbicacion(); // manda un ping ya mismo con la posición actual y ajusta el intervalo
}

/* ==========================================================================
   INCIDENCIAS
   ========================================================================== */
function renderIncidentList(){
  const wrap = $("#incidentList");
  if(!wrap) return;
  if(!incidencias.length){
    wrap.innerHTML = `<div class="list-empty"><span class="ico">⚠️</span>No has reportado incidencias.<br>Toca el botón <b>+</b> para reportar una.</div>`;
    return;
  }
  wrap.innerHTML = incidencias.map(i => `
    <div class="route-card">
      <div class="rc-top">
        <div class="rc-route">${esc(i.tipo||"Incidencia")}</div>
        <span class="badge ${gravedadBadgeClass(i.gravedad)}">${esc(i.gravedad||"—")}</span>
      </div>
      <div class="rc-meta">
        <span>📅 <b>${fmtDate(i.fecha)}</b></span>
        ${i.placa ? `<span>🚚 <b>${esc(i.placa)}</b></span>` : ``}
        <span>🔖 <b>${esc(i.estado||"Abierta")}</b></span>
      </div>
      <div class="rc-meta" style="margin-top:-4px"><span>${esc(i.descripcion||"")}</span></div>
      ${i.solucion ? `<div class="rc-meta"><span>✔ Solución: ${esc(i.solucion)}</span></div>` : ``}
    </div>`).join("");
}

function openIncidentForm(){
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.id = "overlay";
  const imageDraft = { evidencia: "" };
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-head">
        <h3>Reportar incidencia</h3>
        <button class="sheet-close" id="sheetClose">✕</button>
      </div>
      <form id="incidentForm">
        <div class="field">
          <label>Tipo de incidencia *</label>
          <select id="iTipo" required>
            <option value="">— Seleccionar —</option>
            ${tiposIncidenciaCat.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>Gravedad *</label>
          <select id="iGravedad" required>
            ${gravedadCat.map(g => `<option value="${esc(g)}" ${g==='Media'?'selected':''}>${esc(g)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>Ruta relacionada (opcional)</label>
          <select id="iRuta">
            <option value="">— Ninguna —</option>
            ${rutas.map(r => `<option value="${r.nro}">${esc(r.origen||"—")} → ${esc(r.destino||"—")} (${fmtDate(r.fechaSalida)})</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Placa (opcional)</label>
          <select id="iPlaca">
            <option value="">— Ninguna —</option>
            ${flotaPlacas.map(p => `<option value="${esc(p.value)}">${esc(p.label)}</option>`).join("")}
          </select>
        </div>
        <div class="field"><label>Descripción *</label><textarea id="iDescripcion" maxlength="2000" rows="4" required placeholder="Qué pasó, cuándo y dónde"></textarea></div>
        <div class="image-field" data-image-field="evidencia">
          <label>Foto de evidencia (opcional)</label>
          <div class="image-preview-box"><span class="image-placeholder">📷 Sin foto</span></div>
          <div class="image-actions">
            <button type="button" class="btn-sm" data-image-pick-camera="evidencia">📷 Tomar foto</button>
            <button type="button" class="btn-sm" data-image-pick-gallery="evidencia">🖼️ Galería</button>
          </div>
          <input type="file" accept="image/*" capture="environment" id="file-camera-evidencia" hidden>
          <input type="file" accept="image/*" id="file-gallery-evidencia" hidden>
        </div>
        <button type="submit" class="btn btn-accent" id="incidentSubmit">Enviar reporte</button>
      </form>
    </div>`;
  document.body.appendChild(overlay);

  const closeSheet = () => overlay.remove();
  $("#sheetClose", overlay).addEventListener("click", closeSheet);
  overlay.addEventListener("click", e => { if(e.target.id === "overlay") closeSheet(); });

  const handlePicked = async e => {
    const file = e.target.files[0];
    if(!file) return;
    try{
      imageDraft.evidencia = await fileToCompressedDataURL(file);
      rerenderImageField(overlay, "evidencia", imageDraft);
    }catch(err){ toast(err.message || "No se pudo procesar la imagen"); }
  };
  $(`[data-image-pick-camera="evidencia"]`, overlay).addEventListener("click", () => $(`#file-camera-evidencia`, overlay).click());
  $(`[data-image-pick-gallery="evidencia"]`, overlay).addEventListener("click", () => $(`#file-gallery-evidencia`, overlay).click());
  $(`#file-camera-evidencia`, overlay).addEventListener("change", handlePicked);
  $(`#file-gallery-evidencia`, overlay).addEventListener("change", handlePicked);

  $("#incidentForm", overlay).addEventListener("submit", async e => {
    e.preventDefault();
    const tipo = $("#iTipo", overlay).value;
    const descripcion = $("#iDescripcion", overlay).value.trim();
    if(!tipo || !descripcion){ toast("Falta el tipo o la descripción"); return; }
    const payload = {
      tipo,
      gravedad: $("#iGravedad", overlay).value,
      rutaNro: $("#iRuta", overlay).value || null,
      placa: $("#iPlaca", overlay).value || "",
      descripcion,
      evidencia: imageDraft.evidencia || "",
    };
    const btn = $("#incidentSubmit", overlay);
    btn.disabled = true;
    const { data, error } = await apiFetch("conductor_incidencias/save.php", { method: "POST", body: payload });
    btn.disabled = false;
    if(error){ toast("No se pudo enviar el reporte"); return; }
    incidencias.unshift(data.row);
    overlay.remove();
    toast("Incidencia reportada");
    renderIncidentList();
  });
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
        <div class="field">
          <label>Obra *</label>
          <select id="fObra" required>
            <option value="">— Seleccionar —</option>
            ${obrasCat.map(o => `<option value="${esc(o)}" ${draft.obra===o?"selected":""}>${esc(o)}</option>`).join("")}
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
  const obra = $("#fObra", overlay).value;
  if(!placa || !fechaSalida || !obra){ toast("Falta completar Placa, Fecha salida u Obra"); return; }

  const payload = {
    nro: existing ? existing.nro : undefined,
    fechaSalida,
    fechaLlegada: $("#fFechaLlegada", overlay).value || null,
    placa,
    estado: $("#fEstado", overlay).value || "",
    // Al editar, se conserva el estado del servicio actual (los cambios de
    // estado se hacen con los botones de la tarjeta, no desde este formulario).
    // Al crear una ruta nueva, se omite y el servidor la deja en "Asignado".
    estadoServicio: existing ? existing.estadoServicio : undefined,
    conductor: nombreCompleto, // el servidor lo vuelve a completar solo de todos modos, con el nombre real de la cuenta
    obra,
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

  // api/conductor_rutas/save.php hace de una tanto la creación como la
  // edición (según venga o no "nro" en el payload), y siempre revisa que la
  // ruta editada sea realmente del conductor logueado antes de tocarla.
  const { data, error } = await apiFetch("conductor_rutas/save.php", { method: "POST", body: payload });
  btn.disabled = false;
  if(error){ console.error(error); toast(existing ? "No se pudo guardar la ruta" : "No se pudo crear la ruta"); return; }

  if(existing){
    const idx = rutas.findIndex(r => r.nro === existing.nro);
    if(idx !== -1) rutas[idx] = data.row;
    toast("Ruta actualizada");
  } else {
    rutas.unshift(data.row);
    toast("Ruta creada");
  }
  overlay.remove();
  renderRouteList();
}

/* ==========================================================================
   INIT
   ========================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  const { data, error } = await apiFetch("conductor_auth/me.php");
  if(error || !data || !data.logged_in){
    renderAuth("login");
    return;
  }
  profile = data.conductor;
  await loadProfileAndData();
});