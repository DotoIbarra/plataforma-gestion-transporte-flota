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

/* Cliente Supabase (creado en js/supabase-config.js a partir de SUPABASE_URL / SUPABASE_ANON_KEY) */
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const STORAGE_TABLE = "app_storage"; // catálogos, papelera y log (JSON)

let DB = null;
let CAT = null;
let TRASH = null;
let LOG = null;
let currentModule = "dashboard";
let editing = { module: null, nro: null };

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
  if(moduleKey === "fletes" && row.rutaNro !== undefined && row.rutaNro !== null && row.rutaNro !== ""){
    out.rutaNro = Number(row.rutaNro);
  }
  if(moduleKey === "rutas"){
    // Enlaza la ruta con la cuenta del conductor elegido en el selector,
    // para que le aparezca en su app (RLS filtra "rutas" por este campo).
    out.conductorAuthId = authIdDeConductor(row.conductor);
  }
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

/* Supabase/PostgREST limita cada select a un máximo de filas (1000 por
   defecto). Sin esto, un módulo con más de 1000 registros (ej. un Excel
   grande de fletes) perdería silenciosamente el resto al recargar. */
async function fetchAllRows(table){
  const pageSize = 1000;
  let all = [];
  let from = 0;
  while(true){
    const { data, error } = await supabaseClient
      .from(table).select("*").order("nro", { ascending: true })
      .range(from, from + pageSize - 1);
    if(error) return { data: null, error };
    all = all.concat(data || []);
    if(!data || data.length < pageSize) break;
    from += pageSize;
  }
  return { data: all, error: null };
}

/* Inserta en bloques para no exceder el tamaño máximo de una sola petición
   cuando se sincroniza un módulo con muchos registros (ej. import grande). */
async function insertInChunks(table, rows, chunkSize = 500){
  for(let i = 0; i < rows.length; i += chunkSize){
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabaseClient.from(table).insert(chunk);
    if(error) return error;
  }
  return null;
}

async function syncModuleTable(moduleKey){
  const rows = (DB[moduleKey] || []).map(r => sanitizeRowForDb(moduleKey, r));
  const { error: delErr } = await supabaseClient.from(moduleKey).delete().gte("nro", 0);
  if(delErr){ console.error("Supabase delete error", moduleKey, delErr); toast("Error al guardar " + moduleKey); return; }
  if(rows.length){
    const insErr = await insertInChunks(moduleKey, rows);
    if(insErr){ console.error("Supabase insert error", moduleKey, insErr); toast("Error al guardar " + moduleKey); }
  }
}

/* "rutas" es la única tabla que también escriben los conductores desde su
   propia app (con su sesión, en paralelo al panel web). Por eso NUNCA se
   sincroniza con el patrón "borrar todo + reinsertar todo" que usan los
   demás módulos (eso borraría rutas creadas por un conductor mientras el
   panel tenía cargada una copia desactualizada). En vez de eso, cada
   cambio hecho desde el panel escribe solo la fila que cambió. */
async function upsertRutaRow(row){
  const payload = sanitizeRowForDb("rutas", row);
  const { error } = await supabaseClient.from("rutas").upsert(payload, { onConflict: "nro" });
  if(error){ console.error("Supabase upsert error rutas", error); toast("Error al guardar la ruta"); }
}
async function deleteRutaRow(nro){
  const { error } = await supabaseClient.from("rutas").delete().eq("nro", Number(nro));
  if(error){ console.error("Supabase delete error rutas", error); toast("Error al eliminar la ruta"); }
}

async function saveKey(key, value){
  const { error } = await supabaseClient
    .from(STORAGE_TABLE)
    .upsert({ key, value, updated_at: new Date().toISOString() });
  if(error){ console.error("Supabase upsert error", key, error); toast("Error al guardar en la base de datos"); }
}

