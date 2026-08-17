<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'fletes';
const COLUMNS = ['nro', 'obra', 'descripcion', 'realizado', 'lugar', 'tipoFlete', 'solicitadoPor', 'nroRepor', 'nroGuia', 'valorFlete', 'nroFactura', 'rutaNro', 'fotoInicio', 'fotoFin'];

json_response(['rows' => list_rows(TABLE, COLUMNS)]);
