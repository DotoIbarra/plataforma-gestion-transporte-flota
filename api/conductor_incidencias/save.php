<?php
require_once __DIR__ . '/../conductor_auth.php';
require_once __DIR__ . '/../notify.php';
require_conductor();

/**
 * El conductor solo puede CREAR incidencias, nunca editar una existente:
 * así no puede alterar el estado o la solución que registre el administrador
 * una vez que la está gestionando. Si necesita agregar algo más, reporta
 * una incidencia nueva.
 */
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    json_error('Cuerpo inválido, se esperaba JSON', 422);
}

$tipo = trim($input['tipo'] ?? '');
$descripcion = trim($input['descripcion'] ?? '');
if ($tipo === '' || $descripcion === '') {
    json_error('Falta el tipo o la descripción de la incidencia', 422);
}

$myId = current_conductor_user_id();
$conn = db();

$stmt = $conn->prepare('SELECT nombres, apellidos FROM conductores WHERE conductor_user_id = ? LIMIT 1');
$stmt->bind_param('i', $myId);
$stmt->execute();
$perfil = $stmt->get_result()->fetch_assoc();
$stmt->close();
$nombreCompleto = trim(($perfil['nombres'] ?? '') . ' ' . ($perfil['apellidos'] ?? ''));

$rutaNro = (isset($input['rutaNro']) && $input['rutaNro'] !== '') ? (int)$input['rutaNro'] : null;

$data = [
    'fecha'             => $input['fecha'] ?: date('Y-m-d'),
    'rutaNro'           => $rutaNro,
    'placa'             => $input['placa'] ?? '',
    'conductor'         => $nombreCompleto,
    'tipo'              => $tipo,
    'gravedad'          => $input['gravedad'] ?: 'Media',
    'descripcion'       => $descripcion,
    'evidencia'         => $input['evidencia'] ?? '',
    'estado'            => 'Abierta',
    'fechaResolucion'   => null,
    'solucion'          => '',
    'reportadoPor'      => $nombreCompleto . ' (conductor)',
    'observaciones'     => $input['observaciones'] ?? '',
    'conductor_user_id' => $myId,
];

$result = $conn->query('SELECT MAX(nro) AS max_nro FROM incidencias');
$maxNro = (int)($result->fetch_assoc()['max_nro'] ?? 0);
$data['nro'] = $maxNro + 1;

$columns = array_keys($data);
$colList = implode(', ', array_map(fn($c) => "`$c`", $columns));
$placeholders = implode(', ', array_fill(0, count($columns), '?'));
$stmt = $conn->prepare("INSERT INTO incidencias ($colList) VALUES ($placeholders)");
$types = str_repeat('s', count($columns));
$values = array_values($data);
$stmt->bind_param($types, ...$values);
$stmt->execute();
$stmt->close();

notify('incidencia', "{$nombreCompleto} reportó una incidencia: {$tipo}", 'incidencia', (int)$data['nro']);

json_response(['ok' => true, 'row' => $data]);
