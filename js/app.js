/* ==========================================================================
   CONTROL DE FLOTA VEHICULAR — lógica de la aplicación
   Persistencia en Supabase (PostgreSQL): una tabla real por módulo
   (flota, seguros, impuestos, conductores, talleres, rutas, multas,
   mantenimiento, fletes) + una tabla app_storage (JSONB) para catálogos,
   papelera e historial. Config de conexión en js/supabase-config.js
   ========================================================================== */

const LS_CAT   = "flota_catalogos_v1";
const LS_TRASH = "flota_trash_v1";
const LS_LOG   = "flota_log_v1";

/* ==========================================================================
   CLIENTE DE LA API PROPIA (PHP + MySQL) — reemplaza al cliente de Supabase.
   Todas las funciones de este bloque devuelven {data, error}, igual que
   hacía supabase-js, para no tener que reescribir el resto del archivo.
   ========================================================================== */
const API_BASE = "api"; // carpeta api/ dentro de public_html, junto a este index.html

async function apiFetch(path, opts = {}){
  let res;
  try{
    res = await fetch(`${API_BASE}/${path}`, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "include", // imprescindible: así viaja la cookie de sesión
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch(networkErr){
    return { data: null, error: "No se pudo conectar con el servidor" };
  }
  let json = null;
  try{ json = await res.json(); } catch(parseErr){ /* respuesta vacía o no-JSON */ }
  if(!res.ok){
    // Se conserva el JSON de error (no solo el mensaje) para casos como el
    // conflicto de disponibilidad de rutas, donde el backend manda además
    // el detalle de qué otro servicio choca en fechas.
    return { data: json, error: (json && json.error) || `Error ${res.status}` };
  }
  return { data: json, error: null };
}

let DB = null;
let CAT = null;
let TRASH = null;
let LOG = null;
let currentModule = "dashboard";
let editing = { module: null, nro: null };
let currentAdmin = null;     // {id,email,nombre,rol} — rol: "superadmin" | "admin" | "operador"
let notifState = { rows: [], noLeidas: 0 };
// "Full admin" = puede ver Usuarios y roles, catálogos sensibles, etc.
// Incluye tanto al Administrador como al Super Usuario.
const isFullAdmin = () => currentAdmin?.rol === "admin" || currentAdmin?.rol === "superadmin";
// El Super Usuario es el desarrollador/dueño del sistema: único rol que
// puede tocar cuentas admin/superadmin y ejecutar el borrado total.
const isSuperAdmin = () => currentAdmin?.rol === "superadmin";

/* ---------------------------------------------------------------- utils */
const $  = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];
const todayISO = () => new Date().toISOString().slice(0,10);
const fmtMoney = n => Math.round(Number(n)||0).toLocaleString("es-CL");
const fmtNum   = n => (Number(n)||0).toLocaleString("es-CL", {maximumFractionDigits:2});
const fmtDate  = iso => { if(!iso) return "—"; const d = new Date(iso+"T00:00:00"); return isNaN(d) ? iso : d.toLocaleDateString("es-CL", {day:"2-digit",month:"short",year:"numeric"}); };
const fmtDateTime = iso => { if(!iso) return "—"; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString("es-CL", {day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}); };
const fmtTime = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString("es-CL", {hour:"2-digit",minute:"2-digit",second:"2-digit"}); };
const daysBetween = (a,b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const uid = () => Math.random().toString(36).slice(2,9);

function toast(msg, opts={}){
  const t = $("#toast");
  clearTimeout(toast._t);
  t.innerHTML = `<span>${esc(msg)}</span>` + (opts.actionLabel ? `<button class="toast-action" id="toastAction">${esc(opts.actionLabel)}</button>` : "");
  t.classList.add("show");
  if(opts.actionLabel && opts.onAction){
    $("#toastAction").addEventListener("click", () => {
      opts.onAction();
      t.classList.remove("show");
      clearTimeout(toast._t);
    });
  }
  toast._t = setTimeout(()=> t.classList.remove("show"), opts.actionLabel ? 6500 : 2400);
}

function markSaved(){
  const el = $("#saveIndicator");
  if(!el) return;
  el.textContent = "✓ Guardado automáticamente · " + fmtTime(new Date().toISOString());
  el.classList.remove("pulse");
  void el.offsetWidth;
  el.classList.add("pulse");
}

/* ---------------------------------------------------------------- persistence */
function emptyTrash(){
  const t = {};
  MODULE_ORDER.forEach(k => t[k] = []);
  return t;
}
/* Convierte una fila en memoria a lo que se guarda en su tabla real de Postgres.
   Los campos "computed" nunca se guardan: se recalculan siempre con cfg.computeFn. */
function sanitizeRowForDb(moduleKey, row){
  const cfg = MODULES[moduleKey];
  const out = { nro: Number(row.nro) };
  if(moduleKey === "fletes"){
    // IMPORTANTE: esta clave debe estar SIEMPRE presente (con null si no
    // aplica), nunca omitida condicionalmente. Cuando se guardan varias
    // filas juntas en un mismo lote (import de Excel, guardado incremental,
    // etc.), PostgREST exige que TODOS los objetos del lote tengan
    // exactamente las mismas columnas — si a algunas filas les falta esta
    // clave (p. ej. fletes importados por Excel, que no vienen de una ruta)
    // y a otras no, Supabase rechaza el lote ENTERO con error 400 ("All
    // object keys must match"), y esas filas nunca llegan a guardarse.
    out.rutaNro = (row.rutaNro !== undefined && row.rutaNro !== null && row.rutaNro !== "")
      ? Number(row.rutaNro) : null;
  }
  // OJO: ya no se calcula acá el enlace con la cuenta del conductor (antes
  // "conductorAuthId"). El backend PHP (api/rutas/save.php) lo recalcula
  // siempre él mismo a partir del texto del campo "conductor", así que
  // cualquier valor que se mandara desde acá sería ignorado de todos modos.
  cfg.columns.forEach(c => {
    if(c.kind === "computed") return;
    const v = row[c.key];
    if(c.kind === "number"){
      out[c.key] = (v === "" || v === undefined || v === null) ? null : Number(v);
    } else if(c.kind === "date"){
      out[c.key] = (v === "" || v === undefined || v === null) ? null : v;
    } else {
      out[c.key] = (v === undefined || v === null) ? "" : String(v);
    }
  });
  return out;
}

/* api/{tabla}/list.php ya devuelve TODAS las filas en una sola respuesta
   (no hay límite de 1000 como en PostgREST), así que esto es ahora un
   simple llamado. Se mantiene el mismo nombre/forma de retorno para no
   tener que tocar el resto del archivo. */
async function fetchAllRows(table){
  const { data, error } = await apiFetch(`${table}/list.php`);
  if(error) return { data: null, error };
  return { data: data.rows || [], error: null };
}

/* api/{tabla}/save.php solo acepta UNA fila por llamado (a diferencia del
   upsert por lote de Supabase), así que acá se manda cada fila con un
   límite de peticiones en paralelo (concurrencia), en vez de una sola
   petición gigante. Igual de seguro, y evita mandar cientos de fetch()
   verdaderamente al mismo tiempo. */
async function upsertInChunks(table, rows, concurrency = 8){
  const endpoint = `${table}/save.php`;
  for(let i = 0; i < rows.length; i += concurrency){
    const batch = rows.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(row => apiFetch(endpoint, { method: "POST", body: row })));
    const failed = results.find(r => r.error);
    if(failed) return failed.error;
  }
  return null;
}
async function deleteNrosInChunks(table, nros, concurrency = 8){
  const endpoint = `${table}/delete.php`;
  for(let i = 0; i < nros.length; i += concurrency){
    const batch = nros.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(nro => apiFetch(endpoint, { method: "POST", body: { nro } })));
    const failed = results.find(r => r.error);
    if(failed) return failed.error;
  }
  return null;
}

/* ==========================================================================
   SINCRONIZACIÓN INCREMENTAL (reemplaza el viejo patrón "borrar todo +
   reinsertar todo").
   -----------------------------------------------------------------------
   ANTES: cada guardado borraba la tabla completa de un módulo y la volvía a
   insertar entera a partir de lo que esa pestaña tenía en memoria. Eso es
   catastrófico si la pestaña quedó con una copia vieja (por ejemplo, abierta
   desde antes de una importación grande, o simplemente abierta desde el día
   anterior): cualquier guardado posterior —incluso de una edición chica en
   otro módulo, o del espejo automático rutas→fletes que corre solo al
   recibir eventos en vivo— borraba y reescribía TODA la tabla con esa copia
   vieja, haciendo "desaparecer" todo lo agregado después (como un import de
   Excel) sin que nadie lo borrara a propósito.

   AHORA: cada módulo lleva un registro de qué filas (por "nro") cambiaron
   en ESTA pestaña desde el último guardado exitoso (_dirty). Al guardar,
   solo se hace upsert de esas filas puntuales y delete de los nro
   explícitamente eliminados — nunca un "delete de todo". Así, una pestaña
   con datos viejos de OTRAS filas jamás puede borrarlas: solo puede tocar
   las filas que ella misma modificó. */
function emptyDirty(){
  const d = {};
  MODULE_ORDER.forEach(k => { d[k] = { upserts: new Set(), deletes: new Set() }; });
  return d;
}
// OJO: no se puede llamar emptyDirty() acá todavía — usa MODULE_ORDER, que
// se declara más abajo en el archivo (con "const", en temporal dead zone).
// Llamarla en este punto rompía TODO el script al cargar la página (pantalla
// en blanco). _dirty se inicializa de verdad más abajo, justo después de
// declarar MODULE_ORDER.
let _dirty = {};

function markDirty(moduleKey, nro){
  if(moduleKey === "rutas") return; // rutas usa su propio upsert por fila (ver abajo)
  _dirty[moduleKey].deletes.delete(Number(nro));
  _dirty[moduleKey].upserts.add(Number(nro));
}
function markDeleted(moduleKey, nro){
  if(moduleKey === "rutas") return;
  _dirty[moduleKey].upserts.delete(Number(nro));
  _dirty[moduleKey].deletes.add(Number(nro));
}

/* Sincroniza SOLO las filas de un módulo marcadas como cambiadas. Si algo
   falla, las deja pendientes (no las borra de _dirty) para reintentar en el
   próximo guardado, en vez de darlas por perdidas. */
async function flushModule(moduleKey){
  const dirty = _dirty[moduleKey];
  if(!dirty) return;
  const upsertNros = [...dirty.upserts];
  const deleteNros = [...dirty.deletes];
  if(!upsertNros.length && !deleteNros.length) return;

  if(upsertNros.length){
    const rows = upsertNros
      .map(nro => (DB[moduleKey] || []).find(r => Number(r.nro) === nro))
      .filter(Boolean)
      .map(r => sanitizeRowForDb(moduleKey, r));
    if(rows.length){
      const err = await upsertInChunks(moduleKey, rows);
      if(err){ console.error("Supabase upsert error", moduleKey, err); toast("Error al guardar " + moduleKey); return; }
    }
    upsertNros.forEach(n => dirty.upserts.delete(n));
  }
  if(deleteNros.length){
    const err = await deleteNrosInChunks(moduleKey, deleteNros);
    if(err){ console.error("Supabase delete error", moduleKey, err); toast("Error al eliminar en " + moduleKey); return; }
    deleteNros.forEach(n => dirty.deletes.delete(n));
  }
}

/* Restaurar un respaldo completo (el JSON exportado con "Exportar todo") SÍ
   debe reemplazar el contenido entero de cada tabla — pero es una acción
   explícita y deliberada del usuario al elegir ese archivo, muy distinta a
   que un guardado cualquiera borre todo como efecto secundario. Aun así, en
   vez de un "delete de todo" ciego, se calcula qué filas del servidor no
   están en el respaldo (para borrarlas) y se hace upsert del resto, para
   minimizar la ventana en la que la tabla queda vacía. */
async function restoreFullBackup(payload){
  DB = payload.data;
  CAT = payload.catalogos;
  await Promise.all(MODULE_ORDER.map(async key => {
    const { data: existing, error } = await fetchAllRows(key);
    const existingNros = (!error && existing) ? existing.map(r => Number(r.nro)) : [];
    const newNros = new Set((DB[key] || []).map(r => Number(r.nro)));
    const toDelete = existingNros.filter(n => !newNros.has(n));
    _dirty[key] = { upserts: new Set(newNros), deletes: new Set(toDelete) };
  }));
  await persistDB(); // pasa por la cola _dbWriteChain, igual que cualquier otro guardado
  await persistCat();
}

/* "rutas" es la única tabla que también escriben los conductores desde su
   propia app (con su sesión, en paralelo al panel web). Por eso siempre
   usó upsert por fila (nunca el patrón "borrar todo"), igual que ahora
   hacen todos los demás módulos. El enlace con la cuenta del conductor
   (antes "conductorAuthId") ya no se calcula acá: lo hace siempre el
   backend (api/rutas/save.php) a partir del texto del campo "conductor". */
/**
 * Entregable #6 (disponibilidad): guarda una ruta pasando siempre por
 * rutas/save.php. Si el backend detecta que la placa o el conductor ya
 * tienen otro servicio activo con fechas cruzadas, devuelve 409 con el
 * detalle — acá se le muestra al admin y, si confirma, se reintenta una
 * sola vez con forzarConflicto:true para dejarlo guardar igual.
 */
async function guardarRutaEnServidor(payload){
  let { data, error } = await apiFetch("rutas/save.php", { method: "POST", body: payload });
  if(error === "conflicto_disponibilidad"){
    const detalle = (data.conflictos || []).map(c =>
      `• ${c.recurso === "placa" ? "Vehículo" : "Conductor"} "${c[c.recurso]}" ya está asignado a la ruta #${c.nro} (${c.fechaSalida || "—"} → ${c.fechaLlegada || "sin cierre"}, estado ${c.estadoServicio})`
    ).join("\n");
    const forzar = confirm(`Este vehículo o conductor ya tiene otro servicio activo en fechas que se cruzan:\n\n${detalle}\n\n¿Guardar de todas formas?`);
    if(!forzar) return { data: null, error: "cancelado" };
    ({ data, error } = await apiFetch("rutas/save.php", { method: "POST", body: { ...payload, forzarConflicto: true } }));
  }
  return { data, error };
}

async function upsertRutaRow(row){
  const payload = sanitizeRowForDb("rutas", row);
  const { error } = await guardarRutaEnServidor(payload);
  if(error && error !== "cancelado"){ console.error("Error al guardar ruta", error); toast("Error al guardar la ruta"); }
}
async function deleteRutaRow(nro){
  const { error } = await apiFetch("rutas/delete.php", { method: "POST", body: { nro: Number(nro) } });
  if(error){ console.error("Error al eliminar ruta", error); toast("Error al eliminar la ruta"); }
}

async function saveKey(key, value){
  const { error } = await apiFetch("storage/save.php", { method: "POST", body: { key, value } });
  if(error){ console.error("Error al guardar", key, error); toast("Error al guardar en la base de datos"); }
}

async function loadDB(){
  DB = {};
  await Promise.all(MODULE_ORDER.map(async key => {
    const { data, error } = await fetchAllRows(key);
    if(error){ console.error("Error al cargar", key, error); toast("Error al cargar " + key); DB[key] = []; }
    else { DB[key] = data || []; }
  }));

  const { data, error } = await apiFetch("storage/get_all.php");
  if(error){ console.error("Error al conectar con la base de datos", error); toast("Error al conectar con la base de datos"); }
  const map = data ? { [LS_CAT]: data.catalogos, [LS_TRASH]: data.trash, [LS_LOG]: data.log } : {};

  CAT = map[LS_CAT] || {};

  // Auto-reparación de catálogos: si a CAT le falta alguna clave que los
  // formularios necesitan (por ejemplo porque la instalación es antigua y
  // se agregó el catálogo después, o porque el registro guardado en el
  // servidor quedó incompleto), se rellena con un valor por defecto en vez
  // de dejar que los <select> revienten con "Cannot read properties of
  // undefined". Cualquier clave que ya tenga datos válidos se respeta tal
  // cual está.
  let catRepaired = false;
  const ensureCatList = (key, defaults) => {
    if(!Array.isArray(CAT[key]) || !CAT[key].length){
      CAT[key] = [...new Set(defaults)];
      catRepaired = true;
    }
  };
  ensureCatList("obras", OBRAS_POR_DEFECTO);
  ensureCatList("tiposVehiculo", ["Camión","Camioneta","Furgón","Automóvil","Otro"]);
  ensureCatList("estadosVehiculo", ["Disponible","En ruta","En taller","Fuera de servicio"]);
  ensureCatList("infracciones", ["Exceso de velocidad","Estacionamiento","Documentación","Otra"]);
  ensureCatList("tiposFlete", ["Nacional","Local","Interno"]);
  // Flujo de estados del servicio (rutas): distinto del estado del vehículo.
  ensureCatList("estadosServicio", ["Asignado","Aceptado","En ruta","En destino","Finalizado","Cancelado"]);
  ensureCatList("tiposIncidencia", ["Accidente de tránsito","Falla mecánica","Retraso de entrega","Daño de carga","Problema con cliente","Robo o pérdida","Conducta del conductor","Otro"]);
  ensureCatList("gravedadIncidencia", ["Baja","Media","Alta","Crítica"]);
  ensureCatList("estadosIncidencia", ["Abierta","En revisión","Resuelta","Cerrada"]);
  if(!Array.isArray(CAT.marcaModelo)){ CAT.marcaModelo = []; catRepaired = true; }
  if(!Array.isArray(CAT.tiposMantenimiento) || !CAT.tiposMantenimiento.length){
    CAT.tiposMantenimiento = ["Preventivo","Correctivo"];
    catRepaired = true;
  }
  if(!CAT.paquetesMantenimiento || typeof CAT.paquetesMantenimiento !== "object"){
    CAT.paquetesMantenimiento = {};
    catRepaired = true;
  }
  if(catRepaired) await persistCat();

  if(map[LS_TRASH]){ TRASH = map[LS_TRASH]; MODULE_ORDER.forEach(k => { if(!TRASH[k]) TRASH[k] = []; }); }
  else { TRASH = emptyTrash(); await persistTrash(); }

  if(map[LS_LOG]){ LOG = map[LS_LOG]; }
  else { LOG = []; await persistLog(); }
}
/* persistDB ahora solo sincroniza filas puntuales marcadas como cambiadas
   (ver flushModule más arriba) — ya no hay ningún "borrar todo" salvo la
   restauración explícita de un respaldo completo (ver restoreFullBackup).
   Se mantiene la cola _dbWriteChain para que los guardados se ejecuten uno
   por uno (evita condiciones de carrera al escribir), pero al ser
   incremental, aunque se solaparan no podrían borrar datos ajenos. */
let _dbWriteChain = Promise.resolve();
function persistDB(opts={}){
  _dbWriteChain = _dbWriteChain.then(() => reallyPersistDB(opts)).catch(err => {
    console.error("Supabase persist error", err);
    toast("Error al guardar los datos");
  });
  return _dbWriteChain;
}
async function reallyPersistDB(opts={}){
  const keys = opts.skipRutas ? MODULE_ORDER.filter(k => k !== "rutas") : MODULE_ORDER;
  await Promise.all(keys.map(flushModule));
  markSaved();
}
async function persistCat(){ await saveKey(LS_CAT, CAT); markSaved(); }
async function persistTrash(){ await saveKey(LS_TRASH, TRASH); markSaved(); }
async function persistLog(){ await saveKey(LS_LOG, LOG); markSaved(); }

function logActivity(moduleKey, action, nro, summary){
  const usuario = currentAdmin ? (currentAdmin.nombre || currentAdmin.email) : null;
  LOG.unshift({ id: uid(), ts: new Date().toISOString(), moduleKey, action, nro, summary, usuario });
  if(LOG.length > 3000) LOG.length = 3000;
  persistLog();
}

/* ANTES: nextNro() calculaba max(nro)+1 solo con la copia en memoria de
   ESTA pestaña. Si otra sesión había agregado registros que esta pestaña
   no tenía cargados (por ejemplo, un import grande hecho en otra pestaña),
   el próximo nro calculado acá podía coincidir con uno ya usado allá y, al
   guardar, pisar ese registro ajeno. Ahora se consulta primero el máximo
   real en la base de datos y se toma el mayor entre ese valor y el local. */
async function nextNroSafe(moduleKey){
  const { data, error } = await fetchAllRows(moduleKey);
  if(error) console.error("Error al calcular próximo nro", moduleKey, error);
  const serverRows = (!error && data) ? data : [];
  const serverMax = serverRows.length ? Math.max(...serverRows.map(r => Number(r.nro) || 0)) : 0;
  const rows = DB[moduleKey] || [];
  const localMax = rows.length ? Math.max(...rows.map(r => Number(r.nro) || 0)) : 0;
  return Math.max(serverMax, localMax) + 1;
}

