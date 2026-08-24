<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../config.php';
require_admin();

// Últimos 500 eventos de auditoría (admin y conductor), lo más reciente primero.
$result = db()->query(
    'SELECT id, actor_tipo, actor_nombre, accion, entidad, entidad_id, detalle, creado_en
     FROM auditoria ORDER BY id DESC LIMIT 500'
);
$rows = [];
while ($row = $result->fetch_assoc()) {
    $rows[] = $row;
}

json_response(['rows' => $rows]);
