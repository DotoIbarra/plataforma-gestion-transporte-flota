<?php
require_once __DIR__ . '/../conductor_auth.php';
require_conductor();

const COLUMNS = [
    'nro', 'fecha', 'rutaNro', 'placa', 'tipo', 'gravedad', 'descripcion',
    'evidencia', 'estado', 'fechaResolucion', 'solucion', 'observaciones',
];

$colList = implode(', ', array_map(fn($c) => "`$c`", COLUMNS));
$id = current_conductor_user_id();

$stmt = db()->prepare("SELECT $colList FROM incidencias WHERE conductor_user_id = ? ORDER BY nro DESC");
$stmt->bind_param('i', $id);
$stmt->execute();
$result = $stmt->get_result();
$rows = [];
while ($row = $result->fetch_assoc()) {
    $rows[] = $row;
}
$stmt->close();

json_response(['rows' => $rows]);
