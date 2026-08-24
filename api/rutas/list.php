<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'rutas';
const COLUMNS = [
    'nro', 'fechaSalida', 'fechaLlegada', 'placa', 'estado', 'estadoServicio', 'conductor',
    'origen', 'destino', 'fotoInicio', 'fotoFin', 'pesoCarga', 'costoPorKg',
    'observaciones', 'obra', 'solicitadoPor', 'nroRepor', 'nroGuia',
    'conductor_user_id', 'lat', 'lng', 'ubicacionTs',
];

json_response(['rows' => list_rows(TABLE, COLUMNS)]);
