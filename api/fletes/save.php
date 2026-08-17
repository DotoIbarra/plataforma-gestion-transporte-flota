<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'fletes';
const COLUMNS = ['nro', 'obra', 'descripcion', 'realizado', 'lugar', 'tipoFlete', 'solicitadoPor', 'nroRepor', 'nroGuia', 'valorFlete', 'nroFactura', 'rutaNro', 'fotoInicio', 'fotoFin'];
const NUMERIC_COLS = ['nro', 'valorFlete', 'rutaNro'];
const DATE_COLS = ['realizado'];

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    json_error('Cuerpo inválido, se esperaba JSON', 422);
}

$row = upsert_row(TABLE, COLUMNS, NUMERIC_COLS, DATE_COLS, $input);
json_response(['ok' => true, 'row' => $row]);