/* ---------------------------------------------------------------- fórmulas (calculadas, igual que el Excel original) */
function computeFlota(r){
  return {};
}
function computeSeguro(r){
  if(!r.fechaVencimiento) return { estadoPoliza: "—" };
  const dias = daysBetween(todayISO(), r.fechaVencimiento);
  if(dias < 0) return { estadoPoliza: "Vencido" };
  if(dias <= 30) return { estadoPoliza: "Por vencer" };
  return { estadoPoliza: "Vigente" };
}
function computeRuta(r){
  const ingresoTotal = (Number(r.pesoCarga)||0) * (Number(r.costoPorKg)||0);
  // "Realizado" se determina por la existencia de la foto Report (fotoFin):
  // es la misma condición que ya usa el resto de la app (syncClosedRoutesToFletes)
  // para considerar una ruta cerrada.
  const estadoRuta = r.fotoFin ? "✔ Completado" : "Pendiente";
  return { ingresoTotal, estadoRuta };
}
function computeMulta(r){
  const debe = (Number(r.importeMulta)||0) - (Number(r.importePagado)||0);
  return { debe, estadoPago: debe <= 0 ? "Pagado" : "Debe" };
}
function computeMantenimiento(r){
  const dias = (r.fechaEntrada && r.fechaSalida) ? daysBetween(r.fechaEntrada, r.fechaSalida) : null;
  return { diasTaller: dias };
}
/* ---------------------------------------------------------------- vínculo rutas -> fletes
   Cada ruta de viaje tiene un flete "espejo" en DB.fletes, identificado por
   rutaNro (columna extra que no forma parte de MODULES.fletes.columns, por
   lo que no aparece en el formulario ni en la tabla de Fletes). */
function fleteDataFromRuta(ruta){
  const calc = computeRuta(ruta) || {};
  return {
    obra: ruta.obra || "",
    descripcion: ruta.observaciones || "",
    realizado: ruta.fechaLlegada || ruta.fechaSalida || "",
    lugar: ruta.destino || "",
    solicitadoPor: ruta.solicitadoPor || "",
    fotoInicio: ruta.fotoInicio || "",
    fotoFin: ruta.fotoFin || "",
    nroRepor: ruta.nroRepor || "",
    nroGuia: ruta.nroGuia || "",
    valorFlete: calc.ingresoTotal || 0,
    rutaNro: ruta.nro,
  };
}

async function syncFleteFromRuta(ruta){
  const idx = DB.fletes.findIndex(f => Number(f.rutaNro) === Number(ruta.nro));
  const data = fleteDataFromRuta(ruta);
  if(idx !== -1){
    // Se sincronizan siempre los campos que vienen de la ruta (obra,
    // descripción, fecha, lugar, solicitado por, fotos, n° repor, n° guía,
    // valor). Los campos netamente administrativos que se completan a mano
    // en Fletes y no existen en Rutas (tipo, n° factura) no se tocan aquí
    // para no perder lo que el usuario ya cargó.
    DB.fletes[idx] = { ...DB.fletes[idx], ...data };
    markDirty("fletes", DB.fletes[idx].nro);
  } else {
    data.nro = await nextNroSafe("fletes");
    data.tipoFlete = "";
    data.nroFactura = "";
    DB.fletes.push(data);
    markDirty("fletes", data.nro);
  }
}

function removeFleteForRuta(rutaNro){
  const idx = DB.fletes.findIndex(f => Number(f.rutaNro) === Number(rutaNro));
  if(idx !== -1){
    const [removed] = DB.fletes.splice(idx, 1);
    markDeleted("fletes", removed.nro);
  }
}

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
function computeFlete(r){
  let mes = "", anio = "";
  if(r.realizado){
    const d = new Date(r.realizado + "T00:00:00");
    if(!isNaN(d)){ mes = MESES[d.getMonth()]; anio = String(d.getFullYear()); }
  }
  return { mes, anio };
}

/* ---------------------------------------------------------------- helpers de catálogos dinámicos */
const marcasUnicas = () => [...new Set(CAT.marcaModelo.map(m=>m.marca))].sort();
const modelosDe = marca => CAT.marcaModelo.filter(m=>m.marca===marca).map(m=>m.modelo);
const placasFlota = () => DB.flota.map(v => ({ value:v.placa, label:`${v.placa} — ${v.marca} ${v.modelo}` }));
const nombresConductores = () => DB.conductores.map(c => {
  const full = `${c.nombres || ""} ${c.apellidos || ""}`.trim();
  const label = c.authUserId ? full : `${full} (sin cuenta en la app)`;
  return { value: full, label };
});
/* authIdDeConductor / fetchAuthIdDeConductor ya no existen: el enlace entre
   una ruta y la cuenta del conductor ahora lo calcula siempre el backend
   (api/rutas/save.php), a partir del texto del campo "conductor", tanto al
   crear como al editar. Así nunca puede quedar desactualizado ni depende
   de qué tenga cargado esta pestaña en memoria. */
const nombresTalleres = () => DB.talleres.map(t => ({ value:t.nombre, label:t.nombre }));

/* Obras por defecto: si el catálogo "obras" no existe todavía (o está
   vacío) se siembra con esta lista la primera vez que carga la app (ver
   loadDB). Cualquier obra nueva que se escriba en un formulario se agrega
   sola a este catálogo (ver submitForm), siempre en MAYÚSCULAS. */
const OBRAS_POR_DEFECTO = [
  "ALTO OHIGGINS","ILLAPEL","SAN BERNARDO","CE200","SAN PABLO","PITAGORA",
  "ENEX PUD","SITISEN","OVALLE","ISOMETRIKA","EASYSUPPLY","WINWOOD",
  "LOS VILOS","SOLIER","RONDIZZONI","LIBO","PAICAVI","CREATIVE",
  "NUEVO PARQUE","PARQUE LAS ALAMEDAS","CLINICA VETERINARIA","SOL DEL VALLE",
  "JARDINES DE SAN FRANCISCO",
];
const obrasCatalogo = () => (CAT.obras || []).slice().sort((a,b)=>a.localeCompare(b,"es"));

/* ==========================================================================
   CONFIGURACIÓN DE MÓDULOS
   ========================================================================== */
const MODULES = {

  flota: {
    label: "Flota de vehículos", icon:"🚚", group:"Operación",
    columns: [
      { key:"tipo", label:"Tipo", kind:"select", options:()=>CAT.tiposVehiculo, required:true },
      { key:"marca", label:"Marca", kind:"select", options:marcasUnicas, required:true, cascadeTarget:"modelo" },
      { key:"modelo", label:"Modelo", kind:"select", options:(draft)=>modelosDe(draft?.marca), required:true },
      { key:"placa", label:"Placa", kind:"text", required:true, plate:true },
      { key:"nroSerie", label:"Nro. serie", kind:"text" },
      { key:"color", label:"Color", kind:"text" },
      { key:"anio", label:"Año", kind:"number" },
      { key:"cargaMaxima", label:"Carga máx. (Kg)", kind:"number", numeric:true },
      { key:"estado", label:"Estado vehículo", kind:"select", options:()=>CAT.estadosVehiculo, badge:true },
    ],
    computeFn: computeFlota,
    summary: r => `${r.placa} · ${r.marca} ${r.modelo}`,
  },

  seguros: {
    label: "Seguros", icon:"🛡️", group:"Cumplimiento",
    columns: [
      { key:"placa", label:"Placa", kind:"select", options:placasFlota, required:true, plate:true },
      { key:"aseguradora", label:"Aseguradora", kind:"text", required:true },
      { key:"poliza", label:"Póliza", kind:"text" },
      { key:"fechaInicio", label:"Inicio", kind:"date" },
      { key:"fechaVencimiento", label:"Vencimiento", kind:"date", required:true },
      { key:"importePagado", label:"Importe pagado ($)", kind:"number", numeric:true, money:true },
      { key:"fechaPago", label:"Fecha de pago", kind:"date" },
      { key:"estadoPoliza", label:"Estado", kind:"computed", badge:true },
    ],
    computeFn: computeSeguro,
    summary: r => `${r.placa} · ${r.aseguradora}`,
  },

  impuestos: {
    label: "Impuestos", icon:"🧾", group:"Cumplimiento",
    columns: [
      { key:"placa", label:"Placa", kind:"select", options:placasFlota, required:true, plate:true },
      { key:"tipo", label:"Tipo impuesto", kind:"text", required:true },
      { key:"anio", label:"Año", kind:"number" },
      { key:"importe", label:"Importe ($)", kind:"number", numeric:true, money:true },
      { key:"fechaPago", label:"Fecha de pago", kind:"date" },
    ],
    summary: r => `${r.placa} · ${r.anio}`,
  },

  conductores: {
    label: "Conductores", icon:"🧑‍✈️", group:"Operación",
    columns: [
      { key:"clase", label:"Clase", kind:"select", options:()=>["A","B","C","D","F"], required:true },
      { key:"licencia", label:"N° Licencia", kind:"text", required:true },
      { key:"municipalidad", label:"Municipalidad", kind:"text", required:true },
      { key:"nombres", label:"Nombres", kind:"text", required:true },
      { key:"apellidos", label:"Apellidos", kind:"text", required:true },
      { key:"direccion", label:"Dirección", kind:"text" },
      { key:"fechaUltimoControl", label:"Fecha último control", kind:"date" },
      { key:"fechaControl", label:"Fecha de control", kind:"date" },
      { key:"docIdentidad", label:"Doc. identidad", kind:"text" },
      { key:"telefono", label:"Teléfono", kind:"text" },
      { key:"calificacion", label:"Calificación", kind:"select", options:()=>[1,2,3,4,5], stars:true },
      { key:"licenciaPdf", label:"Licencia de conducir (PDF)", kind:"file", accept:"application/pdf", wide:true },
    ],
    summary: r => `${r.nombres || ""} ${r.apellidos || ""}`.trim(),
  },

  talleres: {
    label: "Talleres", icon:"🔧", group:"Operación",
    columns: [
      { key:"nombre", label:"Taller", kind:"text", required:true },
      { key:"direccion", label:"Dirección", kind:"text" },
      { key:"telefono", label:"Teléfono", kind:"text" },
      { key:"correo", label:"Correo", kind:"text" },
      { key:"contacto", label:"Contacto principal", kind:"text" },
    ],
    summary: r => r.nombre,
  },

  rutas: {
    label: "Rutas de viaje", icon:"🗺️", group:"Operación",
    columns: [
      { key:"fechaSalida", label:"Fecha salida", kind:"date", required:true },
      { key:"fechaLlegada", label:"Fecha llegada", kind:"date" },
      { key:"placa", label:"Placa", kind:"select", options:placasFlota, required:true, plate:true },
      { key:"estado", label:"Estado vehículo", kind:"select", options:()=>CAT.estadosVehiculo, badge:true },
      { key:"estadoServicio", label:"Estado del servicio", kind:"select", options:()=>CAT.estadosServicio, required:true, badge:true },
      { key:"conductor", label:"Conductor", kind:"select", options:nombresConductores, required:true },
      { key:"obra", label:"Obra", kind:"combo", options:obrasCatalogo, catalogKey:"obras", uppercase:true, required:true },
      { key:"solicitadoPor", label:"Solicitado por", kind:"text" },
      { key:"origen", label:"Origen", kind:"text" },
      { key:"destino", label:"Destino", kind:"text" },
      { key:"fotoInicio", label:"Foto de inicio de ruta", kind:"image", wide:true },
      { key:"fotoFin", label:"Report", kind:"image", wide:true },
      { key:"nroRepor", label:"N° Report", kind:"text" },
      { key:"nroGuia", label:"N° GUIA", kind:"text" },
      { key:"pesoCarga", label:"Peso carga (Kg)", kind:"number", numeric:true },
      { key:"costoPorKg", label:"Costo x Kg ($)", kind:"number", numeric:true, money:true },
      { key:"ingresoTotal", label:"Ingreso total ($)", kind:"computed", numeric:true, money:true },
      { key:"estadoRuta", label:"Estado", kind:"computed", badge:true },
      { key:"observaciones", label:"Observaciones", kind:"textarea", wide:true },
    ],
    computeFn: computeRuta,
    summary: r => `${r.origen} → ${r.destino}`,
    // Antes, una ruta con foto Report quedaba bloqueada para editar/eliminar
    // desde el panel. Ahora el admin (o superadmin) siempre puede corregir o
    // borrar una ruta, sea cual sea su estado — el bloqueo que sí sigue
    // existiendo es del lado de la app del conductor (api/conductor_rutas),
    // que nunca puede tocar estos campos.
  },

  multas: {
    label: "Multas", icon:"🚨", group:"Cumplimiento",
    columns: [
      { key:"fecha", label:"Fecha", kind:"date", required:true },
      { key:"nroViaje", label:"Nro. viaje", kind:"number" },
      { key:"placa", label:"Placa", kind:"select", options:placasFlota, required:true, plate:true },
      { key:"conductor", label:"Conductor", kind:"select", options:nombresConductores, required:true },
      { key:"infraccion", label:"Infracción", kind:"select", options:()=>CAT.infracciones },
      { key:"importeMulta", label:"Importe multa ($)", kind:"number", numeric:true, money:true },
      { key:"importePagado", label:"Importe pagado ($)", kind:"number", numeric:true, money:true },
      { key:"debe", label:"Debe ($)", kind:"computed", numeric:true, money:true },
      { key:"estadoPago", label:"Estado pago", kind:"computed", badge:true },
      { key:"observaciones", label:"Observaciones", kind:"textarea", wide:true },
    ],
    computeFn: computeMulta,
    summary: r => `${r.placa} · ${r.infraccion}`,
  },

  mantenimiento: {
    label: "Mantenimiento", icon:"🛠️", group:"Operación",
    columns: [
      { key:"placa", label:"Placa", kind:"select", options:placasFlota, required:true, plate:true },
      { key:"taller", label:"Taller", kind:"select", options:nombresTalleres, required:true },
      { key:"fechaEntrada", label:"Fecha entrada", kind:"date", required:true },
      { key:"fechaSalida", label:"Fecha salida", kind:"date" },
      { key:"tipo", label:"Tipo", kind:"select", options:()=>CAT.tiposMantenimiento, required:true, cascadeTarget:"paquete", badge:true },
      { key:"kilometraje", label:"Kilometraje", kind:"number", numeric:true },
      { key:"paquete", label:"Paquete mnnto.", kind:"select", options:(draft)=>CAT.paquetesMantenimiento[draft?.tipo] || [] },
      { key:"causas", label:"Causas mnnto.", kind:"textarea", wide:true },
      { key:"costoTotal", label:"Costo total ($)", kind:"number", numeric:true, money:true },
      { key:"diasTaller", label:"Días en taller", kind:"computed", numeric:true },
      { key:"fechaPago", label:"Fecha de pago", kind:"date" },
      { key:"observaciones", label:"Observaciones", kind:"textarea", wide:true },
    ],
    computeFn: computeMantenimiento,
    summary: r => `${r.placa} · ${r.tipo}`,
  },

  fletes: {
    label: "Fletes", icon:"📦", group:"Operación",
    // Al importar un Excel con varias hojas, cada hoja se trata como una OBRA distinta.
    sheetAsField: "obra",
    columns: [
      { key:"obra", label:"Obra", kind:"combo", options:obrasCatalogo, catalogKey:"obras", uppercase:true, required:true, aliases:["Obra","OBRA"] },
      { key:"descripcion", label:"Descripción Flete", kind:"text", required:true, aliases:["Descripcion Flete","Descripción Flete"] },
      { key:"realizado", label:"Realizado", kind:"date", required:true, aliases:["Realizado","Fecha"] },
      { key:"lugar", label:"Lugar", kind:"text", aliases:["Lugar"] },
      { key:"tipoFlete", label:"Tipo Flete", kind:"select", options:()=>CAT.tiposFlete, aliases:["Tipo Flete"] },
      { key:"solicitadoPor", label:"Solicitado por", kind:"text", aliases:["Solicitado por","Solicitado por:"] },
      { key:"fotoInicio", label:"Foto de inicio de ruta", kind:"image", wide:true },
      { key:"fotoFin", label:"Report", kind:"image", wide:true },
      { key:"nroRepor", label:"N° Report", kind:"text", aliases:["N° Repor","N Repor","Nro Repor","No Repor","Numero Repor","N° Report","Numero Report"] },
      { key:"nroGuia", label:"N° GUIA", kind:"text", aliases:["N° GUIA","N GUIA","Nro Guia","Numero Guia","Guia"] },
      { key:"valorFlete", label:"Valor Flete ($)", kind:"number", numeric:true, money:true, aliases:["Valor Flete"] },
      { key:"nroFactura", label:"N° Factura", kind:"text", aliases:["N° Factura","Nro Factura","Numero Factura"] },
      { key:"mes", label:"Mes", kind:"computed" },
      { key:"anio", label:"Año", kind:"computed" },
    ],
    computeFn: computeFlete,
    summary: r => `${r.obra} · ${r.descripcion}`,
    filters: [
      { key:"obra", label:"Obra" },
      { key:"mes", label:"Mes" },
      { key:"anio", label:"Año" },
      { key:"solicitadoPor", label:"Solicitado por" },
    ],
    // Campos que definen si dos fletes son "el mismo" al importar. Si un
    // registro nuevo coincide en todos estos campos con uno que ya existe
    // (o con otro dentro del mismo archivo), se omite en vez de duplicarlo.
    dedupeFields: ["obra","descripcion","realizado","lugar","nroRepor","nroGuia","valorFlete"],
  },

  incidencias: {
    label: "Incidencias", icon:"⚠️", group:"Operación",
    columns: [
      { key:"fecha", label:"Fecha", kind:"date", required:true },
      { key:"rutaNro", label:"N° de ruta asociada", kind:"number", numeric:true },
      { key:"placa", label:"Placa", kind:"select", options:placasFlota, plate:true },
      { key:"conductor", label:"Conductor", kind:"select", options:nombresConductores, required:true },
      { key:"tipo", label:"Tipo de incidencia", kind:"select", options:()=>CAT.tiposIncidencia, required:true, badge:true },
      { key:"gravedad", label:"Gravedad", kind:"select", options:()=>CAT.gravedadIncidencia, required:true, badge:true },
      { key:"descripcion", label:"Descripción", kind:"textarea", wide:true, required:true },
      { key:"evidencia", label:"Evidencia (foto)", kind:"image", wide:true },
      { key:"estado", label:"Estado", kind:"select", options:()=>CAT.estadosIncidencia, required:true, badge:true },
      { key:"fechaResolucion", label:"Fecha de resolución", kind:"date" },
      { key:"solucion", label:"Solución aplicada", kind:"textarea", wide:true },
      { key:"reportadoPor", label:"Reportado por", kind:"text" },
      { key:"observaciones", label:"Observaciones", kind:"textarea", wide:true },
    ],
    summary: r => `${r.tipo || "Incidencia"} · ${r.placa || r.conductor || ""}`,
  },
};

const MODULE_ORDER = ["flota","rutas","fletes","mantenimiento","seguros","impuestos","multas","incidencias","conductores","talleres"];
_dirty = emptyDirty(); // recién acá MODULE_ORDER ya existe

/* ==========================================================================
   RENDER: SIDEBAR
   ========================================================================== */
function renderSidebar(){
  const groups = {};
  MODULE_ORDER.forEach(key=>{
    const m = MODULES[key];
    groups[m.group] = groups[m.group] || [];
    groups[m.group].push(key);
  });

  let html = `<button class="nav-item ${currentModule==='dashboard'?'active':''}" data-nav="dashboard">
      <span class="ico">📊</span><span>Panel general</span></button>`;

  Object.entries(groups).forEach(([group, keys])=>{
    html += `<div class="nav-group-label">${esc(group)}</div>`;
    keys.forEach(key=>{
      const m = MODULES[key];
      html += `<button class="nav-item ${currentModule===key?'active':''}" data-nav="${key}">
        <span class="ico">${m.icon}</span><span>${esc(m.label)}</span>
        <span class="count">${DB[key].length}</span></button>`;
    });
    if(group === "Operación"){
      html += `<button class="nav-item ${currentModule==='facturas'?'active':''}" data-nav="facturas">
        <span class="ico">🧾</span><span>Facturas</span>
        <span class="count">${DB.fletes.length}</span></button>`;
    }
  });

  html += `<div class="nav-group-label">Seguimiento</div>
    <button class="nav-item ${currentModule==='mapa'?'active':''}" data-nav="mapa">
      <span class="ico">📍</span><span>Mapa operacional</span>
      <span class="count">${rutasActivasConUbicacion().length}</span></button>
    <button class="nav-item ${currentModule==='historialOps'?'active':''}" data-nav="historialOps">
      <span class="ico">🕓</span><span>Historial de operaciones</span></button>`;

  html += `<div class="nav-group-label">Configuración</div>
    <button class="nav-item ${currentModule==='catalogos'?'active':''}" data-nav="catalogos">
      <span class="ico">📋</span><span>Catálogos</span></button>`;
  if(isFullAdmin()){
    html += `<button class="nav-item ${currentModule==='usuarios'?'active':''}" data-nav="usuarios">
      <span class="ico">👤</span><span>Usuarios</span></button>`;
  }

  html += `<div class="nav-group-label">Historial</div>
    <button class="nav-item ${currentModule==='bitacora'?'active':''}" data-nav="bitacora">
      <span class="ico">📜</span><span>Registro de actividad</span></button>
    <button class="nav-item ${currentModule==='auditoria'?'active':''}" data-nav="auditoria">
      <span class="ico">🔒</span><span>Auditoría</span></button>
    <button class="nav-item ${currentModule==='papelera'?'active':''}" data-nav="papelera">
      <span class="ico">🗑️</span><span>Papelera</span><span class="count">${trashCount()}</span></button>`;

  $("#nav").innerHTML = html;
  $$('#nav [data-nav]').forEach(b => b.addEventListener('click', ()=> { goTo(b.dataset.nav); closeMobileSidebar(); }));
}