async function loadDB(){
  DB = {};
  await Promise.all(MODULE_ORDER.map(async key => {
    const { data, error } = await fetchAllRows(key);
    if(error){ console.error("Supabase select error", key, error); toast("Error al cargar " + key); DB[key] = []; }
    else { DB[key] = data || []; }
  }));

  const { data, error } = await supabaseClient
    .from(STORAGE_TABLE)
    .select("key,value")
    .in("key", [LS_CAT, LS_TRASH, LS_LOG]);
  if(error){ console.error("Supabase select error", error); toast("Error al conectar con la base de datos"); }
  const map = {};
  (data || []).forEach(row => { map[row.key] = row.value; });

  if(map[LS_CAT]){ CAT = map[LS_CAT]; }
  else { CAT = JSON.parse(JSON.stringify(CATALOGOS)); await persistCat(); }

  // Catálogo de Obras: si no existe todavía (instalaciones ya creadas antes
  // de este catálogo) o quedó vacío, se siembra con la lista por defecto.
  if(!Array.isArray(CAT.obras) || !CAT.obras.length){
    CAT.obras = [...new Set(OBRAS_POR_DEFECTO)];
    await persistCat();
  }

  if(map[LS_TRASH]){ TRASH = map[LS_TRASH]; MODULE_ORDER.forEach(k => { if(!TRASH[k]) TRASH[k] = []; }); }
  else { TRASH = emptyTrash(); await persistTrash(); }

  if(map[LS_LOG]){ LOG = map[LS_LOG]; }
  else { LOG = []; await persistLog(); }
}
async function persistDB(opts={}){
  const keys = opts.skipRutas ? MODULE_ORDER.filter(k => k !== "rutas") : MODULE_ORDER;
  await Promise.all(keys.map(syncModuleTable));
  markSaved();
}
async function persistCat(){ await saveKey(LS_CAT, CAT); markSaved(); }
async function persistTrash(){ await saveKey(LS_TRASH, TRASH); markSaved(); }
async function persistLog(){ await saveKey(LS_LOG, LOG); markSaved(); }

function logActivity(moduleKey, action, nro, summary){
  LOG.unshift({ id: uid(), ts: new Date().toISOString(), moduleKey, action, nro, summary });
  if(LOG.length > 3000) LOG.length = 3000;
  persistLog();
}

function nextNro(moduleKey){
  const rows = DB[moduleKey];
  if(!rows.length) return 1;
  return Math.max(...rows.map(r=>Number(r.nro)||0)) + 1;
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
    valorFlete: calc.ingresoTotal || 0,
    rutaNro: ruta.nro,
  };
}

function syncFleteFromRuta(ruta){
  const idx = DB.fletes.findIndex(f => Number(f.rutaNro) === Number(ruta.nro));
  const data = fleteDataFromRuta(ruta);
  if(idx !== -1){
    // Se sincronizan siempre los campos que vienen de la ruta (obra,
    // descripción, fecha, lugar, solicitado por, fotos, valor). Los campos
    // netamente administrativos que se completan a mano en Fletes (tipo,
    // n° repor/guía/factura) no se tocan aquí para no perder lo que el
    // usuario ya cargó.
    DB.fletes[idx] = { ...DB.fletes[idx], ...data };
  } else {
    data.nro = nextNro("fletes");
    data.tipoFlete = "";
    data.nroRepor = "";
    data.nroGuia = "";
    data.nroFactura = "";
    DB.fletes.push(data);
  }
}

