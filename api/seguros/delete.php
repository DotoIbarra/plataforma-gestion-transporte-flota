<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'seguros';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
$nro = $input['nro'] ?? null;
if ($nro === null || $nro === '') {
    json_error('Falta el nro a eliminar', 422);
}

delete_row(TABLE, (int)$nro);
json_response(['ok' => true]);
