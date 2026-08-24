<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'incidencias';
const COLUMNS = [
    'nro', 'fecha', 'rutaNro', 'placa', 'conductor', 'tipo', 'gravedad',
    'descripcion', 'evidencia', 'estado', 'fechaResolucion', 'solucion',
    'reportadoPor', 'observaciones', 'conductor_user_id',
];
const NUMERIC_COLS = ['nro', 'rutaNro', 'conductor_user_id'];
const DATE_COLS = ['fecha', 'fechaResolucion'];

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    json_error('Cuerpo inválido, se esperaba JSON', 422);
}

$row = upsert_row(TABLE, COLUMNS, NUMERIC_COLS, DATE_COLS, $input);
json_response(['ok' => true, 'row' => $row]);
