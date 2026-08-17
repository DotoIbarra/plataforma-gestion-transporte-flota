<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'impuestos';
const COLUMNS = ['nro', 'placa', 'tipo', 'anio', 'importe', 'fechaPago'];

json_response(['rows' => list_rows(TABLE, COLUMNS)]);
