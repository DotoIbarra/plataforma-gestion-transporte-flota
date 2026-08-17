<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'flota';
const COLUMNS = ['nro', 'tipo', 'marca', 'modelo', 'placa', 'nroSerie', 'color', 'anio', 'cargaMaxima', 'estado'];

json_response(['rows' => list_rows(TABLE, COLUMNS)]);
