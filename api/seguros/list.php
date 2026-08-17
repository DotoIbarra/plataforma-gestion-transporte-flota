<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'seguros';
const COLUMNS = ['nro', 'placa', 'aseguradora', 'poliza', 'fechaInicio', 'fechaVencimiento', 'importePagado', 'fechaPago'];

json_response(['rows' => list_rows(TABLE, COLUMNS)]);