function goTo(key){
  currentModule = key;
  // El buscador y los filtros solo se reinician al navegar de verdad a un
  // módulo (clic en el menú) — no en cada repintado por sondeo, ver
  // refreshModuleData() más abajo.
  searchTerm = "";
  activeFilters = {};
  renderSidebar();
  renderMain();
}

/* Usada por el sondeo periódico (watchRutasRealtime) para refrescar los
   datos en pantalla SIN reconstruir el buscador ni los <select> de
   filtro — evita que el buscador/filtros del usuario se "reinicien solos"
   cada 30s mientras el módulo sigue abierto. Si el módulo activo no
   soporta repintado parcial (por ejemplo, todavía no se abrió ninguno vía
   renderModule), cae a un render completo como respaldo. */
function refreshModuleData(){
  if(currentModule === "dashboard") return renderDashboard();
  if(moduleRepaint && moduleRepaint.key === currentModule) return moduleRepaint.paint();
  return renderMain();
}

/* ==========================================================================
   NAVEGACIÓN MÓVIL — barra superior con botón hamburguesa y sidebar
   deslizable a modo cajón (off-canvas), para que el panel no se rompa en
   pantallas de teléfono. Se inyecta una sola vez por sesión.
   ========================================================================== */
function ensureMobileTopbar(){
  if($("#mobileTopbar")) return;

  const topbar = document.createElement("div");
  topbar.id = "mobileTopbar";
  topbar.className = "mobile-topbar";
  topbar.innerHTML = `
    <button class="mobile-menu-btn" id="mobileMenuBtn" aria-label="Abrir menú">☰</button>
    <div class="mobile-topbar-brand">
      <div class="brand-mark"><span>OGV</span></div>
      <b>Control Flota</b>
    </div>`;

  const backdrop = document.createElement("div");
  backdrop.id = "sidebarBackdrop";
  backdrop.className = "sidebar-backdrop";

  const appRoot = $("#appRoot");
  appRoot.prepend(topbar);
  appRoot.appendChild(backdrop);

  $("#mobileMenuBtn").addEventListener("click", () => toggleMobileSidebar());
  backdrop.addEventListener("click", closeMobileSidebar);
}

function toggleMobileSidebar(){
  $(".sidebar")?.classList.toggle("open");
  $("#sidebarBackdrop")?.classList.toggle("show");
}
function closeMobileSidebar(){
  $(".sidebar")?.classList.remove("open");
  $("#sidebarBackdrop")?.classList.remove("show");
}

/* ==========================================================================
   RENDER: MAIN AREA ROUTER
   ========================================================================== */
function renderMain(){
  if(currentModule === "dashboard") return renderDashboard();
  if(currentModule === "catalogos") return renderCatalogos();
  if(currentModule === "usuarios") return renderUsuarios();
  if(currentModule === "bitacora") return renderBitacora();
  if(currentModule === "auditoria") return renderAuditoria();
  if(currentModule === "papelera") return renderPapelera();
  if(currentModule === "facturas") return renderFacturas();
  if(currentModule === "mapa") return renderMapa();
  if(currentModule === "historialOps") return renderHistorialOperaciones();
  return renderModule(currentModule);
}

