<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'rutas';
const COLUMNS = [
    'nro', 'fechaSalida', 'fechaLlegada', 'placa', 'estado', 'conductor',
    'origen', 'destino', 'fotoInicio', 'fotoFin', 'pesoCarga', 'costoPorKg',
    'observaciones', 'obra', 'solicitadoPor', 'nroRepor', 'nroGuia',
    'conductor_user_id',
];
const NUMERIC_COLS = ['nro', 'pesoCarga', 'costoPorKg', 'conductor_user_id'];
const DATE_COLS = ['fechaSalida', 'fechaLlegada'];

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    json_error('Cuerpo inválido, se esperaba JSON', 422);
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

// El navegador nunca decide directamente el conductor_user_id: siempre se
// recalcula acá en base al nombre escrito, para que no se pueda falsear.
$input['conductor_user_id'] = buscar_conductor_user_id($input['conductor'] ?? '');

$row = upsert_row(TABLE, COLUMNS, NUMERIC_COLS, DATE_COLS, $input);
json_response(['ok' => true, 'row' => $row]);
