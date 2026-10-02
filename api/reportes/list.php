<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'reportes';
const COLUMNS = [
    'nro', 'categoria', 'prioridad', 'descripcion', 'fecha', 'usuarioReporta',
    'estado', 'moduloRelacionado', 'registroRelacionadoNro', 'comentarios', 'historial',
];

json_response(['rows' => list_rows(TABLE, COLUMNS)]);