/* ---------------------------------------------------------------- DASHBOARD */
function ultimosNMeses(n){
  const out = [];
  const now = new Date();
  for(let i=n-1;i>=0;i--){
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    out.push({ key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`, label:MESES[d.getMonth()].slice(0,3) });
  }
  return out;
}

function barChartHTML(data, opts={}){
  const max = Math.max(1, ...data.map(d=>d.value));
  const fmt = opts.money ? (v)=>"$ "+fmtMoney(v) : (v)=>fmtNum(v);
  return `<div class="bar-chart">
    ${data.map(d=>`
      <div class="bar-chart-col">
        <span class="bar-chart-value">${d.value ? fmt(d.value) : ""}</span>
        <div class="bar-chart-track"><div class="bar-chart-bar" style="height:${d.value ? Math.max(4,Math.round((d.value/max)*100)) : 0}%" title="${esc(d.label)}: ${fmt(d.value)}"></div></div>
        <span class="bar-chart-label">${esc(d.label)}</span>
      </div>`).join("")}
  </div>`;
}

function hbarListHTML(rows, opts={}){
  const max = Math.max(1, ...rows.map(r=>r.value));
  if(!rows.length) return `<div class="empty-note">${esc(opts.emptyLabel || "Sin datos todavía.")}</div>`;
  return rows.map(r => `
    <div class="hbar-row">
      <span class="hbar-label" title="${esc(r.label)}">${esc(r.label)}</span>
      <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(4,Math.round((r.value/max)*100))}%; --c:${r.color || 'var(--accent)'}"></div></div>
      <b class="hbar-value">${r.value}</b>
    </div>`).join("");
}

function renderDashboard(){
  const totalVehiculos = DB.flota.length;
  const disponibles = DB.flota.filter(r=>r.estado==="Disponible").length;

  const segCalc = DB.seguros.map(r=>({...r, ...computeSeguro(r)}));
  const porVencer = segCalc.filter(r=>r.estadoPoliza==="Por vencer" || r.estadoPoliza==="Vencido");

  const multasCalc = DB.multas.map(r=>({...r, ...computeMulta(r)}));
  const multasPendientes = multasCalc.filter(r=>r.estadoPago==="Debe");
  const totalDeuda = multasPendientes.reduce((a,r)=>a+r.debe,0);

  const rutasCalc = DB.rutas.map(r=>({...r, ...computeRuta(r)}));
  const ingresoTotal = rutasCalc.reduce((a,r)=>a+r.ingresoTotal,0);

  const mantenimientosEnCurso = DB.mantenimiento.filter(m => m.fechaEntrada && !m.fechaSalida).length;

  const incidenciasAbiertas = DB.incidencias.filter(i => i.estado === "Abierta" || i.estado === "En revisión");
  const incidenciasCriticas = incidenciasAbiertas.filter(i => i.gravedad === "Alta" || i.gravedad === "Crítica");

  // ---- servicios activos por estado (flujo asignado -> ... -> finalizado) ----
  const servicioColors = { "Asignado":"var(--route)", "Aceptado":"var(--accent)", "En ruta":"var(--warning)", "En destino":"var(--success)" };
  const serviciosActivos = DB.rutas.filter(r => !["Finalizado","Cancelado"].includes(r.estadoServicio || "Asignado"));
  const servicioCounts = {};
  serviciosActivos.forEach(r => { const e = r.estadoServicio || "Asignado"; servicioCounts[e] = (servicioCounts[e]||0) + 1; });
  const servicioRows = Object.entries(servicioCounts)
    .map(([label,value])=>({ label, value, color: servicioColors[label] || "var(--route)" }));

  // ---- ingresos por mes (últimos 6 meses, según rutas) ----
  const meses6 = ultimosNMeses(6);
  const ingresosPorMesMap = {};
  rutasCalc.forEach(r=>{
    const fecha = r.fechaLlegada || r.fechaSalida;
    if(!fecha) return;
    const key = fecha.slice(0,7);
    ingresosPorMesMap[key] = (ingresosPorMesMap[key]||0) + (r.ingresoTotal||0);
  });
  const ingresosChart = meses6.map(m => ({ label:m.label, value: Math.round(ingresosPorMesMap[m.key]||0) }));

  // ---- estado de la flota ----
  const estadoColors = { "Disponible":"var(--success)", "En ruta":"var(--accent)", "En taller":"var(--warning)", "Fuera de servicio":"var(--danger)" };
  const estadoCounts = {};
  DB.flota.forEach(v=>{ const e = v.estado || "Sin estado"; estadoCounts[e] = (estadoCounts[e]||0) + 1; });
  const estadoRows = Object.entries(estadoCounts)
    .sort((a,b)=>b[1]-a[1])
    .map(([label,value])=>({ label, value, color: estadoColors[label] || "var(--route)" }));

  // ---- top obras (por cantidad de fletes) ----
  const obraCounts = {};
  DB.fletes.forEach(f=>{ const o = (f.obra||"").trim(); if(!o) return; obraCounts[o] = (obraCounts[o]||0) + 1; });
  const topObras = Object.entries(obraCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([label,value])=>({label, value}));

  // ---- actividad reciente ----
  const actividadReciente = LOG.slice(0,6);

  $("#main").innerHTML = `
    <div class="topbar">
      <div><span class="eyebrow">Hoy · ${fmtDate(todayISO())}</span><h1>Panel general de flota</h1></div>
      <div class="topbar-actions">
        <button class="btn" id="btnExport">⭳ Exportar</button>
        <button class="btn" id="btnImport">⭱ Importar</button>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="kpi" style="--kpi-color:var(--accent)"><div class="label">Vehículos en flota</div><div class="value">${String(totalVehiculos).padStart(2,"0")}</div><div class="sub">${disponibles} disponibles</div></div>
      <div class="kpi ${porVencer.length?'warn':''}" style="--kpi-color:${porVencer.length?'var(--warning)':'var(--success)'}"><div class="label">Seguros por vencer/vencidos</div><div class="value">${String(porVencer.length).padStart(2,"0")}</div><div class="sub">próx. 30 días o vencidos</div></div>
      <div class="kpi ${multasPendientes.length?'danger':''}" style="--kpi-color:${multasPendientes.length?'var(--danger)':'var(--success)'}"><div class="label">Multas por pagar</div><div class="value">$ ${fmtMoney(totalDeuda)}</div><div class="sub">${multasPendientes.length} pendiente(s)</div></div>
      <div class="kpi" style="--kpi-color:var(--route)"><div class="label">Fletes registrados</div><div class="value">${String(DB.fletes.length).padStart(2,"0")}</div><div class="sub">${DB.rutas.length} rutas de viaje</div></div>
      <div class="kpi ${mantenimientosEnCurso?'warn':''}" style="--kpi-color:${mantenimientosEnCurso?'var(--warning)':'var(--success)'}"><div class="label">Mantenimientos en curso</div><div class="value">${String(mantenimientosEnCurso).padStart(2,"0")}</div><div class="sub">vehículos en taller</div></div>
      <div class="kpi ${incidenciasAbiertas.length?'danger':''}" style="--kpi-color:${incidenciasAbiertas.length?'var(--danger)':'var(--success)'}"><div class="label">Incidencias abiertas</div><div class="value">${String(incidenciasAbiertas.length).padStart(2,"0")}</div><div class="sub">${incidenciasCriticas.length} de gravedad alta/crítica</div></div>
    </div>

    <div class="dash-grid dash-grid-3">
      <div class="panel">
        <h3><span class="ico">📈</span> Ingresos por mes (rutas)</h3>
        ${barChartHTML(ingresosChart, { money:true })}
      </div>

      <div class="panel">
        <h3><span class="ico">🚚</span> Estado de la flota</h3>
        <div class="hbar-list">${hbarListHTML(estadoRows, { emptyLabel:"Sin vehículos registrados." })}</div>
      </div>

      <div class="panel">
        <h3><span class="ico">🧭</span> Servicios activos por estado</h3>
        <div class="hbar-list">${hbarListHTML(servicioRows, { emptyLabel:"Sin servicios en curso." })}</div>
      </div>
    </div>

    <div class="dash-grid dash-grid-3">
      <div class="panel">
        <h3><span class="ico">🔔</span> Atención requerida</h3>
        ${porVencer.map(r=>`
          <div class="mini-row"><span>${plateChip(r.placa)} póliza ${esc(r.aseguradora)}</span><span class="tag ${r.estadoPoliza==='Vencido'?'tag-danger':'tag-warn'}">${r.estadoPoliza}</span></div>`).join("") }
        ${multasPendientes.map(r=>`
          <div class="mini-row"><span>${plateChip(r.placa)} multa ${esc(r.infraccion)}</span><span class="tag tag-danger">Debe $ ${fmtMoney(r.debe)}</span></div>`).join("") }
        ${(!porVencer.length && !multasPendientes.length) ? `<div class="empty-note">Todo en orden. Sin pendientes por ahora.</div>` : ""}
      </div>

      <div class="panel">
        <h3><span class="ico">⚠️</span> Incidencias abiertas</h3>
        ${incidenciasAbiertas.slice(0,6).map(r=>`
          <div class="mini-row"><span>${plateChip(r.placa || "—")} ${esc(r.tipo||"")}</span><span class="tag ${(r.gravedad==='Alta'||r.gravedad==='Crítica')?'tag-danger':'tag-warn'}">${esc(r.gravedad||r.estado)}</span></div>`).join("") }
        ${!incidenciasAbiertas.length ? `<div class="empty-note">Sin incidencias abiertas.</div>` : ""}
      </div>
    </div>

    <div class="dash-grid">
      <div class="panel">
        <h3><span class="ico">🏗️</span> Top obras (por fletes)</h3>
        <div class="hbar-list">${hbarListHTML(topObras, { emptyLabel:"Sin fletes registrados todavía." })}</div>
      </div>

      <div class="panel">
        <h3><span class="ico">🕘</span> Actividad reciente</h3>
        ${actividadReciente.length ? actividadReciente.map(e => `
          <div class="mini-row">
            <span>${esc(MODULES[e.moduleKey] ? MODULES[e.moduleKey].label : e.moduleKey)} — ${esc(e.summary || "#"+e.nro)}</span>
            <span class="tag ${e.action==='delete'?'tag-danger':e.action==='create'?'tag-ok':'tag-warn'}">${esc(ACTION_LABELS[e.action] || e.action)}</span>
          </div>`).join("") : `<div class="empty-note">Sin actividad registrada todavía.</div>`}
      </div>
    </div>
  `;
  $("#btnExport").addEventListener("click", ()=> openExportModal(null));
  $("#btnImport").addEventListener("click", ()=> openImportModal(null));
}

function plateChip(placa){
  return `<span class="plate">${esc(placa||"—")}</span>`;
}

function openImageLightbox(src){
  $("#modalRoot").innerHTML = `
    <div class="overlay lightbox-overlay" id="overlay">
      <button class="modal-close lightbox-close" id="modalClose">✕</button>
      <img src="${src}" class="lightbox-img">
    </div>`;
  $("#modalClose").addEventListener("click", closeModal);
  $("#overlay").addEventListener("click", e => { if(e.target.id === "overlay") closeModal(); });
}

/* Convierte un data URL (base64) en un Blob, para poder mostrarlo en un
   <iframe> con una URL liviana (URL.createObjectURL) en vez de inyectar
   el base64 completo en el atributo src, que en PDFs grandes puede pesar
   varios MB y hacer que el navegador vaya lento. */
function dataURLToBlob(dataUrl){
  const [meta, base64] = dataUrl.split(",");
  const mimeMatch = /data:(.*?);base64/.exec(meta);
  const mime = mimeMatch ? mimeMatch[1] : "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* Visor de PDF: abre el contenido (licencia de conducir, etc.) en un
   modal a pantalla casi completa, igual que el lightbox de fotos. */
function openPdfViewer(dataUrl){
  if(!dataUrl) return;
  const blobUrl = URL.createObjectURL(dataURLToBlob(dataUrl));
  $("#modalRoot").innerHTML = `
    <div class="overlay lightbox-overlay" id="overlay">
      <button class="modal-close lightbox-close" id="modalClose">✕</button>
      <iframe src="${blobUrl}" class="pdf-viewer-frame"></iframe>
    </div>`;
  const cleanup = () => { URL.revokeObjectURL(blobUrl); closeModal(); };
  $("#modalClose").addEventListener("click", cleanup);
  $("#overlay").addEventListener("click", e => { if(e.target.id === "overlay") cleanup(); });
}

/* ---------------------------------------------------------------- FACTURAS (Operación) */
/* Vista de solo lectura sobre los registros de Fletes, pensada para revisar
   las facturas emitidas. Reutiliza los datos de DB.fletes (computeFlete da
   Mes/Año) y agrega filtros por Obra, Mes y Año. No es un módulo CRUD: la
   edición de estos datos se sigue haciendo desde Fletes. */
let facturaFilters = {};

/* El "shell" (topbar + barra de filtros) se pinta una sola vez, al entrar
   al módulo. Antes, cada cambio de filtro reconstruía TODO #main —incluida
   la barra de filtros— lo que se sentía como si la app se "recargara"
   (parpadeo, se perdía el scroll, los <select> se recreaban). Ahora un
   cambio de filtro solo repinta el total y la tabla, vía paintFacturas(). */
function renderFacturas(){
  facturaFilters = {};

  const filterDefs = [
    { key:"obra", label:"Obra" },
    { key:"mes", label:"Mes" },
    { key:"anio", label:"Año" },
  ];
  const allRows = DB.fletes.map(r => ({...r, ...computeFlete(r)}));

  const filterBarHtml = filterDefs.map(f => {
    const values = sortFilterValues(f.key, uniqueFilterValues(allRows, f.key));
    return `<select class="filter-select" data-ffilter="${f.key}">
      <option value="">${esc(f.label)}: Todas</option>
      ${values.map(v=>`<option value="${esc(v.value)}">${esc(v.label)}</option>`).join("")}
    </select>`;
  }).join("");

  $("#main").innerHTML = `
    <div class="topbar">
      <div><span class="eyebrow">Operación</span><h1>🧾 Facturas</h1></div>
    </div>
    <div class="toolbar">
      ${filterBarHtml}
      <span class="spacer"></span>
      <span class="count-pill" id="facturasCount"></span>
    </div>
    <div class="panel facturas-total-panel" id="facturasTotalPanel"></div>
    <div class="table-wrap" id="facturasTableWrap"></div>
  `;

  $$('.filter-select[data-ffilter]').forEach(sel => sel.addEventListener("change", e => {
    facturaFilters[sel.dataset.ffilter] = sel.value;
    paintFacturas(allRows);
  }));

  paintFacturas(allRows);
}

/* Repinta solo el total y la tabla de Facturas, según los filtros activos.
   No toca la barra de filtros ni el topbar (evita el parpadeo/"recarga"). */
function paintFacturas(allRows){
  let rows = allRows;
  Object.keys(facturaFilters).forEach(key => {
    const val = facturaFilters[key];
    if(val) rows = rows.filter(r => String(r[key] ?? "").trim().toLowerCase() === val);
  });

  const total = rows.reduce((a,r)=> a + (Number(r.valorFlete)||0), 0);

  $("#facturasCount").textContent = `${rows.length} de ${allRows.length} facturas`;

  $("#facturasTotalPanel").innerHTML = `
    <div class="mini-row">
      <span>Suma de Valor Flete — ${rows.length} factura${rows.length===1?"":"s"} filtrada${rows.length===1?"":"s"}</span>
      <b style="color:var(--success); font-size:18px">$ ${fmtMoney(total)}</b>
    </div>
    <button class="btn" id="btnExportFacturas" ${rows.length ? "" : "disabled"}>⭳ Exportar resultado (${rows.length})</button>
  `;
  const btnExportFacturas = $("#btnExportFacturas");
  if(btnExportFacturas) btnExportFacturas.addEventListener("click", ()=> openExportFacturasModal(rows, total));

  $("#facturasTableWrap").innerHTML = rows.length
    ? renderFacturasTable(rows)
    : `<div class="empty-state"><div class="big">🧾</div>Sin facturas para este filtro.</div>`;
}

function renderFacturasTable(rows){
  const head = `<th class="num">Nro</th><th>Obra</th><th>Descripción Flete</th><th>N° Factura</th><th>Solicitado por</th><th>Lugar</th><th>Realizado</th><th class="num">Valor Flete ($)</th><th>Mes</th><th>Año</th>`;
  const body = rows.map(r => `<tr>
      <td class="num"><b>#${r.nro}</b></td>
      <td>${esc(r.obra || "—")}</td>
      <td>${esc(r.descripcion || "—")}</td>
      <td>${esc(r.nroFactura || "—")}</td>
      <td>${esc(r.solicitadoPor || "—")}</td>
      <td>${esc(r.lugar || "—")}</td>
      <td>${fmtDate(r.realizado)}</td>
      <td class="num">${r.valorFlete ? "$ " + fmtMoney(r.valorFlete) : "—"}</td>
      <td>${esc(r.mes || "—")}</td>
      <td>${esc(r.anio || "—")}</td>
    </tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/* ---- exportar el resultado filtrado de Facturas (con fila de total, y
   ahora con el mismo estilo — encabezado, autofiltro, columnas de ancho
   ajustado — que el resto de los exports .xlsx de la app) ---- */
const FACTURAS_EXPORT_COLUMNS = [
  { key:"obra", label:"Obra" },
  { key:"descripcion", label:"Descripción Flete" },
  { key:"nroFactura", label:"N° Factura" },
  { key:"solicitadoPor", label:"Solicitado por" },
  { key:"lugar", label:"Lugar" },
  { key:"realizado", label:"Realizado" },
  { key:"valorFlete", label:"Valor Flete ($)", money:true },
  { key:"mes", label:"Mes" },
  { key:"anio", label:"Año" },
];

function facturasFiltroSufijo(){
  const parts = [];
  if(facturaFilters.mes) parts.push(facturaFilters.mes);
  if(facturaFilters.anio) parts.push(facturaFilters.anio);
  if(facturaFilters.obra) parts.push(facturaFilters.obra);
  return (parts.length ? parts.join("-") : "todas").replace(/\s+/g, "_");
}

function doExportFacturasFiltradas(rows, total, format){
  if(typeof XLSX === "undefined" && format === "xlsx"){
    toast("No se pudo cargar el motor de Excel (revisa tu conexión a internet)");
    return;
  }
  const sufijo = facturasFiltroSufijo();
  if(format === "csv"){
    downloadBlob(rowsToCSV(FACTURAS_EXPORT_COLUMNS, rows), `facturas-${sufijo}-${todayISO()}.csv`, "text/csv;charset=utf-8");
  } else {
    const wb = XLSX.utils.book_new();
    const ws = buildStyledSheet(FACTURAS_EXPORT_COLUMNS, rows);
    XLSX.utils.book_append_sheet(wb, ws, "Facturas filtradas");
    XLSX.writeFile(wb, `facturas-${sufijo}-${todayISO()}.xlsx`);
    toast("Archivo Excel descargado");
  }
}

function openExportFacturasModal(rows, total){
  $("#modalRoot").innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal" style="max-width:460px">
        <div class="modal-head"><h3>Exportar facturas filtradas</h3><button class="modal-close" id="modalClose">✕</button></div>
        <div class="modal-body">
          <div class="form-field">
            <label>Formato de archivo</label>
            <select id="exportFacturasFormat">
              <option value="xlsx">Excel (.xlsx)</option>
              <option value="csv">CSV</option>
            </select>
          </div>
          <p style="color:var(--ink-soft); font-size:12.5px; margin-top:14px;">
            Se exportarán las ${rows.length} factura${rows.length===1?"":"s"} que coinciden con el filtro actual, más una fila final "TOTAL" con la suma de Valor Flete ($ ${fmtMoney(total)}).
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn" id="btnCancel">Cancelar</button>
          <button class="btn btn-accent" id="btnDoExportFacturas">⭳ Descargar</button>
        </div>
      </div>
    </div>`;
  $("#modalClose").addEventListener("click", closeModal);
  $("#btnCancel").addEventListener("click", closeModal);
  $("#overlay").addEventListener("click", e => { if(e.target.id === "overlay") closeModal(); });
  $("#btnDoExportFacturas").addEventListener("click", () => {
    doExportFacturasFiltradas(rows, total, $("#exportFacturasFormat").value);
    closeModal();
  });
}

/* ---------------------------------------------------------------- TABLA GENÉRICA POR MÓDULO */
let searchTerm = "";
let activeFilters = {};
// Guarda una referencia al paint() del módulo genérico actualmente abierto
// (y a qué módulo pertenece), para que el sondeo periódico de rutas pueda
// refrescar solo los datos de la tabla sin reconstruir el buscador ni los
// <select> de filtro — eso es justo lo que hacía que los filtros se
// "reiniciaran solos" cada 30 segundos mientras se estaba usando el panel.
let moduleRepaint = null;

function sortFilterValues(key, items){
  // items: [{value, label}], donde "value" es la clave normalizada (recortada
  // y en minúsculas) usada para comparar, y "label" es el texto a mostrar.
  if(key === "mes") return items.slice().sort((a,b)=> MESES.indexOf(a.label)-MESES.indexOf(b.label));
  if(key === "anio") return items.slice().sort((a,b)=> Number(a.label)-Number(b.label));
  return items.slice().sort((a,b)=> String(a.label).localeCompare(String(b.label),"es"));
}

/* Agrupa los valores de un campo (p. ej. "obra") ignorando mayúsculas y
   espacios de más, para que "CREATIVE" y "Creative " no aparezcan como dos
   opciones distintas en los filtros. Conserva el texto de la primera
   aparición como etiqueta a mostrar. */
function uniqueFilterValues(rows, key){
  const seen = new Map();
  rows.forEach(r => {
    const raw = r[key];
    if(raw === undefined || raw === null || raw === "") return;
    const label = String(raw).trim();
    if(!label) return;
    const norm = label.toLowerCase();
    if(!seen.has(norm)) seen.set(norm, label);
  });
  return [...seen.entries()].map(([value, label]) => ({ value, label }));
}

/* El "shell" (topbar, buscador y barra de filtros) se pinta una sola vez,
   al entrar al módulo. Antes, CADA cambio de filtro —e incluso cada tecla
   escrita en el buscador— reconstruía TODO #main, incluido el propio
   <input> de búsqueda: eso hacía perder el foco/cursor al escribir y se
   sentía como si la app se "recargara" en cada filtro. Ahora solo se
   repinta la tabla y el contador, vía paintModuleTable(). */
function renderModule(key){
  const cfg = MODULES[key];

  const allRowsForFilters = DB[key].map(r => ({...r, ...(cfg.computeFn ? cfg.computeFn(r) : {})}));
  const filterBarHtml = cfg.filters ? cfg.filters.map(f => {
    const values = sortFilterValues(f.key, uniqueFilterValues(allRowsForFilters, f.key));
    return `<select class="filter-select" data-filter="${f.key}">
      <option value="">${esc(f.label)}: Todas</option>
      ${values.map(v=>`<option value="${esc(v.value)}">${esc(v.label)}</option>`).join("")}
    </select>`;
  }).join("") : "";

  $("#main").innerHTML = `
    <div class="topbar">
      <div><span class="eyebrow">${esc(cfg.group)}</span><h1>${cfg.icon} ${esc(cfg.label)}</h1></div>
      <div class="topbar-actions">
        <button class="btn" id="btnExportMod">⭳ Exportar</button>
        <button class="btn" id="btnImportMod">⭱ Importar</button>
        <button class="btn btn-accent" id="btnAdd">+ Añadir registro</button>
      </div>
    </div>
    <div class="toolbar">
      <div class="search-box"><input id="searchInput" placeholder="Buscar en ${esc(cfg.label).toLowerCase()}…"></div>
      ${filterBarHtml}
      <span class="spacer"></span>
      <span class="count-pill" id="moduleCount"></span>
    </div>
    <div class="table-wrap" id="moduleTableWrap"></div>
  `;

  $("#btnAdd").addEventListener("click", ()=> openForm(key, null));
  // Exporta lo que está viendo el usuario en ese momento (con el buscador y
  // los filtros ya aplicados), no todos los registros del módulo — antes
  // "Exportar" ignoraba los filtros y siempre mandaba TODO el módulo.
  $("#btnExportMod").addEventListener("click", ()=> openExportModal(key, currentFilteredRows));
  $("#btnImportMod").addEventListener("click", ()=> openImportModal(key));
  $("#searchInput").addEventListener("input", e=>{ searchTerm = e.target.value; paint(); });
  $$('.filter-select').forEach(sel => sel.addEventListener("change", e => { activeFilters[sel.dataset.filter] = sel.value; paint(); }));

  let currentFilteredRows = [];
  paint();
  moduleRepaint = { key, paint };

  function paint(){
    let rows = DB[key].map(r => ({...r, ...(cfg.computeFn ? cfg.computeFn(r) : {})}));
    if(cfg.filters){
      cfg.filters.forEach(f => {
        const val = activeFilters[f.key];
        if(val) rows = rows.filter(r => String(r[f.key] ?? "").trim().toLowerCase() === val);
      });
    }
    const filtered = searchTerm ? rows.filter(r => JSON.stringify(r).toLowerCase().includes(searchTerm.toLowerCase())) : rows;
    currentFilteredRows = filtered;

    $("#moduleCount").textContent = `${filtered.length} de ${rows.length} registros`;
    $("#moduleTableWrap").innerHTML = filtered.length
      ? renderTable(cfg, filtered)
      : `<div class="empty-state"><div class="big">${cfg.icon}</div>Sin registros todavía.<br><button class="btn btn-accent" style="margin-top:14px" id="btnAddEmpty">+ Añadir el primero</button></div>`;

    const btnAddEmpty = $("#btnAddEmpty");
    if(btnAddEmpty) btnAddEmpty.addEventListener("click", ()=> openForm(key, null));
    $$('[data-edit]').forEach(b=> b.addEventListener('click', ()=> openForm(key, b.dataset.edit)));
    $$('[data-del]').forEach(b=> b.addEventListener('click', ()=> confirmDelete(key, b.dataset.del)));
    $$('.thumb[data-lightbox]').forEach(img => img.addEventListener('click', ()=> openImageLightbox(img.dataset.lightbox)));
    $$('.pdf-view-btn[data-pdf-cell]').forEach(btn => btn.addEventListener('click', ()=> openPdfViewer(btn.dataset.pdfCell)));
  }
}

function renderTable(cfg, rows){
  const cols = cfg.columns;
  const head = `<th class="num">Nro</th>` + cols.map(c => `<th class="${c.numeric?'num':''}">${esc(c.label)}</th>`).join("");
  const body = rows.map(r => {
    const tds = cols.map(c => `<td class="${c.numeric?'num':''}">${cellValue(c, r)}</td>`).join("");
    const locked = cfg.isLocked && cfg.isLocked(r);
    const actions = locked
      ? `<span class="badge badge-ok" title="Ya fue marcada como Realizada: no se puede editar ni eliminar">🔒</span>`
      : `<button class="icon-btn" data-edit="${r.nro}" title="Editar">✎</button>
        <button class="icon-btn danger" data-del="${r.nro}" title="Eliminar">✕</button>`;
    return `<tr><td class="num"><b>#${r.nro}</b></td>${tds}<td class="actions"><div class="row-actions">${actions}</div></td></tr>`;
  }).join("");
  return `<table><thead><tr>${head}<th></th></tr></thead><tbody>${body}</tbody></table>`;
}

function cellValue(col, row){
  let v = row[col.key];
  if(col.key === "nro") return `<b>#${v}</b>`;
  if(col.kind === "image") return v ? `<img src="${v}" class="thumb" data-lightbox="${esc(v)}" title="Ver foto">` : `<span class="badge badge-neutral">Sin foto</span>`;
  if(col.kind === "file") return v ? `<button type="button" class="btn btn-sm pdf-view-btn" data-pdf-cell="${esc(v)}">👁️ Ver PDF</button>` : `<span class="badge badge-neutral">Sin archivo</span>`;
  if(col.plate) return plateChip(v);
  if(col.stars) return `<span class="stars">${"★".repeat(v||0)}${"☆".repeat(5-(v||0))}</span>`;
  if(col.badge) return badgeFor(v);
  if(col.kind === "date") return fmtDate(v);
  if(col.money) return v===undefined||v===null||v==="" ? "—" : `$ ${fmtMoney(v)}`;
  if(col.numeric) return v===undefined||v===null||v==="" ? "—" : fmtNum(v);
  if(v === undefined || v === null || v === "") return "—";
  return esc(String(v));
}

function badgeFor(v){
  const map = {
    "Disponible":"badge-ok", "Vigente":"badge-ok", "Pagado":"badge-ok", "Aun no":"badge-ok",
    "Por vencer":"badge-warn",
    "En viaje":"badge-neutral", "En mantenimiento":"badge-warn",
    "No disponible":"badge-danger", "Vencido":"badge-danger", "Debe":"badge-danger", "Mantener":"badge-danger",
    "Preventivo":"badge-ok", "Correctivo":"badge-warn",
    "✔ Completado":"badge-ok", "Pendiente":"badge-neutral",
  };
  const cls = map[v] || "badge-neutral";
  return `<span class="badge ${cls}">${esc(v ?? "—")}</span>`;
}

/* ---------------------------------------------------------------- FORMULARIO / MODAL */
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

/* Lee un archivo (p. ej. el PDF de una licencia de conducir) como data URL,
   sin comprimir —a diferencia de fileToCompressedDataURL, que es solo para
   fotos—, validando tipo MIME y un tamaño máximo razonable. */
function fileToDataURL(file, { acceptPrefix = "", maxSizeMB = 8 } = {}){
  return new Promise((resolve, reject) => {
    if(acceptPrefix && !file.type.startsWith(acceptPrefix)){
      reject(new Error(`El archivo debe ser de tipo ${acceptPrefix === "application/pdf" ? "PDF" : acceptPrefix}`));
      return;
    }
    if(file.size > maxSizeMB * 1024 * 1024){
      reject(new Error(`El archivo supera el tamaño máximo permitido (${maxSizeMB} MB)`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
    reader.readAsDataURL(file);
  });
}

function openForm(moduleKey, nro){
  const cfg = MODULES[moduleKey];
  const existing = nro ? DB[moduleKey].find(r => String(r.nro) === String(nro)) : null;
  if(existing && cfg.isLocked && cfg.isLocked(existing)){
    toast("Esta ruta ya fue marcada como Realizada y no se puede editar.");
    return;
  }
  editing = { module: moduleKey, nro: existing ? existing.nro : null };
  const draft = existing ? {...existing} : {};

  const fields = cfg.columns.filter(c => c.kind !== "computed" && c.kind !== "image" && c.kind !== "file");
  const imageFields = cfg.columns.filter(c => c.kind === "image");
  const imageDraft = {};
  imageFields.forEach(c => { imageDraft[c.key] = draft[c.key] || ""; });

  const fileFields = cfg.columns.filter(c => c.kind === "file");
  const fileDraft = {};
  fileFields.forEach(c => { fileDraft[c.key] = draft[c.key] || ""; });

  const imageFieldHtml = c => `
    <div class="form-field span2">
      <label>${esc(c.label)}</label>
      <div class="image-field" data-image-field="${c.key}">${renderImageFieldInner(c)}</div>
    </div>`;

  function renderImageFieldInner(c){
    const val = imageDraft[c.key];
    return `
      <div class="image-preview-box">${val ? `<img src="${val}">` : `<span class="image-placeholder">📷 Sin foto</span>`}</div>
      <div class="image-actions">
        <label class="btn btn-sm" for="file-camera-${c.key}">📷 Tomar foto</label>
        <input type="file" accept="image/*" capture="environment" id="file-camera-${c.key}" data-image-input-camera="${c.key}" hidden>
        <label class="btn btn-sm" for="file-gallery-${c.key}">🖼️ Elegir de galería</label>
        <input type="file" accept="image/*" id="file-gallery-${c.key}" data-image-input-gallery="${c.key}" hidden>
        ${val ? `<button type="button" class="btn btn-sm btn-danger" data-image-remove="${c.key}">Quitar</button>` : ""}
      </div>`;
  }

  const fileFieldHtml = c => `
    <div class="form-field span2">
      <label>${esc(c.label)}</label>
      <div class="file-field" data-file-field="${c.key}">${renderFileFieldInner(c)}</div>
    </div>`;

  // Antes de subir un archivo: botón "Subir PDF". Una vez cargado, el
  // mismo lugar pasa a mostrar el botón "Ver PDF" (que abre el visor) más
  // la opción de quitarlo para reemplazarlo por otro.
  function renderFileFieldInner(c){
    const val = fileDraft[c.key];
    if(val){
      return `
        <div class="file-actions">
          <button type="button" class="btn btn-sm" data-file-view="${c.key}">👁️ Ver PDF</button>
          <button type="button" class="btn btn-sm btn-danger" data-file-remove="${c.key}">Quitar</button>
        </div>`;
    }
    return `
      <div class="file-actions">
        <label class="btn btn-sm" for="file-input-${c.key}">📄 Subir PDF</label>
        <input type="file" accept="${c.accept || 'application/pdf'}" id="file-input-${c.key}" data-file-input="${c.key}" hidden>
      </div>`;
  }

  function bindFileField(c){
    const wrap = $(`[data-file-field="${c.key}"]`);
    if(!wrap) return;
    const input = wrap.querySelector(`[data-file-input="${c.key}"]`);
    if(input){
      input.addEventListener("change", async () => {
        const file = input.files[0];
        if(!file) return;
        try{
          fileDraft[c.key] = await fileToDataURL(file, { acceptPrefix: "application/pdf", maxSizeMB: 8 });
          wrap.innerHTML = renderFileFieldInner(c);
          bindFileField(c);
        }catch(err){ toast(err.message); }
      });
    }
    const viewBtn = wrap.querySelector(`[data-file-view="${c.key}"]`);
    if(viewBtn) viewBtn.addEventListener("click", () => openPdfViewer(fileDraft[c.key]));
    const removeBtn = wrap.querySelector(`[data-file-remove="${c.key}"]`);
    if(removeBtn){
      removeBtn.addEventListener("click", () => {
        fileDraft[c.key] = "";
        wrap.innerHTML = renderFileFieldInner(c);
        bindFileField(c);
      });
    }
  }

  // Habilita "Marcar realizado" (solo Rutas) únicamente cuando ya existe la
  // foto Report (fotoFin) en el borrador actual del formulario.
  function updateSaveCompleteState(){
    if(moduleKey !== "rutas") return;
    const btn = $("#btnSaveComplete");
    if(!btn) return;
    const hasReport = !!imageDraft.fotoFin;
    btn.disabled = !hasReport;
    btn.title = hasReport ? "" : "Debes cargar la foto Report antes de marcar la ruta como realizada";
  }

  function bindImageField(c){
    const wrap = $(`[data-image-field="${c.key}"]`);
    if(!wrap) return;
    const handleFile = async (input) => {
      const file = input.files[0];
      if(!file) return;
      try{
        imageDraft[c.key] = await fileToCompressedDataURL(file);
        wrap.innerHTML = renderImageFieldInner(c);
        bindImageField(c);
        updateSaveCompleteState();
      }catch(err){ toast(err.message); }
    };
    const cameraInput = wrap.querySelector(`[data-image-input-camera="${c.key}"]`);
    if(cameraInput) cameraInput.addEventListener("change", () => handleFile(cameraInput));
    const galleryInput = wrap.querySelector(`[data-image-input-gallery="${c.key}"]`);
    if(galleryInput) galleryInput.addEventListener("change", () => handleFile(galleryInput));
    const removeBtn = wrap.querySelector(`[data-image-remove="${c.key}"]`);
    if(removeBtn){
      removeBtn.addEventListener("click", () => {
        imageDraft[c.key] = "";
        wrap.innerHTML = renderImageFieldInner(c);
        bindImageField(c);
        updateSaveCompleteState();
      });
    }
  }

  const inputHtml = c => {
    const val = draft[c.key] ?? "";
    const wide = c.wide ? " span2" : "";
    if(c.kind === "select"){
      const opts = typeof c.options === "function" ? c.options(draft) : c.options;
      const normalized = opts.map(o => (o && o.value !== undefined) ? o : {value:o, label:o});
      const optionsHtml = normalized.map(o => `<option value="${esc(o.value)}" ${String(o.value)===String(val)?"selected":""}>${esc(o.label)}</option>`).join("");
      return `<div class="form-field${wide}"><label>${esc(c.label)}${c.required?" *":""}</label>
        <select data-field="${c.key}" ${c.cascadeTarget?`data-cascade="${c.cascadeTarget}"`:""}>
          <option value="">— Seleccionar —</option>${optionsHtml}
        </select></div>`;
    }
    if(c.kind === "textarea"){
      return `<div class="form-field${wide}"><label>${esc(c.label)}</label><textarea data-field="${c.key}">${esc(val)}</textarea></div>`;
    }
    if(c.kind === "combo"){
      const opts = typeof c.options === "function" ? c.options(draft) : (c.options || []);
      const listId = `datalist-${c.key}`;
      return `<div class="form-field${wide}"><label>${esc(c.label)}${c.required?" *":""}</label>
        <input data-field="${c.key}" type="text" list="${listId}" value="${esc(val)}" autocomplete="off">
        <datalist id="${listId}">${opts.map(o=>`<option value="${esc(o)}">`).join("")}</datalist>
      </div>`;
    }
    const type = c.kind === "number" ? "number" : c.kind === "date" ? "date" : "text";
    const step = c.kind === "number" ? ` step="any"` : "";
    return `<div class="form-field${wide}"><label>${esc(c.label)}${c.required?" *":""}</label>
      <input data-field="${c.key}" type="${type}"${step} value="${esc(val)}"></div>`;
  };

  const previewComputed = existing && cfg.computeFn ? cfg.computeFn(existing) : (cfg.computeFn ? cfg.computeFn(draft) : null);
  const computedHtml = previewComputed ? `
    <div class="form-field span2"><label>Campos calculados automáticamente</label>
      <div class="readonly-val">${Object.entries(previewComputed).map(([k,v])=>{
        const col = cfg.columns.find(c=>c.key===k);
        return `${col?col.label:k}: <b>${typeof v==='number' ? fmtNum(v) : esc(v)}</b>`;
      }).join(" &nbsp;·&nbsp; ")}</div>
    </div>` : "";

  $("#modalRoot").innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal">
        <div class="modal-head">
          <h3>${existing ? "Editar" : "Nuevo"} registro · ${cfg.icon} ${esc(cfg.label)}</h3>
          <button class="modal-close" id="modalClose">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            ${fields.map(inputHtml).join("")}
            ${imageFields.map(imageFieldHtml).join("")}
            ${fileFields.map(fileFieldHtml).join("")}
          </div>
          ${computedHtml}
        </div>
        <div class="modal-foot">
          <button class="btn" id="btnCancel">Cancelar</button>
          ${moduleKey === "rutas" ? `<button class="btn" id="btnSaveComplete" style="background:#16a34a;border-color:#16a34a;color:#fff" ${imageDraft.fotoFin ? "" : "disabled"} title="${imageDraft.fotoFin ? "" : "Debes cargar la foto Report antes de marcar la ruta como realizada"}">✅ Marcar realizado</button>` : ""}
          <button class="btn btn-accent" id="btnSave">${existing ? "Guardar cambios" : "Crear registro"}</button>
        </div>
      </div>
    </div>`;

  $("#modalClose").addEventListener("click", closeModal);
  $("#btnCancel").addEventListener("click", closeModal);
  $("#overlay").addEventListener("click", e => { if(e.target.id === "overlay") closeModal(); });

  imageFields.forEach(bindImageField);
  fileFields.forEach(bindFileField);

  // cascading selects (marca -> modelo, tipo -> paquete)
  $$('[data-cascade]').forEach(sel => {
    sel.addEventListener("change", () => {
      draft[sel.dataset.field] = sel.value;
      const targetKey = sel.dataset.cascade;
      const targetCol = cfg.columns.find(c => c.key === targetKey);
      const targetSel = $(`[data-field="${targetKey}"]`);
      if(targetCol && targetSel){
        const opts = targetCol.options(draft);
        targetSel.innerHTML = `<option value="">— Seleccionar —</option>` + opts.map(o=>`<option value="${esc(o)}">${esc(o)}</option>`).join("");
      }
    });
  });

  $("#btnSave").addEventListener("click", () => submitForm(moduleKey, fields, imageFields, imageDraft, fileFields, fileDraft));

  // Botón extra solo en Rutas de viaje (panel admin): guarda la ruta,
  // la marca como realizada y salta directo al módulo de Fletes. Solo se
  // habilita cuando ya existe la foto Report.
  const btnSaveComplete = $("#btnSaveComplete");
  if(btnSaveComplete){
    btnSaveComplete.addEventListener("click", () => submitForm(moduleKey, fields, imageFields, imageDraft, fileFields, fileDraft, { markCompleted: true }));
  }
  updateSaveCompleteState();
}

async function submitForm(moduleKey, fields, imageFields, imageDraft, fileFields, fileDraft, opts = {}){
  const cfg = MODULES[moduleKey];
  const data = {};
  let missing = null;
  fields.forEach(c => {
    const el = $(`[data-field="${c.key}"]`);
    let v = el.value;
    if(c.kind === "number") v = v === "" ? "" : Number(v);
    if(c.kind === "select" && c.stars) v = Number(v);
    if(c.kind === "text" || c.kind === "textarea" || c.kind === "combo") v = v.trim();
    if(c.uppercase && typeof v === "string") v = v.toUpperCase();
    if(c.required && (v === "" || v === undefined || v === null)) missing = c.label;
    data[c.key] = v;
  });
  (imageFields || []).forEach(c => { data[c.key] = (imageDraft && imageDraft[c.key]) || ""; });
  (fileFields || []).forEach(c => { data[c.key] = (fileDraft && fileDraft[c.key]) || ""; });

  // "Guardar y marcar Realizado" (solo Rutas, panel admin): si no se cargó
  // fecha de llegada, se completa con la fecha de hoy para dejar la ruta
  // como cerrada — ese valor es el que se copia como "Realizado" al crear
  // o actualizar el flete espejo (ver fleteDataFromRuta).
  if(opts.markCompleted && moduleKey === "rutas" && !data.fechaLlegada){
    data.fechaLlegada = todayISO();
  }

  if(missing){ toast(`Falta completar: ${missing}`); return; }

  // Catálogos dinámicos: cualquier valor nuevo escrito en un campo con
  // catálogo asociado (p. ej. Obra) se agrega solo, para quedar disponible
  // la próxima vez en el desplegable de sugerencias y en los filtros.
  fields.forEach(c => {
    if(c.catalogKey && data[c.key]){
      const list = CAT[c.catalogKey] || (CAT[c.catalogKey] = []);
      if(!list.includes(data[c.key])){ list.push(data[c.key]); persistCat(); }
    }
  });

  const isUpdate = !!editing.nro;
  let savedRow;
  if(isUpdate){
    const idx = DB[moduleKey].findIndex(r => String(r.nro) === String(editing.nro));
    DB[moduleKey][idx] = { ...DB[moduleKey][idx], ...data };
    savedRow = DB[moduleKey][idx];
    markDirty(moduleKey, savedRow.nro);
    toast("Registro actualizado");
  } else if(moduleKey === "rutas"){
    // El nro lo asigna siempre el backend (MAX(nro)+1 calculado en el
    // servidor, ver api/rutas/save.php), nunca el navegador: un conductor
    // podría estar creando otra ruta en este mismo instante desde su teléfono.
    const payload = sanitizeRowForDb("rutas", data);
    delete payload.nro;
    const { data: result, error } = await guardarRutaEnServidor(payload);
    if(error === "cancelado") return;
    if(error){ console.error("Error al crear ruta", error); toast("Error al crear la ruta"); return; }
    data.nro = result.row.nro;
    DB.rutas.push(data);
    savedRow = data;
    toast("Registro creado");
  } else {
    // Igual que rutas: se consulta el máximo real en la base antes de
    // asignar el próximo número, para no pisar un registro creado en otra
    // sesión que esta pestaña todavía no tiene cargado en memoria.
    data.nro = await nextNroSafe(moduleKey);
    DB[moduleKey].push(data);
    savedRow = data;
    markDirty(moduleKey, savedRow.nro);
    toast("Registro creado");
  }
  if(moduleKey === "rutas"){
    await syncFleteFromRuta(savedRow);
    if(isUpdate) upsertRutaRow(savedRow); // si es nuevo, ya se insertó arriba
  }
  persistDB({ skipRutas: moduleKey === "rutas" });
  logActivity(moduleKey, isUpdate ? "update" : "create", savedRow.nro, cfg.summary ? cfg.summary(savedRow) : `#${savedRow.nro}`);
  closeModal();

  if(opts.markCompleted && moduleKey === "rutas"){
    // La ruta ya generó/actualizó su flete espejo arriba (syncFleteFromRuta).
    // Cerramos el modal de Rutas y pasamos directo a Fletes para que el
    // admin complete los datos administrativos (tipo, solicitado por, etc.).
    goTo("fletes");
    toast("Ruta marcada como realizada");
  } else {
    renderSidebar();
    renderMain();
  }
}

function closeModal(){ $("#modalRoot").innerHTML = ""; editing = {module:null, nro:null}; }

function confirmDelete(moduleKey, nro){
  const cfg = MODULES[moduleKey];
  const row = DB[moduleKey].find(r => String(r.nro) === String(nro));
  if(row && cfg.isLocked && cfg.isLocked(row)){
    toast("Esta ruta ya fue marcada como Realizada y no se puede eliminar.");
    return;
  }
  $("#modalRoot").innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal" style="max-width:420px">
        <div class="modal-head"><h3>Eliminar registro</h3><button class="modal-close" id="modalClose">✕</button></div>
        <div class="modal-body">
          <p>¿Eliminar el registro <b>#${nro}${row && cfg.summary ? " — "+esc(cfg.summary(row)) : ""}</b> de <b>${esc(cfg.label)}</b>?
          Podrás deshacerlo justo después, o restaurarlo luego desde la Papelera.</p>
        </div>
        <div class="modal-foot">
          <button class="btn" id="btnCancel">Cancelar</button>
          <button class="btn btn-danger" id="btnConfirmDel">Sí, eliminar</button>
        </div>
      </div>
    </div>`;
  $("#modalClose").addEventListener("click", closeModal);
  $("#btnCancel").addEventListener("click", closeModal);
  $("#overlay").addEventListener("click", e => { if(e.target.id === "overlay") closeModal(); });
  $("#btnConfirmDel").addEventListener("click", async ()=>{
    const idx = DB[moduleKey].findIndex(r => String(r.nro) === String(nro));
    if(idx === -1){ closeModal(); return; }
    const [removed] = DB[moduleKey].splice(idx, 1);
    if(moduleKey === "rutas"){ removeFleteForRuta(removed.nro); deleteRutaRow(removed.nro); }
    else { markDeleted(moduleKey, removed.nro); }
    const trashId = uid();
    TRASH[moduleKey].push({ ...removed, _trashId: trashId, _deletedAt: new Date().toISOString() });
    persistDB({ skipRutas: moduleKey === "rutas" }); persistTrash();
    logActivity(moduleKey, "delete", removed.nro, cfg.summary ? cfg.summary(removed) : `#${removed.nro}`);
    closeModal();
    renderSidebar();
    renderMain();
    toast("Registro eliminado", { actionLabel: "Deshacer", onAction: () => restoreFromTrash(moduleKey, trashId) });
  });
}

/* ---------------------------------------------------------------- PAPELERA (registros eliminados) */
async function restoreFromTrash(moduleKey, trashId){
  const idx = TRASH[moduleKey].findIndex(t => t._trashId === trashId);
  if(idx === -1){ toast("Ese registro ya no está en la papelera"); return; }
  const [item] = TRASH[moduleKey].splice(idx, 1);
  delete item._trashId;
  const deletedAt = item._deletedAt;
  delete item._deletedAt;
  if(DB[moduleKey].some(r => String(r.nro) === String(item.nro))) item.nro = await nextNroSafe(moduleKey);
  DB[moduleKey].push(item);
  if(moduleKey === "rutas"){ await syncFleteFromRuta(item); upsertRutaRow(item); }
  else { markDirty(moduleKey, item.nro); }
  persistDB({ skipRutas: moduleKey === "rutas" }); persistTrash();
  logActivity(moduleKey, "restore", item.nro, MODULES[moduleKey].summary ? MODULES[moduleKey].summary(item) : `#${item.nro}`);
  toast("Registro restaurado");
  renderSidebar();
  renderMain();
}

function purgeFromTrash(moduleKey, trashId){
  const cfg = MODULES[moduleKey];
  const item = TRASH[moduleKey].find(t => t._trashId === trashId);
  $("#modalRoot").innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal" style="max-width:420px">
        <div class="modal-head"><h3>Eliminar definitivamente</h3><button class="modal-close" id="modalClose">✕</button></div>
        <div class="modal-body"><p>Esta acción borrará <b>${item && cfg.summary ? esc(cfg.summary(item)) : "el registro"}</b> para siempre y ya no podrá restaurarse. ¿Continuar?</p></div>
        <div class="modal-foot">
          <button class="btn" id="btnCancel">Cancelar</button>
          <button class="btn btn-danger" id="btnConfirmPurge">Sí, borrar definitivamente</button>
        </div>
      </div>
    </div>`;
  $("#modalClose").addEventListener("click", closeModal);
  $("#btnCancel").addEventListener("click", closeModal);
  $("#overlay").addEventListener("click", e => { if(e.target.id === "overlay") closeModal(); });
  $("#btnConfirmPurge").addEventListener("click", () => {
    TRASH[moduleKey] = TRASH[moduleKey].filter(t => t._trashId !== trashId);
    persistTrash();
    closeModal();
    toast("Registro eliminado definitivamente");
    renderSidebar();
    renderMain();
  });
}

function trashCount(){
  return MODULE_ORDER.reduce((a,k) => a + (TRASH[k] ? TRASH[k].length : 0), 0);
}

function renderPapelera(){
  const total = trashCount();
  const sections = MODULE_ORDER.filter(k => TRASH[k] && TRASH[k].length).map(key => {
    const cfg = MODULES[key];
    const items = [...TRASH[key]].sort((a,b) => new Date(b._deletedAt) - new Date(a._deletedAt));
    const rows = items.map(item => `
      <div class="mini-row">
        <span>${cfg.summary ? esc(cfg.summary(item)) : `#${item.nro}`} <span class="empty-note" style="margin-left:6px;">eliminado el ${fmtDateTime(item._deletedAt)}</span></span>
        <span class="row-actions">
          <button class="btn btn-sm" data-restore="${item._trashId}" data-mod="${key}">↺ Restaurar</button>
          <button class="btn btn-sm btn-danger" data-purge="${item._trashId}" data-mod="${key}">✕ Definitivo</button>
        </span>
      </div>`).join("");
    return `<div class="panel" style="margin-bottom:16px;">
      <h3><span class="ico">${cfg.icon}</span> ${esc(cfg.label)} <span class="count-pill">${items.length}</span></h3>
      ${rows}
    </div>`;
  }).join("");

  $("#main").innerHTML = `
    <div class="topbar">
      <div><span class="eyebrow">Historial</span><h1>🗑️ Papelera</h1></div>
    </div>
    <p style="color:var(--ink-soft); max-width:640px; margin-bottom:18px;">
      Los registros eliminados quedan aquí, organizados por módulo, con la fecha y hora exacta en que se borraron.
      Puedes restaurarlos en cualquier momento o eliminarlos de forma definitiva.
    </p>
    ${total ? sections : `<div class="empty-state"><div class="big">🗑️</div>La papelera está vacía.</div>`}
  `;
  $$('[data-restore]').forEach(b => b.addEventListener('click', () => restoreFromTrash(b.dataset.mod, b.dataset.restore)));
  $$('[data-purge]').forEach(b => b.addEventListener('click', () => purgeFromTrash(b.dataset.mod, b.dataset.purge)));
}

/* ==========================================================================
   MAPA OPERACIONAL (#11) + SEGUIMIENTO GPS (#10, interino vía navegador)
   ========================================================================== */
const ESTADOS_ACTIVOS_RUTA = ["Asignado","Aceptado","En ruta","En destino"];

// Rutas activas que ya tienen al menos una posición GPS reportada por el
// conductor. Mientras la flota no tenga GPS embarcado, esta es la fuente:
// el teléfono del conductor manda su posición mientras el servicio está en
// curso (ver conductor/js/app.js → pingUbicacion).
function rutasActivasConUbicacion(){
  if(!DB || !DB.rutas) return [];
  return DB.rutas.filter(r => ESTADOS_ACTIVOS_RUTA.includes(r.estadoServicio || "Asignado") && r.lat != null && r.lng != null);
}

let _mapaLeaflet = null;
let _mapaMarkers = [];

const ESTADO_MAP_COLOR = {
  "Asignado":"#94a3b8", "Aceptado":"#3b82f6", "En ruta":"#f59e0b", "En destino":"#22c55e",
};

function renderMapa(){
  const conGps = rutasActivasConUbicacion();
  const activasSinGps = DB.rutas.filter(r => ESTADOS_ACTIVOS_RUTA.includes(r.estadoServicio || "Asignado") && (r.lat == null || r.lng == null));

  $("#main").innerHTML = `
    <div class="topbar">
      <div><span class="eyebrow">Seguimiento</span><h1>📍 Mapa operacional</h1></div>
    </div>
    <p style="color:var(--ink-soft); max-width:760px; margin-bottom:14px;">
      Ubicación de los servicios activos, reportada por el teléfono del conductor mientras usa la app
      (todavía no hay GPS instalado en los vehículos de la flota — en cuanto lo haya, puede alimentar
      este mismo mapa sin cambios). Se actualiza solo mientras el conductor tiene la app abierta y dio
      permiso de ubicación.
    </p>
    <div id="mapaOperacional" style="height:460px; border-radius:14px; overflow:hidden; border:1px solid var(--border);"></div>
    ${activasSinGps.length ? `
      <div class="panel" style="margin-top:16px;">
        <h3><span class="ico">📡</span> Servicios activos sin ubicación todavía <span class="count-pill">${activasSinGps.length}</span></h3>
        ${activasSinGps.map(r => `
          <div class="mini-row">
            <span>${esc(r.origen||"—")} → ${esc(r.destino||"—")} · ${esc(r.conductor||"—")} ${r.placa?`· ${esc(r.placa)}`:""}</span>
            <span class="badge badge-neutral">${esc(r.estadoServicio || "Asignado")}</span>
          </div>`).join("")}
      </div>` : ``}
    ${(!conGps.length && !activasSinGps.length) ? `<div class="empty-state" style="margin-top:16px;"><div class="big">📍</div>No hay servicios activos en este momento.</div>` : ``}
  `;

  ensureLeaflet(() => {
    const container = $("#mapaOperacional");
    if(!container) return;
    _mapaLeaflet = L.map(container).setView([-33.45, -70.65], 6); // centro por defecto: Chile central
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(_mapaLeaflet);

    _mapaMarkers = [];
    conGps.forEach(r => {
      const color = ESTADO_MAP_COLOR[r.estadoServicio] || "#64748b";
      const icon = L.divIcon({
        className: "", html: `<div style="width:16px;height:16px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 0 1px ${color}"></div>`,
        iconSize: [16,16], iconAnchor: [8,8],
      });
      const marker = L.marker([r.lat, r.lng], { icon }).addTo(_mapaLeaflet);
      marker.bindPopup(`
        <b>${esc(r.origen||"—")} → ${esc(r.destino||"—")}</b><br>
        ${esc(r.conductor||"—")} ${r.placa?`· ${esc(r.placa)}`:""}<br>
        Estado: ${esc(r.estadoServicio||"Asignado")}<br>
        Última actualización: ${fmtDateTime(r.ubicacionTs)}
      `);
      _mapaMarkers.push(marker);
    });

    if(_mapaMarkers.length){
      const group = L.featureGroup(_mapaMarkers);
      _mapaLeaflet.fitBounds(group.getBounds().pad(0.3));
    }
  });
}

// Carga Leaflet (CSS+JS) desde CDN una sola vez, de forma perezosa: así el
// resto del panel no paga el costo de cargarlo si nadie visita el Mapa.
let _leafletLoading = null;
function ensureLeaflet(cb){
  if(window.L){ cb(); return; }
  if(!_leafletLoading){
    _leafletLoading = new Promise(resolve => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
      const script = document.createElement("script");
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
      script.onload = resolve;
      document.head.appendChild(script);
    });
  }
  _leafletLoading.then(cb);
}

/* ==========================================================================
   HISTORIAL DE OPERACIONES (#17) — consulta de servicios realizados,
   con filtros por período, vehículo, conductor y obra/cliente. Distinto
   de la Bitácora (que es un log crudo de altas/bajas/ediciones) y de la
   Papelera (registros borrados): esto es la vista operacional para
   responder "¿qué se transportó, cuándo, con qué camión y quién lo hizo?".
   ========================================================================== */
let histFiltros = { desde:"", hasta:"", placa:"", conductor:"", obra:"" };

function renderHistorialOperaciones(){
  const placas = [...new Set(DB.rutas.map(r=>r.placa).filter(Boolean))].sort();
  const conductoresList = [...new Set(DB.rutas.map(r=>r.conductor).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"es"));
  const obras = [...new Set(DB.rutas.map(r=>r.obra).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"es"));

  $("#main").innerHTML = `
    <div class="topbar">
      <div><span class="eyebrow">Seguimiento</span><h1>🕓 Historial de operaciones</h1></div>
      <div class="topbar-actions"><span class="count-pill" id="histCount"></span></div>
    </div>
    <p style="color:var(--ink-soft); max-width:760px; margin-bottom:14px;">
      Todos los servicios (rutas) registrados, filtrables por período, vehículo, conductor u obra/cliente.
    </p>
    <div class="toolbar">
      <label style="display:flex;flex-direction:column;font-size:12px;color:var(--ink-soft);gap:4px;">Desde
        <input type="date" id="histDesde" value="${histFiltros.desde}"></label>
      <label style="display:flex;flex-direction:column;font-size:12px;color:var(--ink-soft);gap:4px;">Hasta
        <input type="date" id="histHasta" value="${histFiltros.hasta}"></label>
      <select class="filter-select" id="histPlaca"><option value="">Vehículo: Todos</option>${placas.map(p=>`<option value="${esc(p)}" ${histFiltros.placa===p?"selected":""}>${esc(p)}</option>`).join("")}</select>
      <select class="filter-select" id="histConductor"><option value="">Conductor: Todos</option>${conductoresList.map(c=>`<option value="${esc(c)}" ${histFiltros.conductor===c?"selected":""}>${esc(c)}</option>`).join("")}</select>
      <select class="filter-select" id="histObra"><option value="">Obra/cliente: Todas</option>${obras.map(o=>`<option value="${esc(o)}" ${histFiltros.obra===o?"selected":""}>${esc(o)}</option>`).join("")}</select>
      <button class="btn btn-sm" id="histLimpiar">Limpiar filtros</button>
    </div>
    <div class="table-wrap" id="histTableWrap"></div>
  `;

  const paint = () => {
    let rows = DB.rutas.slice();
    if(histFiltros.desde) rows = rows.filter(r => r.fechaSalida && r.fechaSalida >= histFiltros.desde);
    if(histFiltros.hasta) rows = rows.filter(r => r.fechaSalida && r.fechaSalida <= histFiltros.hasta);
    if(histFiltros.placa) rows = rows.filter(r => r.placa === histFiltros.placa);
    if(histFiltros.conductor) rows = rows.filter(r => r.conductor === histFiltros.conductor);
    if(histFiltros.obra) rows = rows.filter(r => r.obra === histFiltros.obra);
    rows.sort((a,b) => (b.fechaSalida||"").localeCompare(a.fechaSalida||""));

    $("#histCount").textContent = `${rows.length} servicio(s)`;
    $("#histTableWrap").innerHTML = rows.length ? `
      <table><thead><tr>
        <th class="num">Nro</th><th>Salida</th><th>Llegada</th><th>Vehículo</th><th>Conductor</th>
        <th>Obra/cliente</th><th>Origen → Destino</th><th>Estado</th><th class="num">Ingreso ($)</th>
      </tr></thead><tbody>
        ${rows.map(r => `<tr>
          <td class="num"><b>#${r.nro}</b></td>
          <td>${fmtDate(r.fechaSalida)}</td>
          <td>${fmtDate(r.fechaLlegada)}</td>
          <td>${plateChip(r.placa)}</td>
          <td>${esc(r.conductor||"—")}</td>
          <td>${esc(r.obra||"—")}</td>
          <td>${esc(r.origen||"—")} → ${esc(r.destino||"—")}</td>
          <td>${badgeFor(r.estadoServicio||"Asignado")}</td>
          <td class="num">$ ${fmtMoney((Number(r.pesoCarga)||0) * (Number(r.costoPorKg)||0))}</td>
        </tr>`).join("")}
      </tbody></table>` : `<div class="empty-state"><div class="big">🕓</div>Ningún servicio coincide con estos filtros.</div>`;
  };

  $("#histDesde").addEventListener("change", e => { histFiltros.desde = e.target.value; paint(); });
  $("#histHasta").addEventListener("change", e => { histFiltros.hasta = e.target.value; paint(); });
  $("#histPlaca").addEventListener("change", e => { histFiltros.placa = e.target.value; paint(); });
  $("#histConductor").addEventListener("change", e => { histFiltros.conductor = e.target.value; paint(); });
  $("#histObra").addEventListener("change", e => { histFiltros.obra = e.target.value; paint(); });
  $("#histLimpiar").addEventListener("click", () => { histFiltros = { desde:"", hasta:"", placa:"", conductor:"", obra:"" }; renderHistorialOperaciones(); });

  paint();
}

/* ==========================================================================
   AUDITORÍA (#19, refuerzo) — a diferencia de la Bitácora (que solo vive en
   el navegador y solo registra acciones hechas desde el panel), esta tabla
   vive en el servidor y registra TODO: acciones del panel Y del conductor
   (cambios de estado, reportes, etc.), con quién las hizo realmente
   (resuelto siempre en el backend, nunca por lo que mande el navegador).
   ========================================================================== */
let auditoriaCache = null;

async function renderAuditoria(){
  $("#main").innerHTML = `
    <div class="topbar">
      <div><span class="eyebrow">Historial</span><h1>🔒 Auditoría</h1></div>
    </div>
    <p style="color:var(--ink-soft); max-width:760px; margin-bottom:14px;">
      Registro fino de "quién hizo qué": incluye acciones del panel (admin/operador) y de la app del
      conductor (cambios de estado, reportes de cierre), con el actor resuelto siempre en el servidor.
    </p>
    <div class="table-wrap" id="auditTableWrap">Cargando…</div>
  `;

  const { data, error } = await apiFetch("auditoria_log/list.php");
  if(error){ $("#auditTableWrap").innerHTML = `<div class="empty-state">No se pudo cargar la auditoría.</div>`; return; }
  auditoriaCache = data.rows || [];

  const ACCION_LABELS = { create:"Creado", update:"Actualizado", cambio_estado:"Cambio de estado" };
  $("#auditTableWrap").innerHTML = auditoriaCache.length ? `
    <table><thead><tr><th>Fecha</th><th>Actor</th><th>Acción</th><th>Entidad</th><th>Detalle</th></tr></thead><tbody>
      ${auditoriaCache.map(a => `<tr>
        <td>${fmtDateTime(a.creado_en)}</td>
        <td><span class="badge ${a.actor_tipo==='admin'?'badge-neutral':'badge-accent'}">${esc(a.actor_tipo==='admin'?'Panel':'Conductor')}</span> ${esc(a.actor_nombre)}</td>
        <td>${esc(ACCION_LABELS[a.accion] || a.accion)}</td>
        <td>${esc(a.entidad)}${a.entidad_id?` #${a.entidad_id}`:""}</td>
        <td>${esc(a.detalle||"—")}</td>
      </tr>`).join("")}
    </tbody></table>` : `<div class="empty-state"><div class="big">🔒</div>Todavía no hay eventos de auditoría.</div>`;
}

/* ---------------------------------------------------------------- BITÁCORA (registro de actividad diaria) */
const ACTION_LABELS = { create:"Creado", update:"Actualizado", delete:"Eliminado", restore:"Restaurado" };
const ACTION_BADGES = { create:"badge-ok", update:"badge-neutral", delete:"badge-danger", restore:"badge-warn" };

function dayLabel(dateStr){
  const today = todayISO();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
  if(dateStr === today) return "Hoy";
  if(dateStr === yesterday) return "Ayer";
  return fmtDate(dateStr);
}

function renderBitacora(){
  const groups = [];
  const seen = {};
  LOG.forEach(entry => {
    const day = entry.ts.slice(0,10);
    if(!seen[day]){ seen[day] = { day, entries: [] }; groups.push(seen[day]); }
    seen[day].entries.push(entry);
  });

  const html = groups.map(g => `
    <div class="panel" style="margin-bottom:16px;">
      <h3><span class="ico">📆</span> ${esc(dayLabel(g.day))} <span class="count-pill">${g.entries.length} evento(s)</span></h3>
      ${g.entries.map(e => {
        const cfg = MODULES[e.moduleKey];
        return `<div class="mini-row">
          <span>${fmtTime(e.ts)} · ${cfg ? cfg.icon : "•"} ${cfg ? esc(cfg.label) : esc(e.moduleKey)} — ${esc(e.summary || ("#"+e.nro))}${e.usuario ? ` <span class="empty-note" style="margin-left:6px;">por ${esc(e.usuario)}</span>` : ""}</span>
          <span class="badge ${ACTION_BADGES[e.action] || "badge-neutral"}">${esc(ACTION_LABELS[e.action] || e.action)}</span>
        </div>`;
      }).join("")}
    </div>`).join("");

  $("#main").innerHTML = `
    <div class="topbar">
      <div><span class="eyebrow">Historial</span><h1>📜 Registro de actividad</h1></div>
    </div>
    <p style="color:var(--ink-soft); max-width:640px; margin-bottom:18px;">
      Aquí queda constancia, día a día, de cada registro creado, editado, eliminado o restaurado en el sistema.
    </p>
    ${groups.length ? html : `<div class="empty-state"><div class="big">📜</div>Todavía no hay actividad registrada.</div>`}
  `;
}

/* ==========================================================================
   CATÁLOGOS (listas de referencia editables)
   ========================================================================== */
const CATALOG_UI = [
  { key:"tiposVehiculo", label:"Tipos de vehículo", type:"simple" },
  { key:"infracciones", label:"Infracciones", type:"simple" },
  { key:"marcaModelo", label:"Marcas y modelos", type:"pair", fields:["marca","modelo"] },
];

function renderCatalogos(){
  // "Obras" se agrega aquí (en vez de en data.js) para que la lista de
  // catálogos editables incluya siempre este catálogo, sin importar si la
  // instalación ya existía antes de que se agregara esta sección.
  if(typeof CATALOG_UI !== "undefined" && !CATALOG_UI.some(c => c.key === "obras")){
    CATALOG_UI.push({ key:"obras", label:"Obras", type:"simple" });
  }
  $("#main").innerHTML = `
    <div class="topbar">
      <div><span class="eyebrow">Configuración</span><h1>📋 Catálogos y listas de referencia</h1></div>
    </div>
    <p style="color:var(--ink-soft); max-width:640px; margin-bottom:18px;">
      Estas listas alimentan los desplegables de los formularios (equivalen a la hoja
      <b>"Otras listas"</b> del Excel original). Añade o quita valores según tu operación.
    </p>
    <div class="cat-grid" id="catGrid"></div>
  `;
  const grid = $("#catGrid");
  CATALOG_UI.forEach(c => grid.appendChild(catalogCard(c)));
}

function catalogCard(c){
  const div = document.createElement("div");
  div.className = "cat-card";

  if(c.type === "simple"){
    const items = CAT[c.key];
    div.innerHTML = `
      <h4>${esc(c.label)} <span class="count-pill">${items.length}</span></h4>
      <ul class="cat-list">${items.map((v,i)=>`<li><span>${esc(v)}</span><button class="icon-btn danger" data-rm="${i}">✕</button></li>`).join("") || `<li class="empty-note">Sin elementos</li>`}</ul>
      <div class="cat-add"><input placeholder="Nuevo valor…" data-new><button class="btn btn-sm btn-accent" data-add>+</button></div>
    `;
    div.querySelector("[data-add]").addEventListener("click", ()=>{
      const input = div.querySelector("[data-new]");
      let val = input.value.trim();
      if(!val) return;
      if(c.key === "obras") val = val.toUpperCase();
      CAT[c.key].push(val);
      persistCat(); renderCatalogos(); toast("Añadido a "+c.label);
    });
    div.querySelectorAll("[data-rm]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        CAT[c.key].splice(Number(btn.dataset.rm),1);
        persistCat(); renderCatalogos();
      });
    });
  } else if(c.type === "pair"){
    const items = CAT[c.key];
    div.innerHTML = `
      <h4>${esc(c.label)} <span class="count-pill">${items.length}</span></h4>
      <ul class="cat-list">${items.map((v,i)=>`<li><span>${esc(v.marca)} — ${esc(v.modelo)}</span><button class="icon-btn danger" data-rm="${i}">✕</button></li>`).join("") || `<li class="empty-note">Sin elementos</li>`}</ul>
      <div class="cat-add"><input placeholder="Marca" data-new-a style="max-width:40%"><input placeholder="Modelo" data-new-b><button class="btn btn-sm btn-accent" data-add>+</button></div>
    `;
    div.querySelector("[data-add]").addEventListener("click", ()=>{
      const a = div.querySelector("[data-new-a]").value.trim();
      const b = div.querySelector("[data-new-b]").value.trim();
      if(!a || !b) return;
      CAT[c.key].push({marca:a, modelo:b});
      persistCat(); renderCatalogos(); toast("Añadido a "+c.label);
    });
    div.querySelectorAll("[data-rm]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        CAT[c.key].splice(Number(btn.dataset.rm),1);
        persistCat(); renderCatalogos();
      });
    });
  }
  return div;
}

