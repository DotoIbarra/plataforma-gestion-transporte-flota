/* ========================================================================
   DATOS SEMILLA — Control de Flota Vehicular
   Extraídos del libro original control-de-flota-vehicular.xlsx
   Se cargan en localStorage SOLO la primera vez que se abre la página.
   ======================================================================== */

const SEED = {
  // Todos los módulos operativos inician vacíos: los datos los ingresa el usuario.
  flota: [],
  seguros: [],
  impuestos: [],
  conductores: [],
  talleres: [],
  rutas: [],
  multas: [],
  mantenimiento: [],
  fletes: [],
};

/* Catálogos ("Otras listas" en el Excel original) usados en los desplegables. */
const CATALOGOS = {
  tiposVehiculo: ["Auto", "Autobus", "Camión"],

  marcaModelo: [
    { marca: "BMW", modelo: "Coupe" }, { marca: "BMW", modelo: "E92" },
    { marca: "Honda", modelo: "Accord" }, { marca: "Honda", modelo: "City" }, { marca: "Honda", modelo: "Civic" }, { marca: "Honda", modelo: "Legend" }, { marca: "Honda", modelo: "Pilot" },
    { marca: "Mercedes Benz", modelo: "Intoura" }, { marca: "Mercedes Benz", modelo: "Sprinter City" }, { marca: "Mercedes Benz", modelo: "Sprinter Transfer" }, { marca: "Mercedes Benz", modelo: "Sprinter Travel" },
    { marca: "Mitsubishi", modelo: "Eclipse Cross" }, { marca: "Mitsubishi", modelo: "Outlander" }, { marca: "Mitsubishi", modelo: "Xpander" },
    { marca: "Nissan", modelo: "Qasqai" }, { marca: "Nissan", modelo: "Santa Fe" }, { marca: "Nissan", modelo: "Sentra" }, { marca: "Nissan", modelo: "Tiida" }, { marca: "Nissan", modelo: "Versa" },
    { marca: "Scania", modelo: "Q-500" }, { marca: "Scania", modelo: "R-450" },
    { marca: "Toyota", modelo: "Camry" }, { marca: "Toyota", modelo: "Corolla" }, { marca: "Toyota", modelo: "Hilux" }, { marca: "Toyota", modelo: "Rav4" }, { marca: "Toyota", modelo: "Rush" },
    { marca: "Volswagen", modelo: "Fest" }, { marca: "Volswagen", modelo: "Gol" }, { marca: "Volswagen", modelo: "Tiguan" }, { marca: "Volswagen", modelo: "Xtreme" },
  ],

  estacionesCombustible: ["Copec", "Shell", "Petrobras", "Terpel", "Aramco (ex Esso)", "Particular / Otro"],
  tiposCombustible: ["Bencina 93", "Bencina 95", "Bencina 97", "Diésel", "GLP"],
  tiposMantenimiento: ["Preventivo", "Correctivo"],

  paquetesMantenimiento: {
    Preventivo: ["Preventivo 01", "Preventivo 02", "Preventivo 03", "Preventivo 04", "Preventivo 05"],
    Correctivo: ["Correctivo 01", "Correctivo 02", "Correctivo 03"],
  },

  serviciosPorPaquete: {
    "Preventivo 01": ["Ajuste del Tiempo del Motor", "Cambio de Aceite y Filtro de Aceite", "Cambio de Filtro de Aire", "Inspección de la Correa de Distribución", "Inspección del Sistema de Frenos"],
    "Preventivo 02": ["Inspección del Sistema de Suspensión", "Mantenimiento de la Batería", "Mantenimiento del Sistema de Combustible", "Mantenimiento del Sistema de Dirección"],
    "Preventivo 03": ["Reemplazo de Bujías, Cables y Correas Serpentinas", "Revisión de Amortiguadores", "Revisión de Luces", "Revisión del Dispositivo de Acoplamiento"],
    "Preventivo 04": ["Revisión del Sistema de Admisión, Mangueras y Tuberías", "Revisión del Sistema de Escape", "Servicio Completo de Mantenimiento Automotriz"],
    "Preventivo 05": ["Verificación de Neumáticos", "Verificación de Niveles de Fluidos", "Verificación del Funcionamiento del Motor", "Verificación del Sistema de Transmisión"],
    "Correctivo 01": ["Planchado y pintado"],
    "Correctivo 02": ["Cambio de puertas"],
    "Correctivo 03": ["Eliminación de imperfecciones de la pintura"],
  },

  infracciones: ["Accidente imprudencial", "Alta velocidad", "Conductor alcoholizado", "Conductor temerario", "Mal estacionado", "Se pasó la luz roja"],

  estadosVehiculo: ["Disponible", "En viaje", "En mantenimiento", "No disponible"],

  tiposFlete: ["Camion Grande", "Camion Chico", "Camioneta", "Furgon", "Grua", "Otro"],
};
