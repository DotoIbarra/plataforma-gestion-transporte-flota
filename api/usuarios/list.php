<?php
require_once __DIR__ . '/../auth.php';
require_role_admin();

// Umbral de tolerancia: si el heartbeat más reciente tiene más de este
// tiempo, se considera desconectado aunque nadie haya cerrado sesión
// explícitamente (pestaña cerrada de golpe, computador apagado, etc.).
// app.js manda un heartbeat cada 20s, así que 3 latidos perdidos (60s)
// es un margen razonable antes de dar a alguien por desconectado.
const HEARTBEAT_TIMEOUT_SEG = 60;

$result = db()->query(
    "SELECT id, email, nombre, rol, last_heartbeat_at, last_activity_status, sesion_activa,
            TIMESTAMPDIFF(SECOND, last_heartbeat_at, NOW()) AS segundos_desde_heartbeat
     FROM admin_users ORDER BY nombre ASC"
);
$rows = [];
while ($row = $result->fetch_assoc()) {
    $fresco = $row['sesion_activa'] == 1
        && $row['last_heartbeat_at'] !== null
        && $row['segundos_desde_heartbeat'] !== null
        && (int)$row['segundos_desde_heartbeat'] <= HEARTBEAT_TIMEOUT_SEG;

    if ($fresco) {
        $row['estado'] = ($row['last_activity_status'] === 'ausente') ? 'ausente' : 'conectado';
    } else {
        $row['estado'] = 'desconectado';
    }
    // Última vez que se supo algo de este usuario (visto por última vez).
    // El frontend la formatea como "hace X min/h/días".
    $row['ultima_conexion'] = $row['last_heartbeat_at'];

    unset($row['last_activity_status'], $row['sesion_activa'], $row['segundos_desde_heartbeat']);
    $rows[] = $row;
}

json_response(['rows' => $rows]);