function removeFleteForRuta(rutaNro){
  const idx = DB.fletes.findIndex(f => Number(f.rutaNro) === Number(rutaNro));
  if(idx !== -1) DB.fletes.splice(idx, 1);
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
/* Resuelve el authUserId (cuenta de Supabase Auth) del conductor elegido en
   el selector de "rutas", a partir de su nombre completo. Si el conductor
   todavía no se ha registrado en la app del conductor, devuelve null: la
   ruta se guarda igual, y quedará visible para él automáticamente en cuanto
   se registre (ver backfill en el trigger handle_new_driver). */
const authIdDeConductor = nombreCompleto => {
  const full = String(nombreCompleto || "").trim();
  const c = DB.conductores.find(c => `${c.nombres || ""} ${c.apellidos || ""}`.trim() === full);
  return (c && c.authUserId) ? c.authUserId : null;
};
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
      { key:"conductor", label:"Conductor", kind:"select", options:nombresConductores, required:true },
      { key:"obra", label:"Obra", kind:"combo", options:obrasCatalogo, catalogKey:"obras", uppercase:true, required:true },
      { key:"solicitadoPor", label:"Solicitado por", kind:"text" },
      { key:"origen", label:"Origen", kind:"text" },
      { key:"destino", label:"Destino", kind:"text" },
      { key:"fotoInicio", label:"Foto de inicio de ruta", kind:"image", wide:true },
      { key:"fotoFin", label:"Report", kind:"image", wide:true },
      { key:"pesoCarga", label:"Peso carga (Kg)", kind:"number", numeric:true },
      { key:"costoPorKg", label:"Costo x Kg ($)", kind:"number", numeric:true, money:true },
      { key:"ingresoTotal", label:"Ingreso total ($)", kind:"computed", numeric:true, money:true },
      { key:"estadoRuta", label:"Estado", kind:"computed", badge:true },
      { key:"observaciones", label:"Observaciones", kind:"textarea", wide:true },
    ],
    computeFn: computeRuta,
    summary: r => `${r.origen} → ${r.destino}`,
    // Una ruta con foto Report ya fue marcada como Realizada: queda
    // bloqueada para edición y eliminación (su información ya vive en Fletes).
    isLocked: r => !!r.fotoFin,
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
  },
};

const MODULE_ORDER = ["flota","rutas","fletes","mantenimiento","seguros","impuestos","multas","conductores","talleres"];

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

  html += `<div class="nav-group-label">Configuración</div>
    <button class="nav-item ${currentModule==='catalogos'?'active':''}" data-nav="catalogos">
      <span class="ico">📋</span><span>Catálogos</span></button>`;

  html += `<div class="nav-group-label">Historial</div>
    <button class="nav-item ${currentModule==='bitacora'?'active':''}" data-nav="bitacora">
      <span class="ico">📜</span><span>Registro de actividad</span></button>
    <button class="nav-item ${currentModule==='papelera'?'active':''}" data-nav="papelera">
      <span class="ico">🗑️</span><span>Papelera</span><span class="count">${trashCount()}</span></button>`;

  $("#nav").innerHTML = html;
  $$('#nav [data-nav]').forEach(b => b.addEventListener('click', ()=> goTo(b.dataset.nav)));
}

function goTo(key){
  currentModule = key;
  renderSidebar();
  renderMain();
}

/* ==========================================================================
   RENDER: MAIN AREA ROUTER
   ========================================================================== */
function renderMain(){
  if(currentModule === "dashboard") return renderDashboard();
  if(currentModule === "catalogos") return renderCatalogos();
  if(currentModule === "bitacora") return renderBitacora();
  if(currentModule === "papelera") return renderPapelera();
  if(currentModule === "facturas") return renderFacturas();
  return renderModule(currentModule);
}

/* ---------------------------------------------------------------- DASHBOARD */
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
    </div>

    <div class="dash-grid">
      <div class="panel">
        <h3><span class="ico">🗺️</span> Resultado de rutas registradas</h3>
        <div class="mini-row"><span>Ingreso total por carga transportada</span><b class="stars" style="color:var(--success)">$ ${fmtMoney(ingresoTotal)}</b></div>
        <div class="mini-row"><span>Viajes registrados</span><b>${DB.rutas.length}</b></div>
      </div>

      <div class="panel">
        <h3><span class="ico">🔔</span> Atención requerida</h3>
        ${porVencer.map(r=>`
          <div class="mini-row"><span>${plateChip(r.placa)} póliza ${esc(r.aseguradora)}</span><span class="tag ${r.estadoPoliza==='Vencido'?'tag-danger':'tag-warn'}">${r.estadoPoliza}</span></div>`).join("") }
        ${multasPendientes.map(r=>`
          <div class="mini-row"><span>${plateChip(r.placa)} multa ${esc(r.infraccion)}</span><span class="tag tag-danger">Debe $ ${fmtMoney(r.debe)}</span></div>`).join("") }
        ${(!porVencer.length && !multasPendientes.length) ? `<div class="empty-note">Todo en orden. Sin pendientes por ahora.</div>` : ""}
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
  searchTerm = "";
  activeFilters = {};

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