/* ==========================================================================
   USUARIOS Y ROLES (solo visible con rol "admin" o "superadmin")
   ========================================================================== */
function rolLabelUsuario(rol){
  if(rol === "superadmin") return "Super usuario";
  if(rol === "admin") return "Administrador";
  return "Operador/despachador";
}
function rolBadgeClass(rol){
  if(rol === "superadmin") return "badge-accent";
  if(rol === "admin") return "badge-ok";
  return "badge-neutral";
}
// Una cuenta está "protegida" para el admin que NO es superadmin: no puede
// editarla ni eliminarla (el backend rechaza igual, esto solo evita mostrar
// botones que van a fallar).
const usuarioProtegido = u => (u.rol === "superadmin" || u.rol === "admin") && !isSuperAdmin() && u.id !== currentAdmin.id;

function renderUsuarios(){
  if(!isFullAdmin()){
    // Defensa extra en el front por si alguien fuerza el hash de navegación:
    // el backend igual rechaza estas llamadas con 403 para un operador.
    $("#main").innerHTML = `<div class="empty-state"><div class="big">🔒</div>No tienes permisos para ver esta sección.</div>`;
    return;
  }
  $("#main").innerHTML = `
    <div class="topbar">
      <div><span class="eyebrow">Configuración</span><h1>👤 Usuarios y roles</h1></div>
      <button class="btn btn-accent" id="btnAddUsuario">+ Nuevo usuario</button>
    </div>
    <p style="color:var(--ink-soft); max-width:680px; margin-bottom:18px;">
      <b>Super usuario</b>: acceso total y exclusivo — es la única cuenta que puede crear/editar/eliminar Administradores u otros Super usuarios, y la única que puede ejecutar el borrado total del sistema.
      <b>Administrador</b>: acceso total al día a día (todos los módulos, catálogos, usuarios operador) y a la restauración de respaldos, pero no puede tocar cuentas de Administrador ni de Super usuario.
      <b>Operador/despachador</b>: gestiona fletes, rutas, flota, conductores e incidencias del día a día, pero no ve esta sección.
    </p>
    <div id="usuariosWrap"><div class="empty-state"><div class="big">⏳</div>Cargando usuarios…</div></div>
  `;
  $("#btnAddUsuario").addEventListener("click", () => openUsuarioForm(null));
  loadUsuarios();
}

