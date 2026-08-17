<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'multas';
const COLUMNS = ['nro', 'fecha', 'nroViaje', 'placa', 'conductor', 'infraccion', 'importeMulta', 'importePagado', 'observaciones'];

json_response(['rows' => list_rows(TABLE, COLUMNS)]);
