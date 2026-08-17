<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'mantenimiento';
const COLUMNS = ['nro', 'placa', 'taller', 'fechaEntrada', 'fechaSalida', 'tipo', 'kilometraje', 'paquete', 'causas', 'costoTotal', 'fechaPago', 'observaciones'];
const NUMERIC_COLS = ['nro', 'kilometraje', 'costoTotal'];
const DATE_COLS = ['fechaEntrada', 'fechaSalida', 'fechaPago'];

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    json_error('Cuerpo inválido, se esperaba JSON', 422);
}

$row = upsert_row(TABLE, COLUMNS, NUMERIC_COLS, DATE_COLS, $input);
json_response(['ok' => true, 'row' => $row]);