function openForm(moduleKey, nro){
  const cfg = MODULES[moduleKey];
  const existing = nro ? DB[moduleKey].find(r => String(r.nro) === String(nro)) : null;
  if(existing && cfg.isLocked && cfg.isLocked(existing)){
    toast("Esta ruta ya fue marcada como Realizada y no se puede editar.");
    return;
  }
  editing = { module: moduleKey, nro: existing ? existing.nro : null };
  const draft = existing ? {...existing} : {};

  const fields = cfg.columns.filter(c => c.kind !== "computed" && c.kind !== "image");
  const imageFields = cfg.columns.filter(c => c.kind === "image");
  const imageDraft = {};
  imageFields.forEach(c => { imageDraft[c.key] = draft[c.key] || ""; });

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

  $("#btnSave").addEventListener("click", () => submitForm(moduleKey, fields, imageFields, imageDraft));

  // Botón extra solo en Rutas de viaje (panel admin): guarda la ruta,
  // la marca como realizada y salta directo al módulo de Fletes. Solo se
  // habilita cuando ya existe la foto Report.
  const btnSaveComplete = $("#btnSaveComplete");
  if(btnSaveComplete){
    btnSaveComplete.addEventListener("click", () => submitForm(moduleKey, fields, imageFields, imageDraft, { markCompleted: true }));
  }
  updateSaveCompleteState();
}

async function submitForm(moduleKey, fields, imageFields, imageDraft, opts = {}){
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
    toast("Registro actualizado");
  } else if(moduleKey === "rutas"){
    // El nro lo entrega la base de datos (secuencia rutas_nro_seq), nunca
    // max(nro)+1 calculado en el navegador: un conductor podría estar
    // creando otra ruta en este mismo instante desde su teléfono.
    const payload = sanitizeRowForDb("rutas", data);
    delete payload.nro;
    const { data: inserted, error } = await supabaseClient.from("rutas").insert(payload).select().single();
    if(error){ console.error("Supabase insert error rutas", error); toast("Error al crear la ruta"); return; }
    data.nro = inserted.nro;
    DB.rutas.push(data);
    savedRow = data;
    toast("Registro creado");
  } else {
    data.nro = nextNro(moduleKey);
    DB[moduleKey].push(data);
    savedRow = data;
    toast("Registro creado");
  }
  if(moduleKey === "rutas"){
    syncFleteFromRuta(savedRow);
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
  $("#btnConfirmDel").addEventListener("click", ()=>{
    const idx = DB[moduleKey].findIndex(r => String(r.nro) === String(nro));
    if(idx === -1){ closeModal(); return; }
    const [removed] = DB[moduleKey].splice(idx, 1);
    if(moduleKey === "rutas"){ removeFleteForRuta(removed.nro); deleteRutaRow(removed.nro); }
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
function restoreFromTrash(moduleKey, trashId){
  const idx = TRASH[moduleKey].findIndex(t => t._trashId === trashId);
  if(idx === -1){ toast("Ese registro ya no está en la papelera"); return; }
  const [item] = TRASH[moduleKey].splice(idx, 1);
  delete item._trashId;
  const deletedAt = item._deletedAt;
  delete item._deletedAt;
  if(DB[moduleKey].some(r => String(r.nro) === String(item.nro))) item.nro = nextNro(moduleKey);
  DB[moduleKey].push(item);
  if(moduleKey === "rutas"){ syncFleteFromRuta(item); upsertRutaRow(item); }
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
          <span>${fmtTime(e.ts)} · ${cfg ? cfg.icon : "•"} ${cfg ? esc(cfg.label) : esc(e.moduleKey)} — ${esc(e.summary || ("#"+e.nro))}</span>
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
  if(c.kind === "image") return v ? "Adjunta (ver en la app)" : "—";
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
      v = isNaN(d.getTime()) ? s : d.toISOString().slice(0,10);
    }
  } else if(col.kind === "image"){
    v = (typeof v === "string" && v.startsWith("data:image")) ? v : "";
  } else {
    v = String(v).trim();
    if(col.uppercase) v = v.toUpperCase();
  }
  return v;
}

function importObjectsIntoModule(moduleKey, objects, defaults={}){
  const cfg = MODULES[moduleKey];
  const lookup = buildFieldLookup(cfg);
  let added = 0, skipped = 0;
  objects.forEach(obj => {
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
    if(missingRequired || Object.keys(row).length === 0){ skipped++; return; }
    row.nro = nextNro(moduleKey);
    DB[moduleKey].push(row);
    // Catálogos dinámicos: registra valores nuevos (p. ej. Obra) para que
    // queden disponibles después en el desplegable de sugerencias.
    cfg.columns.forEach(c => {
      if(c.catalogKey && row[c.key]){
        const list = CAT[c.catalogKey] || (CAT[c.catalogKey] = []);
        if(!list.includes(row[c.key])) list.push(row[c.key]);
      }
    });
    added++;
  });
  if(added) persistCat();
  return { added, skipped };
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
        if(!rows.length){ resolve({type:"sheets", sheets:{ [sheetName]: [] }}); return; }
        const headers = rows[0];
        const objects = rows.slice(1).map(r => { const o = {}; headers.forEach((h,i)=> o[h]=r[i]); return o; });
        resolve({type:"sheets", sheets:{ [sheetName]: objects }});
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
          wb.SheetNames.forEach(name => { sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], {defval:""}); });
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

