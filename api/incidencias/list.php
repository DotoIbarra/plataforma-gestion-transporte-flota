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

json_response(['rows' => list_rows(TABLE, COLUMNS)]);