async function loadUsuarios(){
  const { data, error } = await apiFetch("usuarios/list.php");
  const wrap = $("#usuariosWrap");
  if(!wrap) return; // el usuario ya navegó a otra sección
  if(error){ wrap.innerHTML = `<div class="empty-state"><div class="big">⚠️</div>No se pudo cargar la lista de usuarios.</div>`; return; }
  const rows = data.rows || [];
  if(!rows.length){ wrap.innerHTML = `<div class="empty-state"><div class="big">👤</div>Sin usuarios registrados.</div>`; return; }
  wrap.innerHTML = `<table><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th></th></tr></thead><tbody>
    ${rows.map(u => {
      const protegido = usuarioProtegido(u);
      const esUnoMismo = u.id === currentAdmin.id;
      return `
      <tr>
        <td>${esc(u.nombre)}</td>
        <td>${esc(u.email)}</td>
        <td><span class="badge ${rolBadgeClass(u.rol)}">${rolLabelUsuario(u.rol)}</span></td>
        <td class="actions"><div class="row-actions">
          ${protegido
            ? `<span class="badge badge-neutral" title="Solo el Super Usuario puede modificar esta cuenta">🔒</span>`
            : `<button class="icon-btn" data-edit-usuario="${u.id}" title="Editar">✎</button>
               ${esUnoMismo ? "" : `<button class="icon-btn danger" data-del-usuario="${u.id}" title="Eliminar">✕</button>`}`}
        </div></td>
      </tr>`;
    }).join("")}
  </tbody></table>`;
  $$('[data-edit-usuario]', wrap).forEach(b => b.addEventListener('click', () => openUsuarioForm(rows.find(u => String(u.id) === b.dataset.editUsuario))));
  $$('[data-del-usuario]', wrap).forEach(b => b.addEventListener('click', () => confirmDeleteUsuario(rows.find(u => String(u.id) === b.dataset.delUsuario))));
}

function openUsuarioForm(existing){
  if(existing && usuarioProtegido(existing)){ toast("Solo el Super Usuario puede modificar esta cuenta."); return; }
  const rolActual = existing ? existing.rol : "operador";
  $("#modalRoot").innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal" style="max-width:440px">
        <div class="modal-head"><h3>${existing ? "Editar usuario" : "Nuevo usuario"}</h3><button class="modal-close" id="modalClose">✕</button></div>
        <div class="modal-body">
          <div class="field"><label>Nombre</label><input id="uNombre" value="${existing ? esc(existing.nombre) : ""}" required></div>
          <div class="field"><label>Correo</label><input id="uEmail" type="email" value="${existing ? esc(existing.email) : ""}" required></div>
          <div class="field">
            <label>Rol</label>
            <select id="uRol">
              <option value="operador" ${rolActual==='operador' ? "selected":""}>Operador / despachador</option>
              ${(isSuperAdmin() || rolActual==='admin') ? `<option value="admin" ${rolActual==='admin' ? "selected":""}>Administrador</option>` : ""}
              ${isSuperAdmin() ? `<option value="superadmin" ${rolActual==='superadmin' ? "selected":""}>Super usuario</option>` : ""}
            </select>
            ${!isSuperAdmin() ? `<small class="hint">Solo el Super Usuario puede asignar el rol Administrador o Super usuario.</small>` : ""}
          </div>
          <div class="field">
            <label>${existing ? "Nueva contraseña (dejar en blanco para no cambiarla)" : "Contraseña"}</label>
            <input id="uPassword" type="password" autocomplete="new-password">
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="btnCancel">Cancelar</button>
          <button class="btn btn-accent" id="btnSaveUsuario">Guardar</button>
        </div>
      </div>
    </div>`;
  $("#modalClose").addEventListener("click", closeModal);
  $("#btnCancel").addEventListener("click", closeModal);
  $("#overlay").addEventListener("click", e => { if(e.target.id === "overlay") closeModal(); });
  $("#btnSaveUsuario").addEventListener("click", async () => {
    const payload = {
      id: existing ? existing.id : undefined,
      nombre: $("#uNombre").value.trim(),
      email: $("#uEmail").value.trim(),
      rol: $("#uRol").value,
      password: $("#uPassword").value,
    };
    if(!payload.nombre || !payload.email){ toast("Faltan el nombre o el correo"); return; }
    if(!existing && !payload.password){ toast("Debes definir una contraseña"); return; }
    const btn = $("#btnSaveUsuario");
    btn.disabled = true;
    const { error } = await apiFetch("usuarios/save.php", { method: "POST", body: payload });
    btn.disabled = false;
    if(error){ toast(error); return; }
    closeModal();
    toast(existing ? "Usuario actualizado" : "Usuario creado");
    loadUsuarios();
  });
}

function confirmDeleteUsuario(u){
  if(!u) return;
  if(usuarioProtegido(u)){ toast("Solo el Super Usuario puede eliminar esa cuenta."); return; }
  $("#modalRoot").innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal" style="max-width:420px">
        <div class="modal-head"><h3>Eliminar usuario</h3><button class="modal-close" id="modalClose">✕</button></div>
        <div class="modal-body"><p>¿Eliminar a <b>${esc(u.nombre)}</b> (${esc(u.email)})? Perderá acceso al panel de inmediato.</p></div>
        <div class="modal-foot">
          <button class="btn" id="btnCancel">Cancelar</button>
          <button class="btn btn-danger" id="btnConfirmDel">Sí, eliminar</button>
        </div>
      </div>
    </div>`;
  $("#modalClose").addEventListener("click", closeModal);
  $("#btnCancel").addEventListener("click", closeModal);
  $("#overlay").addEventListener("click", e => { if(e.target.id === "overlay") closeModal(); });
  $("#btnConfirmDel").addEventListener("click", async () => {
    const { error } = await apiFetch("usuarios/delete.php", { method: "POST", body: { id: u.id } });
    closeModal();
    if(error){ toast(error); return; }
    toast("Usuario eliminado");
    loadUsuarios();
  });
}

/* ==========================================================================
   NOTIFICACIONES — campanita del sidebar
   ========================================================================== */