function handleImportFile(file, targetModule){
  readFileAsData(file).then(result => {
    if(result.type === "json"){
      const payload = result.payload;
      if(payload && payload.data && payload.catalogos){
        DB = payload.data; CAT = payload.catalogos;
        persistDB(); persistCat();
        toast("Respaldo completo importado correctamente");
        finishImport();
        return;
      }
      if(Array.isArray(payload)){
        if(!targetModule){ toast("Selecciona un módulo destino para este archivo"); return; }
        const { added, skipped } = importObjectsIntoModule(targetModule, payload);
        persistDB();
        toast(`${added} registro(s) importado(s)${skipped ? `, ${skipped} omitido(s) por datos incompletos` : ""}`);
        finishImport();
        return;
      }
      toast("El archivo JSON no tiene un formato reconocido");
      return;
    }

    // CSV / Excel / ODS → objetos agrupados por hoja
    const sheetNames = Object.keys(result.sheets);
    if(!targetModule){
      let totalAdded = 0, totalSkipped = 0, matchedAny = false;
      sheetNames.forEach(sn => {
        const modKey = MODULE_ORDER.find(k => normalizeHeader(MODULES[k].label) === normalizeHeader(sn) || normalizeHeader(k) === normalizeHeader(sn));
        if(modKey){
          matchedAny = true;
          const { added, skipped } = importObjectsIntoModule(modKey, result.sheets[sn]);
          totalAdded += added; totalSkipped += skipped;
        }
      });
      if(!matchedAny){ toast("No se reconoció ningún módulo en las hojas del archivo. Elige un módulo destino."); return; }
      persistDB();
      toast(`${totalAdded} registro(s) importado(s) en total${totalSkipped ? `, ${totalSkipped} omitido(s)` : ""}`);
      finishImport();
    } else {
      const cfg = MODULES[targetModule];
      if(cfg.sheetAsField){
        // Cada hoja del archivo se importa como registros separados, usando el nombre
        // de la hoja como valor del campo indicado (p. ej. "obra" en Fletes).
        let totalAdded = 0, totalSkipped = 0;
        sheetNames.forEach(sn => {
          const { added, skipped } = importObjectsIntoModule(targetModule, result.sheets[sn], { [cfg.sheetAsField]: sn });
          totalAdded += added; totalSkipped += skipped;
        });
        persistDB();
        toast(`${totalAdded} registro(s) importado(s)${totalSkipped ? `, ${totalSkipped} omitido(s) por datos incompletos` : ""}`);
        finishImport();
      } else {
        const data = result.sheets[sheetNames[0]] || [];
        const { added, skipped } = importObjectsIntoModule(targetModule, data);
        persistDB();
        toast(`${added} registro(s) importado(s)${skipped ? `, ${skipped} omitido(s) por datos incompletos` : ""}`);
        finishImport();
      }
    }
  }).catch(err => toast(err.message || "No se pudo leer el archivo"));
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
            <label>Archivo</label>
            <input type="file" id="importFile" accept=".json,.csv,.xlsx,.xls,.xlsm,.ods">
          </div>
          <p style="color:var(--ink-faint); font-size:11.5px; margin-top:10px;">
            Formatos aceptados: JSON, CSV, Excel (.xlsx, .xls, .xlsm) y OpenDocument (.ods).
            No se aceptan imágenes ni archivos de texto plano (.txt).
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
  $("#btnDoImport").addEventListener("click", () => {
    const file = $("#importFile").files[0];
    if(!file){ toast("Selecciona un archivo primero"); return; }
    const target = isAll ? ($("#importTarget").value || null) : moduleKey;
    handleImportFile(file, target);
  });
}

