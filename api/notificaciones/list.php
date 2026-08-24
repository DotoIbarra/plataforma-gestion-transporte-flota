<?php
require_once __DIR__ . '/../auth.php';
require_admin(); // cualquier staff logueado (admin u operador) ve las notificaciones

$result = db()->query('SELECT id, tipo, mensaje, entidad, entidad_id, leida, fecha_creacion FROM notificaciones ORDER BY id DESC LIMIT 30');
$rows = [];
while ($row = $result->fetch_assoc()) {
    $row['leida'] = (bool)$row['leida'];
    $rows[] = $row;
}

$stmt = db()->prepare('SELECT COUNT(*) AS no_leidas FROM notificaciones WHERE leida = 0');
$stmt->execute();
$noLeidas = (int)($stmt->get_result()->fetch_assoc()['no_leidas'] ?? 0);
$stmt->close();

json_response(['rows' => $rows, 'no_leidas' => $noLeidas]);