function fmtNotifTime(iso){
  if(!iso) return "";
  const d = new Date(iso.replace(" ", "T"));
  if(isNaN(d)) return "";
  const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
  if(diffMin < 1) return "recién";
  if(diffMin < 60) return `hace ${diffMin} min`;
  const diffH = Math.round(diffMin/60);
  if(diffH < 24) return `hace ${diffH} h`;
  return d.toLocaleDateString("es-CL", { day:"2-digit", month:"2-digit" });
}

async function loadNotifications(){
  const { data, error } = await apiFetch("notificaciones/list.php");
  if(error) return;
  notifState.rows = data.rows || [];
  notifState.noLeidas = data.no_leidas || 0;
  renderNotifBell();
}

function renderNotifBell(){
  const badge = $("#notifBadge");
  if(!badge) return;
  if(notifState.noLeidas > 0){
    badge.hidden = false;
    badge.textContent = notifState.noLeidas > 9 ? "9+" : String(notifState.noLeidas);
  } else {
    badge.hidden = true;
  }
  const panel = $("#notifPanel");
  if(panel && !panel.hidden) renderNotifPanel();
}

function renderNotifPanel(){
  const panel = $("#notifPanel");
  if(!panel) return;
  if(!notifState.rows.length){
    panel.innerHTML = `<div class="notif-panel-empty">Sin notificaciones todavía.</div>`;
    return;
  }
  panel.innerHTML = notifState.rows.map(n => `
    <div class="notif-item ${n.leida ? "" : "unread"}">
      <span class="notif-msg">${esc(n.mensaje)}</span>
      <span class="notif-time">${fmtNotifTime(n.fecha_creacion)}</span>
    </div>`).join("");
}

/**
 * Calcula top/left en px para que el panel (position:fixed, ver css) quede
 * siempre completo dentro de la pantalla, sin importar el ancho de la
 * sidebar ni el tamaño del dispositivo. Se recalcula cada vez que se abre
 * y también en resize mientras está abierto (por si el usuario gira el
 * celular o cambia el tamaño de la ventana).
 */
function positionNotifPanel(btn, panel){
  const margin = 10;
  const btnRect = btn.getBoundingClientRect();
  const panelWidth = panel.offsetWidth || 320;
  // Se ancla por el borde izquierdo de la campanita, así el panel se abre
  // hacia la derecha (hacia el contenido principal) en vez de hacia la
  // izquierda, que es donde termina la pantalla.
  let left = btnRect.left;
  left = Math.max(margin, Math.min(left, window.innerWidth - panelWidth - margin));
  let top = btnRect.bottom + 8;
  const maxTop = window.innerHeight - margin - 60; // deja algo de aire abajo
  top = Math.min(top, maxTop);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function initNotifBell(){
  const btn = $("#btnNotifBell");
  const panel = $("#notifPanel");
  if(!btn || !panel) return;
  // La sidebar usa position:sticky, lo que crea su propio contexto de
  // apilamiento y "atrapa" a sus descendientes — incluido este panel,
  // aunque sea position:fixed con z-index alto. El contenido de .main
  // (tarjetas KPI, etc.), al no estar contenido en ese contexto, termina
  // pintándose por encima. Moviendo el panel a document.body, queda fuera
  // de la sidebar y se pinta siempre por encima de todo el contenido.
  document.body.appendChild(panel);
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const opening = panel.hidden;
    panel.hidden = !panel.hidden;
    if(opening){
      renderNotifPanel();
      positionNotifPanel(btn, panel);
      if(notifState.noLeidas > 0){
        await apiFetch("notificaciones/marcar_leidas.php", { method: "POST" });
        notifState.rows.forEach(n => n.leida = true);
        notifState.noLeidas = 0;
        renderNotifBell();
      }
    }
  });
  document.addEventListener("click", (e) => {
    if(!panel.hidden && !panel.contains(e.target) && e.target !== btn) panel.hidden = true;
  });
  window.addEventListener("resize", () => {
    if(!panel.hidden) positionNotifPanel(btn, panel);
  });
}


/* ==========================================================================
   EXPORTAR / IMPORTAR — múltiples formatos de archivo
   Formatos de salida: JSON, CSV, Excel (.xlsx)
   Formatos de entrada aceptados: JSON, CSV, Excel (.xlsx/.xls/.xlsm), OpenDocument (.ods)
   (no se aceptan imágenes ni archivos de texto plano, según lo solicitado)
   ========================================================================== */

function downloadBlob(content, filename, mime){
  const blob = content instanceof Blob ? content : new Blob([content], {type:mime});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  toast("Archivo descargado");
}

function fullBackupPayload(){
  return { data: DB, catalogos: CAT, exportedAt: new Date().toISOString() };
}

/* ---- utilidades CSV ---- */
function csvEscape(v){
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
}
function exportCellValue(c, r){
  const v = r[c.key];
  if(c.kind === "image" || c.kind === "file") return v ? "Adjunta (ver en la app)" : "—";
  if(c.money) return Number(v) || 0;
  return v ?? "";
}

/* Arma las filas (encabezado + datos + fila TOTAL si corresponde) que
   comparten el export a CSV y el export a Excel, para que ambos formatos
   muestren siempre lo mismo. Si "columns" trae una o más columnas con
   money:true (Valor Flete, Importe, Costo Total, etc.), se agrega una fila
   final "TOTAL" con la suma de cada una de esas columnas — no hace falta
   indicar cuál sumar a mano, cualquier columna de dinero se suma sola. */
function exportAOA(columns, rows){
  const headers = ["Nro", ...columns.map(c=>c.label)];
  const data = rows.map(r => [r.nro, ...columns.map(c => exportCellValue(c, r))]);
  const hayColumnasDeDinero = columns.some(c => c.money);
  const totalsRow = hayColumnasDeDinero
    ? ["TOTAL", ...columns.map(c => c.money ? rows.reduce((a,r)=> a + (Number(r[c.key])||0), 0) : "")]
    : null;
  return { headers, data, totalsRow };
}

function rowsToCSV(columns, rows){
  const { headers, data, totalsRow } = exportAOA(columns, rows);
  const lines = [headers.map(csvEscape).join(",")];
  data.forEach(row => lines.push(row.map(csvEscape).join(",")));
  if(totalsRow) lines.push(totalsRow.map(csvEscape).join(","));
  return lines.join("\r\n");
}
function parseCSV(text){
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for(let i=0;i<text.length;i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){ if(text[i+1] === '"'){ field += '"'; i++; } else { inQuotes = false; } }
      else field += c;
    } else {
      if(c === '"') inQuotes = true;
      else if(c === ","){ row.push(field); field = ""; }
      else if(c === "\n"){ row.push(field); rows.push(row); row = []; field = ""; }
      else if(c === "\r"){ /* ignorar */ }
      else field += c;
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}

/* ==========================================================================
   EXCEL — estilos y construcción de hojas
   La librería cargada en index.html es "xlsx-js-style" (un fork de SheetJS
   que sí permite escribir estilos de celda — la SheetJS gratuita estándar
   solo permite LEER estilos, no escribirlos). Todas las hojas .xlsx que
   genera la app pasan por buildStyledSheet(), para que se vean consistentes:
   encabezado en negrita con fondo oscuro, columnas de dinero en formato $,
   bordes suaves, autofiltro, encabezado congelado al hacer scroll, columnas
   con ancho ajustado al contenido, y fila TOTAL en negrita cuando hay
   columnas de dinero.
   ========================================================================== */
const XLS_COLOR = { headerBg:"FF1E3A5F", headerText:"FFFFFFFF", totalBg:"FFEAF0F7", border:"FFD7DEE6" };
const XLS_BORDER_THIN = (() => {
  const side = { style:"thin", color:{ rgb: XLS_COLOR.border } };
  return { top:side, bottom:side, left:side, right:side };
})();
const XLS_STYLE = {
  header: {
    font: { bold:true, color:{ rgb: XLS_COLOR.headerText }, sz:11 },
    fill: { patternType:"solid", fgColor:{ rgb: XLS_COLOR.headerBg } },
    alignment: { vertical:"center", horizontal:"center", wrapText:true },
    border: XLS_BORDER_THIN,
  },
  cellText:   { alignment:{ vertical:"center", horizontal:"left"  }, border: XLS_BORDER_THIN },
  cellNumber: { alignment:{ vertical:"center", horizontal:"right" }, border: XLS_BORDER_THIN },
  total: {
    font: { bold:true },
    fill: { patternType:"solid", fgColor:{ rgb: XLS_COLOR.totalBg } },
    border: { top:{ style:"medium", color:{ rgb: XLS_COLOR.headerBg } } },
  },
};
const XLS_MONEY_FMT = '"$"\\ #,##0';

function xlsSetStyle(ws, r, c, style, numFmt){
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws[addr];
  if(!cell) return;
  cell.s = style;
  if(numFmt) cell.z = numFmt;
}

function xlsAutoColWidths(ws, aoa){
  const ncols = aoa.reduce((m,row)=>Math.max(m,row.length), 0);
  ws['!cols'] = Array.from({length: ncols}, (_, c) => {
    let maxLen = 8;
    aoa.forEach(row => { maxLen = Math.max(maxLen, String(row[c] ?? "").length); });
    return { wch: Math.min(Math.max(maxLen + 2, 10), 42) };
  });
}

/* columns: [{label, key, kind, money}] — el mismo formato que cfg.columns.
   rows: filas ya "planas" (con los campos calculados incluidos). */
function buildStyledSheet(columns, rows){
  const { headers, data, totalsRow } = exportAOA(columns, rows);
  const aoa = totalsRow ? [headers, ...data, totalsRow] : [headers, ...data];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const ncols = headers.length;
  const dataRowCount = data.length;

  for(let c = 0; c < ncols; c++) xlsSetStyle(ws, 0, c, XLS_STYLE.header);

  for(let r = 1; r <= dataRowCount; r++){
    for(let c = 0; c < ncols; c++){
      const colDef = c === 0 ? null : columns[c - 1];
      const isMoney = !!(colDef && colDef.money);
      xlsSetStyle(ws, r, c, isMoney ? XLS_STYLE.cellNumber : XLS_STYLE.cellText, isMoney ? XLS_MONEY_FMT : null);
    }
  }

  if(totalsRow){
    const r = dataRowCount + 1;
    for(let c = 0; c < ncols; c++){
      const colDef = c === 0 ? null : columns[c - 1];
      const isMoney = !!(colDef && colDef.money);
      xlsSetStyle(ws, r, c, XLS_STYLE.total, isMoney ? XLS_MONEY_FMT : null);
    }
  }

  xlsAutoColWidths(ws, aoa);
  ws['!freeze'] = { xSplit:0, ySplit:1, topLeftCell:"A2", activePane:"bottomLeft", state:"frozen" };
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s:{r:0,c:0}, e:{r:dataRowCount, c:ncols-1} }) };

  return ws;
}

/* Para hojas que no son tabulares por columnas (Resumen, Actividad,
   Papelera): recibe el AOA ya armado y solo le da encabezado en negrita
   (en la fila indicada) y columnas con ancho ajustado. */
function buildSimpleSheet(aoa, headerRowIndex){
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if(headerRowIndex !== undefined && aoa[headerRowIndex]){
    aoa[headerRowIndex].forEach((_, c) => xlsSetStyle(ws, headerRowIndex, c, XLS_STYLE.header));
  }
  xlsAutoColWidths(ws, aoa);
  return ws;
}

function rowsWithComputed(moduleKey){
  const cfg = MODULES[moduleKey];
  return DB[moduleKey].map(r => ({...r, ...(cfg.computeFn ? cfg.computeFn(r) : {})}));
}

/* ---- exportar ---- */
function doExport(moduleKey, format, rows){
  if(typeof XLSX === "undefined" && format === "xlsx"){
    toast("No se pudo cargar el motor de Excel (revisa tu conexión a internet)");
    return;
  }
  if(!moduleKey){
    // Alcance: todo el sistema (el backup completo siempre incluye TODOS los
    // registros de cada módulo, sin importar filtros aplicados en pantalla).
    if(format === "json"){
      downloadBlob(JSON.stringify(fullBackupPayload(), null, 2), `flota-completo-${todayISO()}.json`, "application/json");
    } else if(format === "xlsx"){
      const wb = XLSX.utils.book_new();

      // Hoja 1: Resumen general del día
      const segCalc = DB.seguros.map(r=>({...r, ...computeSeguro(r)}));
      const porVencer = segCalc.filter(r=>r.estadoPoliza==="Por vencer" || r.estadoPoliza==="Vencido").length;
      const multasCalc = DB.multas.map(r=>({...r, ...computeMulta(r)}));
      const deuda = multasCalc.filter(r=>r.estadoPago==="Debe").reduce((a,r)=>a+r.debe,0);
      const rutasCalc = DB.rutas.map(r=>({...r, ...computeRuta(r)}));
      const ingresoTotal = rutasCalc.reduce((a,r)=>a+r.ingresoTotal,0);
      const resumenAOA = [
        ["Control de Flota Vehicular — Resumen"],
        ["Generado el", fmtDateTime(new Date().toISOString())],
        [],
        ["Indicador", "Valor"],
        ["Vehículos en flota", DB.flota.length],
        ["Vehículos disponibles", DB.flota.filter(r=>r.estado==="Disponible").length],
        ["Seguros por vencer o vencidos", porVencer],
        ["Multas por pagar ($)", deuda],
        ["Viajes registrados", DB.rutas.length],
        ["Ingreso total de rutas ($)", ingresoTotal],
        ["Conductores registrados", DB.conductores.length],
        ["Talleres registrados", DB.talleres.length],
        ["Registros en la papelera", trashCount()],
        ["Eventos en el registro de actividad", LOG.length],
      ];
      XLSX.utils.book_append_sheet(wb, buildSimpleSheet(resumenAOA, 3), "Resumen");

      // Una hoja por módulo, con estilo (encabezado, autofiltro, fila TOTAL
      // en las columnas de dinero, ancho de columna ajustado).
      MODULE_ORDER.forEach(key=>{
        const cfg = MODULES[key];
        const ws = buildStyledSheet(cfg.columns, rowsWithComputed(key));
        XLSX.utils.book_append_sheet(wb, ws, cfg.label.slice(0,31));
      });

      // Actividad del día
      const todaysLog = LOG.filter(e => e.ts.slice(0,10) === todayISO());
      const logAOA = [["Hora","Módulo","Acción","Detalle"], ...todaysLog.map(e => [
        fmtTime(e.ts), MODULES[e.moduleKey] ? MODULES[e.moduleKey].label : e.moduleKey, ACTION_LABELS[e.action] || e.action, e.summary || `#${e.nro}`
      ])];
      XLSX.utils.book_append_sheet(wb, buildSimpleSheet(logAOA, 0), "Actividad de hoy");

      // Papelera actual
      const trashAOA = [["Módulo","Nro","Detalle","Eliminado el"]];
      MODULE_ORDER.forEach(key=>{
        (TRASH[key]||[]).forEach(item=>{
          trashAOA.push([MODULES[key].label, item.nro, MODULES[key].summary ? MODULES[key].summary(item) : "", fmtDateTime(item._deletedAt)]);
        });
      });
      XLSX.utils.book_append_sheet(wb, buildSimpleSheet(trashAOA, 0), "Papelera");

      XLSX.writeFile(wb, `flota-completo-${todayISO()}.xlsx`);
      toast("Archivo Excel descargado");
    }
    return;
  }

  const cfg = MODULES[moduleKey];
  // "rows" son las filas actualmente visibles en pantalla (con buscador y
  // filtros aplicados). Si no se pasan explícitamente, se exporta todo el
  // módulo — así queda un valor por defecto razonable para quien llame a
  // doExport() sin pasar filas.
  const exportRows = rows || rowsWithComputed(moduleKey);
  if(format === "json"){
    downloadBlob(JSON.stringify(exportRows, null, 2), `${moduleKey}-${todayISO()}.json`, "application/json");
  } else if(format === "csv"){
    downloadBlob(rowsToCSV(cfg.columns, exportRows), `${moduleKey}-${todayISO()}.csv`, "text/csv;charset=utf-8");
  } else if(format === "xlsx"){
    const wb = XLSX.utils.book_new();
    const ws = buildStyledSheet(cfg.columns, exportRows);
    XLSX.utils.book_append_sheet(wb, ws, cfg.label.slice(0,31));
    XLSX.writeFile(wb, `${moduleKey}-${todayISO()}.xlsx`);
    toast("Archivo Excel descargado");
  }
}