async function resetAll(){
  if(!confirm("Esto borrará TODOS los datos guardados en la base de datos (registros, catálogos personalizados, papelera e historial). Esta acción no se puede deshacer. ¿Continuar?")) return;
  const results = await Promise.all(MODULE_ORDER.map(key => supabaseClient.from(key).delete().gte("nro", 0)));
  const failedTable = results.find(r => r.error);
  if(failedTable){ console.error("Supabase delete error", failedTable.error); toast("Error al borrar los datos"); return; }
  const { error } = await supabaseClient.from(STORAGE_TABLE).delete().in("key", [LS_CAT, LS_TRASH, LS_LOG]);
  if(error){ console.error("Supabase delete error", error); toast("Error al borrar los datos"); return; }
  await loadDB();
  goTo("dashboard");
  toast("Todos los datos fueron borrados");
}

/* ==========================================================================
   INIT
   ========================================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  // El panel de admin nunca inicia sesión: siempre debe operar con el rol
  // "anon" (que es el que tiene permisos de escritura en app_storage y en
  // el resto de las tablas). Si en este mismo navegador se probó alguna vez
  // el login de conductor, puede haber quedado una sesión de Supabase Auth
  // activa que rompe los guardados por RLS (rol "authenticated" en vez de
  // "anon"). Este signOut defensivo evita ese problema sin afectar en nada
  // el funcionamiento normal del panel.
  const { data: { session } } = await supabaseClient.auth.getSession();
  if(session) await supabaseClient.auth.signOut();

  await loadDB();
  // Antes esta sincronización solo corría dentro del listener realtime de
  // "rutas" (watchRutasRealtime), es decir, únicamente si el panel ya
  // estaba abierto cuando llegaba el cambio. Si un conductor subía sus
  // fotos (inicio o Report) mientras nadie tenía el panel abierto, esas
  // fotos nunca se copiaban a Fletes hasta que esa misma ruta recibiera
  // otro evento en vivo. Se corre también aquí, al cargar, para que el
  // primer render ya refleje el estado real de Fletes.
  await syncClosedRoutesToFletes();
  renderSidebar();
  renderMain();
  $("#btnReset").addEventListener("click", resetAll);
  watchRutasRealtime();
});

/* Espejo en vivo: cuando un conductor crea, edita o borra una ruta desde
   su propia app (o desde otro navegador de este mismo panel), esta pestaña
   recarga solo la tabla "rutas" desde Supabase y refresca la pantalla si
   corresponde — sin que nadie tenga que apretar F5. */
function watchRutasRealtime(){
  supabaseClient
    .channel("rutas-espejo")
    .on("postgres_changes", { event: "*", schema: "public", table: "rutas" }, async () => {
      const { data, error } = await fetchAllRows("rutas");
      if(error){ console.error("Supabase realtime reload error", error); return; }
      DB.rutas = data || [];
      await syncClosedRoutesToFletes();
      if(["rutas", "dashboard", "fletes"].includes(currentModule)) renderMain();
    })
    .subscribe();
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
  DB.rutas.forEach(r => {
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
        syncFleteFromRuta(r);
        changed = true;
      }
    } else if(r.fotoFin){
      // Ruta recién cerrada (tiene Report) y todavía sin fila espejo: se crea.
      syncFleteFromRuta(r);
      const flete = DB.fletes.find(f => Number(f.rutaNro) === Number(r.nro));
      if(flete) logActivity("fletes", "create", flete.nro, MODULES.fletes.summary ? MODULES.fletes.summary(flete) : `#${flete.nro}`);
      changed = true;
    }
  });
  if(!changed) return;
  await persistDB({ skipRutas: true });
}
