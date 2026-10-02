<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_once __DIR__ . '/../auditoria.php';
require_admin();

const TABLE = 'rutas';
const COLUMNS = [
    'nro', 'fechaSalida', 'fechaLlegada', 'placa', 'estado', 'estadoServicio', 'conductor',
    'origen', 'destino', 'fotoInicio', 'fotoFin', 'pesoCarga', 'costoPorKg',
    'observaciones', 'obra', 'solicitadoPor', 'nroRepor', 'nroGuia',
    'conductor_user_id', 'kilometraje',
];
const NUMERIC_COLS = ['nro', 'pesoCarga', 'costoPorKg', 'conductor_user_id', 'kilometraje'];
const DATE_COLS = ['fechaSalida', 'fechaLlegada'];

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    json_error('Cuerpo inválido, se esperaba JSON', 422);
}

// Flujo de estados del servicio: Asignado -> Aceptado -> En ruta -> En destino
// -> Finalizado/Cancelado. Una ruta nueva (sin nro) siempre nace "Asignado";
// si además ya trae foto de cierre (fotoFin), nace directamente "Finalizado".
if ((!isset($input['nro']) || $input['nro'] === '' || $input['nro'] === null) && empty($input['estadoServicio'])) {
    $input['estadoServicio'] = !empty($input['fotoFin']) ? 'Finalizado' : 'Asignado';
}
// Si se guarda una foto de cierre (Report) y el estado todavía no es terminal,
// el servicio queda automáticamente Finalizado — sea cual sea el módulo que lo guarde.
if (!empty($input['fotoFin']) && !in_array($input['estadoServicio'] ?? '', ['Finalizado', 'Cancelado'], true)) {
    $input['estadoServicio'] = 'Finalizado';
}

/**
 * Igual que hacía fetchAuthIdDeConductor() en app.js con Supabase: busca
 * si el texto del campo "conductor" coincide con el nombre completo de
 * algún conductor que YA tenga cuenta de acceso (conductor_user_id no
 * nulo), y si es así, enlaza la ruta a esa cuenta. Si el conductor
 * todavía no tiene cuenta creada (fase 7), simplemente queda sin enlazar.
 */
function buscar_conductor_user_id(string $nombreCompleto): ?int {
    $nombreCompleto = trim($nombreCompleto);
    if ($nombreCompleto === '') return null;

    $stmt = db()->prepare(
        "SELECT conductor_user_id FROM conductores
         WHERE TRIM(CONCAT(nombres, ' ', apellidos)) = ?
           AND conductor_user_id IS NOT NULL
         LIMIT 1"
    );
    $stmt->bind_param('s', $nombreCompleto);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    return $row ? (int)$row['conductor_user_id'] : null;
}

/**
 * Entregable #6 (Asignación de recursos con disponibilidad): antes de
 * guardar, revisa si la placa o el conductor que se están asignando ya
 * tienen OTRO servicio activo (no Finalizado/Cancelado) cuyo rango de
 * fechas se cruza con el de esta ruta. Si hay cruce, no guarda: devuelve
 * 409 con el detalle, para que el panel avise al admin ANTES de doble-
 * asignar un mismo camión o conductor a dos servicios en simultáneo.
 * El admin puede forzar el guardado igual mandando forzarConflicto=true
 * (por ejemplo, si sabe que en la práctica el cruce de fechas no es real).
 */
function buscar_conflictos_disponibilidad(array $input): array {
    $nro = (isset($input['nro']) && $input['nro'] !== '') ? (int)$input['nro'] : null;
    $placa = trim($input['placa'] ?? '');
    $conductor = trim($input['conductor'] ?? '');
    $desde = $input['fechaSalida'] ?? null;
    if (!$desde) return [];
    // Sin fecha de llegada, el servicio se considera abierto ese mismo día
    // en adelante (ocupa desde fechaSalida sin fin conocido todavía).
    $hasta = $input['fechaLlegada'] ?: $desde;

    $conn = db();
    $conflictos = [];

    foreach (['placa' => $placa, 'conductor' => $conductor] as $campo => $valor) {
        if ($valor === '') continue;
        $sql = "SELECT nro, placa, conductor, fechaSalida, fechaLlegada, estadoServicio
                FROM rutas
                WHERE `$campo` = ?
                  AND estadoServicio NOT IN ('Finalizado','Cancelado')
                  AND fechaSalida IS NOT NULL
                  AND fechaSalida <= ?
                  AND COALESCE(fechaLlegada, fechaSalida) >= ?";
        $params = [$valor, $hasta, $desde];
        $types = 'sss';
        if ($nro !== null) { $sql .= " AND nro != ?"; $params[] = $nro; $types .= 'i'; }

        $stmt = $conn->prepare($sql);
        $stmt->bind_param($types, ...$params);
        $stmt->execute();
        $result = $stmt->get_result();
        while ($row = $result->fetch_assoc()) {
            $row['recurso'] = $campo;
            $conflictos[] = $row;
        }
        $stmt->close();
    }
    return $conflictos;
}

if (empty($input['forzarConflicto'])) {
    $conflictos = buscar_conflictos_disponibilidad($input);
    if ($conflictos) {
        json_response(['error' => 'conflicto_disponibilidad', 'conflictos' => $conflictos], 409);
    }
}

// El navegador nunca decide directamente el conductor_user_id: siempre se
// recalcula acá en base al nombre escrito, para que no se pueda falsear.
$input['conductor_user_id'] = buscar_conductor_user_id($input['conductor'] ?? '');

$esNuevo = !isset($input['nro']) || $input['nro'] === '' || $input['nro'] === null;
$row = upsert_row(TABLE, COLUMNS, NUMERIC_COLS, DATE_COLS, $input);

$adminNombre = $_SESSION['admin_nombre'] ?? ($_SESSION['admin_email'] ?? 'Admin');
audit('admin', $adminNombre, $esNuevo ? 'create' : 'update', 'rutas', (int)$row['nro'],
    trim(($row['origen'] ?? '') . ' → ' . ($row['destino'] ?? '')));

json_response(['ok' => true, 'row' => $row]);
