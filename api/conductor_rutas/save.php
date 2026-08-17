<?php
require_once __DIR__ . '/../conductor_auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_conductor();

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

$myId = current_conductor_user_id();
$conn = db();

// Si viene un nro (edición), verifica que esa ruta sea realmente suya
// antes de dejar tocarla — nunca confiar en lo que mande el navegador.
$nro = $input['nro'] ?? null;
if ($nro !== null && $nro !== '') {
    $nro = (int)$nro;
    $stmt = $conn->prepare('SELECT conductor_user_id FROM rutas WHERE nro = ? LIMIT 1');
    $stmt->bind_param('i', $nro);
    $stmt->execute();
    $existing = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if ($existing && (int)$existing['conductor_user_id'] !== $myId) {
        json_error('No puedes editar una ruta que no es tuya', 403);
    }
}

// El nombre que se guarda en "conductor" siempre sale de la ficha real,
// nunca de lo que el navegador mande — así nadie puede hacerse pasar por
// otro conductor.
$stmt = $conn->prepare('SELECT nombres, apellidos FROM conductores WHERE conductor_user_id = ? LIMIT 1');
$stmt->bind_param('i', $myId);
$stmt->execute();
$perfil = $stmt->get_result()->fetch_assoc();
$stmt->close();

$input['conductor'] = trim(($perfil['nombres'] ?? '') . ' ' . ($perfil['apellidos'] ?? ''));
$input['conductor_user_id'] = $myId;

$row = upsert_row(TABLE, COLUMNS, NUMERIC_COLS, DATE_COLS, $input);
json_response(['ok' => true, 'row' => $row]);