function openExportModal(moduleKey, rows){
  const isAll = !moduleKey;
  const cfg = isAll ? null : MODULES[moduleKey];
  const formats = isAll
    ? [ {v:"json", l:"JSON — respaldo completo (recomendado)"}, {v:"xlsx", l:"Excel (.xlsx) — una hoja por módulo"} ]
    : [ {v:"xlsx", l:"Excel (.xlsx)"}, {v:"csv", l:"CSV"}, {v:"json", l:"JSON"} ];

  const totalRows = isAll ? 0 : DB[moduleKey].length;
  const filtroActivo = !isAll && rows && rows.length !== totalRows;

  $("#modalRoot").innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal" style="max-width:460px">
        <div class="modal-head"><h3>Exportar ${isAll ? "todo el sistema" : esc(cfg.label)}</h3><button class="modal-close" id="modalClose">✕</button></div>
        <div class="modal-body">
          <div class="form-field">
            <label>Formato de archivo</label>
            <select id="exportFormat">${formats.map(f=>`<option value="${f.v}">${esc(f.l)}</option>`).join("")}</select>
          </div>
          <p style="color:var(--ink-soft); font-size:12.5px; margin-top:14px;">
            ${isAll
              ? "El JSON completo incluye todos los módulos y catálogos, listo para restaurar tal cual. El Excel es un reporte detallado: resumen del día, una hoja por módulo, la actividad de hoy y la papelera."
              : (filtroActivo
                  ? `Se exportarán los <b>${rows.length}</b> registros que coinciden con el buscador/filtros actuales (de ${totalRows} en total), incluyendo los campos calculados. Las fotos se indican como "Adjunta" (se conservan dentro de la app).`
                  : "Se exportarán los registros actuales de este módulo, incluyendo los campos calculados automáticamente. Las fotos se indican como \"Adjunta\" (se conservan dentro de la app).")}
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn" id="btnCancel">Cancelar</button>
          <button class="btn btn-accent" id="btnDoExport">⭳ Descargar</button>
        </div>
      </div>
    </div>`;
  $("#modalClose").addEventListener("click", closeModal);
  $("#btnCancel").addEventListener("click", closeModal);
  $("#overlay").addEventListener("click", e => { if(e.target.id === "overlay") closeModal(); });
  $("#btnDoExport").addEventListener("click", () => {
    doExport(moduleKey, $("#exportFormat").value, rows);
    closeModal();
  });
}

/* ---- importar ---- */
function normalizeHeader(s){ return String(s ?? "").trim().toLowerCase(); }

function buildFieldLookup(cfg){
  const map = {};
  cfg.columns.filter(c => c.kind !== "computed").forEach(c => {
    map[normalizeHeader(c.key)] = c.key;
    map[normalizeHeader(c.label)] = c.key;
    (c.aliases || []).forEach(a => { map[normalizeHeader(a)] = c.key; });
  });
  return map;
}

function coerceValue(col, raw){
  if(raw === undefined || raw === null) return "";
  let v = raw;
  if(col.kind === "number"){
    v = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
    if(isNaN(v)) v = "";
  } else if(col.kind === "date"){
    if(v instanceof Date){ v = v.toISOString().slice(0,10); }
    else {
      const s = String(v).trim();
      const d = new Date(s);
      // Antes, si el texto no se podía interpretar como fecha (por ejemplo
      // alguien escribió "Realizado" en la celda en vez de una fecha), acá
      // se guardaba el texto crudo tal cual (v = s). Ese texto después se
      // mandaba directo a una columna "date" de Postgres, que lo rechazaba
      // con el error 22007 ("invalid input syntax for type date") y
      // frenaba TODO el lote de guardado. Ahora, si no es una fecha válida,
      // queda vacío en vez de un texto que la base de datos va a rechazar.
      v = isNaN(d.getTime()) ? "" : d.toISOString().slice(0,10);
    }
  } else if(col.kind === "image"){
    v = (typeof v === "string" && v.startsWith("data:image")) ? v : "";
  } else if(col.kind === "file"){
    v = (typeof v === "string" && v.startsWith("data:")) ? v : "";
  } else {
    v = String(v).trim();
    if(col.uppercase) v = v.toUpperCase();
  }
  return v;
}

/* Campos que se usan para decidir si dos registros son "el mismo flete".
   Si el módulo define cfg.dedupeFields se usan esos; si no, se usan todos
   los campos importables (sin contar calculados ni fotos). */
function moduleDedupeFields(cfg){
  if(cfg.dedupeFields) return cfg.dedupeFields;
  return cfg.columns.filter(c => c.kind !== "computed" && c.kind !== "image" && c.kind !== "file").map(c => c.key);
}
function rowSignature(cfg, row){
  return moduleDedupeFields(cfg).map(k => normalizeHeader(row[k])).join("§");
}

async function importObjectsIntoModule(moduleKey, objects, defaults={}){
  const cfg = MODULES[moduleKey];
  const lookup = buildFieldLookup(cfg);
  // Firma de todo lo que ya existe en el módulo, para no duplicar fletes
  // que coincidan con uno ya cargado (de este archivo o de una importación
  // anterior). Se va actualizando a medida que se agregan filas nuevas,
  // así tampoco se duplican dos filas iguales dentro del mismo archivo.
  const seen = new Set(DB[moduleKey].map(r => rowSignature(cfg, r)));
  let added = 0, skipped = 0, duplicated = 0;
  // El contador de nro arranca del máximo real en la base de datos (no solo
  // de lo que esta pestaña tiene cargado), igual que nextNroSafe, pero se
  // consulta UNA sola vez y después se incrementa en memoria para no hacer
  // una consulta de red por cada una de las 500+ filas del import.
  let nextNroCounter = null;
  for(const obj of objects){
    const row = {};
    Object.keys(obj).forEach(h => {
      const key = lookup[normalizeHeader(h)];
      if(key){
        const col = cfg.columns.find(c => c.key === key);
        row[key] = coerceValue(col, obj[h]);
      }
    });
    Object.entries(defaults).forEach(([k,v]) => {
      if(!row[k]){
        const col = cfg.columns.find(c => c.key === k);
        row[k] = (col && col.uppercase && typeof v === "string") ? v.toUpperCase() : v;
      }
    });
    const missingRequired = cfg.columns.some(c => c.required && c.kind !== "computed" && (row[c.key] === undefined || row[c.key] === ""));
    if(missingRequired || Object.keys(row).length === 0){ skipped++; continue; }
    const sig = rowSignature(cfg, row);
    if(seen.has(sig)){ duplicated++; continue; }
    seen.add(sig);
    if(nextNroCounter === null) nextNroCounter = await nextNroSafe(moduleKey);
    row.nro = nextNroCounter++;
    DB[moduleKey].push(row);
    markDirty(moduleKey, row.nro);
    // Catálogos dinámicos: registra valores nuevos (p. ej. Obra) para que
    // queden disponibles después en el desplegable de sugerencias.
    cfg.columns.forEach(c => {
      if(c.catalogKey && row[c.key]){
        const list = CAT[c.catalogKey] || (CAT[c.catalogKey] = []);
        if(!list.includes(row[c.key])) list.push(row[c.key]);
      }
    });
    added++;
  }
  if(added) persistCat();
  return { added, skipped, duplicated };
}

/* Conjunto de todos los encabezados conocidos (nombre de columna + label +
   alias) de todos los módulos, en minúsculas. Sirve para reconocer en qué
   fila de la hoja está realmente el encabezado de la tabla, sin asumir que
   es la fila 1: algunos Excel traen membrete/título/logo en las primeras
   filas (p. ej. "TRANSPORTE ... Rut ...") y la tabla empieza más abajo. */
function buildKnownHeaderSet(){
  const set = new Set();
  MODULE_ORDER.forEach(k => {
    MODULES[k].columns.filter(c => c.kind !== "computed").forEach(c => {
      set.add(normalizeHeader(c.key));
      set.add(normalizeHeader(c.label));
      (c.aliases || []).forEach(a => set.add(normalizeHeader(a)));
    });
  });
  return set;
}
const KNOWN_HEADERS = buildKnownHeaderSet();

function detectHeaderRowIndex(rawRows, knownHeaders, maxScan=20){
  let best = 0, bestScore = -1;
  const limit = Math.min(maxScan, rawRows.length);
  for(let i=0; i<limit; i++){
    const row = rawRows[i] || [];
    const score = row.filter(cell => knownHeaders.has(normalizeHeader(cell))).length;
    if(score > bestScore){ bestScore = score; best = i; }
  }
  // Si ninguna fila tuvo al menos 2 coincidencias con encabezados conocidos,
  // se asume que el archivo ya viene "limpio" y la fila 1 es el encabezado
  // (comportamiento anterior, para no romper archivos ya usados hoy).
  return bestScore >= 2 ? best : 0;
}

/* Convierte una hoja/archivo ya leído como filas crudas (array de arrays,
   como delvuelve Excel con {header:1} o un CSV parseado) en objetos
   {encabezado: valor}, saltando cualquier fila de título/membrete antes
   del encabezado real y las filas totalmente vacías (p. ej. totales al
   final del archivo). */
function rawRowsToObjects(rawRows){
  const headerIdx = detectHeaderRowIndex(rawRows, KNOWN_HEADERS);
  const headers = (rawRows[headerIdx] || []).map(h => String(h ?? "").trim());
  const objects = [];
  for(let i = headerIdx + 1; i < rawRows.length; i++){
    const r = rawRows[i] || [];
    const hasData = r.some(cell => String(cell ?? "").trim() !== "");
    if(!hasData) continue;
    const o = {};
    headers.forEach((h, idx) => { if(h) o[h] = r[idx]; });
    objects.push(o);
  }
  return objects;
}

function readFileAsData(file){
  const ext = file.name.split(".").pop().toLowerCase();
  return new Promise((resolve, reject) => {
    if(["png","jpg","jpeg","gif","webp","svg","bmp","txt"].includes(ext)){
      reject(new Error("Formato no admitido. No se aceptan imágenes ni archivos de texto plano (.txt)."));
      return;
    }
    if(ext === "json"){
      const reader = new FileReader();
      reader.onload = () => { try{ resolve({type:"json", payload: JSON.parse(reader.result)}); } catch(e){ reject(e); } };
      reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
      reader.readAsText(file);
    } else if(ext === "csv"){
      const reader = new FileReader();
      reader.onload = () => {
        const rows = parseCSV(reader.result);
        const sheetName = file.name.replace(/\.[^.]+$/, "") || "CSV";
        resolve({type:"sheets", sheets:{ [sheetName]: rawRowsToObjects(rows) }});
      };
      reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
      reader.readAsText(file);
    } else if(["xlsx","xls","xlsm","ods"].includes(ext)){
      if(typeof XLSX === "undefined"){ reject(new Error("No se pudo cargar el motor de Excel (revisa tu conexión a internet)")); return; }
      const reader = new FileReader();
      reader.onload = () => {
        try{
          const wb = XLSX.read(new Uint8Array(reader.result), {type:"array", cellDates:true});
          const sheets = {};
          wb.SheetNames.forEach(name => {
            const raw = XLSX.utils.sheet_to_json(wb.Sheets[name], {header:1, defval:""});
            sheets[name] = rawRowsToObjects(raw);
          });
          resolve({type:"sheets", sheets});
        }catch(e){ reject(e); }
      };
      reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
      reader.readAsArrayBuffer(file);
    } else {
      reject(new Error(`Formato de archivo no soportado: .${ext}`));
    }
  });
}

/* Procesa UN archivo y devuelve un resumen {added, skipped, duplicated,
   backup}. No muestra toast ni cierra el modal — eso lo hace quien la
   llama, una sola vez, después de procesar todos los archivos elegidos
   (ver runImport), para poder importar varios archivos en una sola
   operación y acumular sus totales correctamente. */
async function handleImportFile(file, targetModule){
  const result = await readFileAsData(file);

  if(result.type === "json"){
    const payload = result.payload;
    if(payload && payload.data && payload.catalogos){
      // Restaurar un respaldo completo reemplaza TODA la base de datos —
      // igual de irreversible que el borrado total, así que queda
      // reservado exclusivamente al Super Usuario. El backend no valida
      // esto por sí mismo (llega como una serie de guardados/borrados
      // normales por tabla), así que el freno principal está acá.
      if(!isSuperAdmin()){
        throw new Error("Solo el Super Usuario puede restaurar un respaldo completo.");
      }
      await restoreFullBackup(payload);
      return { added:0, skipped:0, duplicated:0, backup:true };
    }
    if(Array.isArray(payload)){
      if(!targetModule) throw new Error(`Elige un módulo destino para "${file.name}"`);
      const { added, skipped, duplicated } = await importObjectsIntoModule(targetModule, payload);
      await persistDB();
      return { added, skipped, duplicated };
    }
    throw new Error(`"${file.name}" no tiene un formato JSON reconocido`);
  }

  // CSV / Excel / ODS → objetos agrupados por hoja
  const sheetNames = Object.keys(result.sheets);
  if(!targetModule){
    let totalAdded = 0, totalSkipped = 0, totalDup = 0, matchedAny = false;
    for(const sn of sheetNames){
      const modKey = MODULE_ORDER.find(k => normalizeHeader(MODULES[k].label) === normalizeHeader(sn) || normalizeHeader(k) === normalizeHeader(sn));
      if(modKey){
        matchedAny = true;
        const { added, skipped, duplicated } = await importObjectsIntoModule(modKey, result.sheets[sn]);
        totalAdded += added; totalSkipped += skipped; totalDup += duplicated;
      }
    }
    if(!matchedAny) throw new Error(`No se reconoció ningún módulo en las hojas de "${file.name}". Elige un módulo destino.`);
    await persistDB();
    return { added: totalAdded, skipped: totalSkipped, duplicated: totalDup };
  }

  const cfg = MODULES[targetModule];
  if(cfg.sheetAsField){
    // Cada hoja del archivo se importa como registros separados, usando el nombre
    // de la hoja como valor del campo indicado (p. ej. "obra" en Fletes), salvo
    // que la fila ya traiga ese dato (p. ej. una columna "Obra" con datos reales).
    let totalAdded = 0, totalSkipped = 0, totalDup = 0;
    for(const sn of sheetNames){
      const { added, skipped, duplicated } = await importObjectsIntoModule(targetModule, result.sheets[sn], { [cfg.sheetAsField]: sn });
      totalAdded += added; totalSkipped += skipped; totalDup += duplicated;
    }
    await persistDB();
    return { added: totalAdded, skipped: totalSkipped, duplicated: totalDup };
  }

  const data = result.sheets[sheetNames[0]] || [];
  const { added, skipped, duplicated } = await importObjectsIntoModule(targetModule, data);
  await persistDB();
  return { added, skipped, duplicated };
}

/* Procesa todos los archivos elegidos, uno por uno y en orden (esperando
   a que cada uno termine de guardarse antes de empezar el siguiente), y
   muestra un único resumen al final. Procesarlos en orden —y no todos en
   paralelo— es clave: evita que dos importaciones escriban en Supabase al
   mismo tiempo y una se "coma" los datos de la otra. */
async function runImport(files, targetModule){
  let totals = { added:0, skipped:0, duplicated:0 };
  let backupRestored = false;
  const errors = [];
  for(const file of files){
    try{
      const r = await handleImportFile(file, targetModule);
      if(r.backup) backupRestored = true;
      else { totals.added += r.added; totals.skipped += r.skipped; totals.duplicated += r.duplicated; }
    }catch(err){
      errors.push(err.message || `No se pudo importar "${file.name}"`);
    }
  }
  if(backupRestored){
    toast("Respaldo completo importado correctamente");
  } else {
    const parts = [`${totals.added} registro(s) importado(s)`];
    if(totals.skipped) parts.push(`${totals.skipped} omitido(s) por datos incompletos`);
    if(totals.duplicated) parts.push(`${totals.duplicated} omitido(s) por duplicado`);
    toast(parts.join(", "));
  }
  errors.forEach(msg => toast(msg));
  finishImport();
}

function finishImport(){
  closeModal();
  renderSidebar();
  renderMain();
}

function openImportModal(moduleKey){
  const isAll = !moduleKey;
  $("#modalRoot").innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal" style="max-width:480px">
        <div class="modal-head"><h3>Importar ${isAll ? "datos" : "a " + esc(MODULES[moduleKey].label)}</h3><button class="modal-close" id="modalClose">✕</button></div>
        <div class="modal-body">
          ${isAll ? `
          <div class="form-field span2">
            <label>Módulo destino (solo para archivos CSV/Excel de un único módulo)</label>
            <select id="importTarget">
              <option value="">— Detectar automáticamente (respaldo JSON o Excel con varias hojas) —</option>
              ${MODULE_ORDER.map(k=>`<option value="${k}">${esc(MODULES[k].label)}</option>`).join("")}
            </select>
          </div>` : `<p style="color:var(--ink-soft); font-size:13px;">Los registros del archivo se añadirán como nuevos registros de <b>${esc(MODULES[moduleKey].label)}</b>.${MODULES[moduleKey].sheetAsField ? " Si el Excel tiene varias hojas, cada hoja se importará como una <b>Obra</b> distinta (el nombre de la hoja se usa como Obra)." : ""}</p>`}
          <div class="form-field span2" style="margin-top:12px;">
            <label>Archivo(s)</label>
            <input type="file" id="importFile" accept=".json,.csv,.xlsx,.xls,.xlsm,.ods" multiple>
          </div>
          <p style="color:var(--ink-faint); font-size:11.5px; margin-top:10px;">
            Formatos aceptados: JSON, CSV, Excel (.xlsx, .xls, .xlsm) y OpenDocument (.ods).
            No se aceptan imágenes ni archivos de texto plano (.txt).
            Puedes elegir varios archivos a la vez (se importan uno por uno y se acumulan).
            Si una fila del archivo coincide con un flete que ya existe, se omite en vez de duplicarse.
          </p>
        </div>
        <div class="modal-foot">
          <button class="btn" id="btnCancel">Cancelar</button>
          <button class="btn btn-accent" id="btnDoImport">⭱ Importar</button>
        </div>
      </div>
    </div>`;
  $("#modalClose").addEventListener("click", closeModal);
  $("#btnCancel").addEventListener("click", closeModal);
  $("#overlay").addEventListener("click", e => { if(e.target.id === "overlay") closeModal(); });
  $("#btnDoImport").addEventListener("click", async () => {
    const files = [...$("#importFile").files];
    if(!files.length){ toast("Selecciona al menos un archivo primero"); return; }
    const target = isAll ? ($("#importTarget").value || null) : moduleKey;
    const btn = $("#btnDoImport");
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = files.length > 1 ? `Importando ${files.length} archivos…` : "Importando…";
    try{
      await runImport(files, target);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  });
}

/* ==========================================================================
   LOGIN DE ADMINISTRADOR
   ========================================================================== */
// El panel debe iniciar sesión para poder leer y escribir: cada endpoint de
// api/ llama a require_admin(), que exige una cookie de sesión válida
// vinculada a una fila real de la tabla admin_users (ver api/auth.php).
let _appStarted = false;

function showLoginScreen(errorMsg){
  $("#appRoot").hidden = true;
  $("#loginScreen").hidden = false;
  const errBox = $("#loginError");
  if(errorMsg){
    errBox.textContent = errorMsg;
    errBox.hidden = false;
  } else {
    errBox.hidden = true;
    errBox.textContent = "";
  }
  $("#loginPassword").value = "";
  setTimeout(() => $("#loginEmail").focus(), 30);
}

function hideLoginScreen(){
  $("#loginScreen").hidden = true;
  $("#appRoot").hidden = false;
}

async function startApp(admin){
  if(_appStarted) return; // evita doble init si se llama más de una vez
  _appStarted = true;
  hideLoginScreen();

  currentAdmin = admin || null;
  const email = admin?.email || "";
  const rolLabel = rolLabelUsuario(admin?.rol);
  const sessionLabel = $("#adminSession");
  if(sessionLabel) sessionLabel.textContent = email ? `Sesión: ${email} · ${rolLabel}` : "";

  await loadDB();
  // Antes esta sincronización solo corría dentro del listener realtime de
  // "rutas" (watchRutasRealtime), es decir, únicamente si el panel ya
  // estaba abierto cuando llegaba el cambio. Si un conductor subía sus
  // fotos (inicio o Report) mientras nadie tenía el panel abierto, esas
  // fotos nunca se copiaban a Fletes hasta que esa misma ruta recibiera
  // otro evento en vivo. Se corre también aquí, al cargar, para que el
  // primer render ya refleje el estado real de Fletes.
  await syncClosedRoutesToFletes();
  ensureMobileTopbar();
  renderSidebar();
  renderMain();
  initNotifBell();
  loadNotifications();
  setInterval(loadNotifications, 30000);
  $("#btnLogout").addEventListener("click", async () => {
    await apiFetch("logout.php", { method: "POST" });
    _appStarted = false;
    currentAdmin = null;
    showLoginScreen();
  });
  watchRutasRealtime();
}

function initLoginForm(){
  const form = $("#loginForm");
  const submitBtn = $("#loginSubmit");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#loginEmail").value.trim();
    const password = $("#loginPassword").value;
    submitBtn.disabled = true;
    submitBtn.textContent = "Ingresando…";
    const { data, error } = await apiFetch("login.php", { method: "POST", body: { email, password } });
    submitBtn.disabled = false;
    submitBtn.textContent = "Ingresar";
    if(error){
      showLoginScreen("Email o contraseña incorrectos.");
      return;
    }
    await startApp(data.admin);
  });
}

/* ==========================================================================
   INIT
   ========================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  initLoginForm();

  const { data, error } = await apiFetch("me.php");
  if(!error && data && data.logged_in){
    await startApp(data.admin);
  } else {
    showLoginScreen();
  }
});

/* Espejo en vivo: cuando un conductor crea, edita o borra una ruta desde
   su propia app, esta pestaña recarga la tabla "rutas" y refresca la
   pantalla si corresponde — sin que nadie tenga que apretar F5.
   -----------------------------------------------------------------------
   DIFERENCIA IMPORTANTE respecto a la versión con Supabase: Postgres podía
   avisar en el instante exacto en que algo cambiaba (Realtime). MySQL no
   tiene un equivalente a eso disponible en hosting compartido, así que acá
   se reemplaza por un sondeo periódico: cada POLL_MS se pregunta si algo
   cambió. La demora máxima para ver un cambio de un conductor pasa de
   "casi instantáneo" a "hasta POLL_MS" (30 segundos) — sigue siendo
   automático, solo un poco menos inmediato. */
function watchRutasRealtime(){
  const POLL_MS = 30000;
  let reloading = false;

  async function doReload(){
    if(reloading) return; // ya hay una recarga en curso, se espera al próximo intervalo
    reloading = true;
    try{
      const { data, error } = await fetchAllRows("rutas");
      if(error){ console.error("Error al refrescar rutas", error); return; }
      DB.rutas = data || [];
      await syncClosedRoutesToFletes();
      if(["rutas", "dashboard", "fletes"].includes(currentModule)) refreshModuleData();
    } finally {
      reloading = false;
    }
  }

  setInterval(doReload, POLL_MS);
}

/* Cuando un conductor sube el Report (fotoFin) desde su propia app, la ruta
   queda "cerrada" directamente en la base de datos compartida, sin pasar
   por el formulario del panel. Antes, el espejo en Fletes solo se creaba
   dentro de submitForm/restoreFromTrash (acciones manuales del admin), así
   que una ruta cerrada por el conductor nunca llegaba a Fletes. Aquí se
   detecta, tras cada refresco en vivo de "rutas", cualquier ruta cerrada
   que todavía no tenga su fila espejo (por rutaNro) y se sincroniza igual
   que si el admin la hubiera guardado a mano. */
async function syncClosedRoutesToFletes(){
  let changed = false;
  for(const r of DB.rutas){
    const existingFlete = DB.fletes.find(f => Number(f.rutaNro) === Number(r.nro));
    if(existingFlete){
      // El flete espejo ya existía (por ejemplo, el admin guardó la ruta
      // desde el panel antes de que el conductor subiera sus fotos). Si
      // desde entonces cambió algo que viene de la ruta —típicamente
      // fotoInicio o fotoFin, subidas por el conductor directo a Supabase,
      // sin pasar por submitForm— hay que copiarlo también al flete ya
      // creado; si no, esas fotos se quedan solo en "rutas" y nunca
      // "pasan" a Fletes.
      const data = fleteDataFromRuta(r);
      const huboCambios = Object.keys(data).some(k => existingFlete[k] !== data[k]);
      if(huboCambios){
        await syncFleteFromRuta(r);
        changed = true;
      }
    } else if(r.fotoFin){
      // Ruta recién cerrada (tiene Report) y todavía sin fila espejo: se crea.
      await syncFleteFromRuta(r);
      const flete = DB.fletes.find(f => Number(f.rutaNro) === Number(r.nro));
      if(flete) logActivity("fletes", "create", flete.nro, MODULES.fletes.summary ? MODULES.fletes.summary(flete) : `#${flete.nro}`);
      changed = true;
    }
  }
  if(!changed) return;
  // Ahora esto solo hace upsert de las filas puntuales de fletes que
  // cambiaron acá — nunca vuelve a tocar el resto de las tablas, aunque
  // esta pestaña lleve horas abierta y tenga datos viejos de otros módulos.
  await persistDB({ skipRutas: true });
}