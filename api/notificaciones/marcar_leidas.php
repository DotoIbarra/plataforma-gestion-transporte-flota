<?php
require_once __DIR__ . '/../auth.php';
require_admin();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

db()->query('UPDATE notificaciones SET leida = 1 WHERE leida = 0');
json_response(['ok' => true]);
