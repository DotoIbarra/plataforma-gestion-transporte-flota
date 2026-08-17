<?php
require_once __DIR__ . '/../conductor_auth.php';
require_conductor();

const COLUMNS = [
    'nro', 'fechaSalida', 'fechaLlegada', 'placa', 'estado', 'conductor',
    'origen', 'destino', 'fotoInicio', 'fotoFin', 'pesoCarga', 'costoPorKg',
    'observaciones', 'obra', 'solicitadoPor', 'nroRepor', 'nroGuia',
];

$colList = implode(', ', array_map(fn($c) => "`$c`", COLUMNS));
$id = current_conductor_user_id();

$stmt = db()->prepare("SELECT $colList FROM rutas WHERE conductor_user_id = ? ORDER BY nro ASC");
$stmt->bind_param('i', $id);
$stmt->execute();
$result = $stmt->get_result();
$rows = [];
while ($row = $result->fetch_assoc()) {
    $rows[] = $row;
}
$stmt->close();

json_response(['rows' => $rows]);
