<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'mantenimiento';
const COLUMNS = ['nro', 'placa', 'taller', 'fechaEntrada', 'fechaSalida', 'tipo', 'kilometraje', 'paquete', 'causas', 'costoTotal', 'fechaPago', 'observaciones'];

json_response(['rows' => list_rows(TABLE, COLUMNS)]);
