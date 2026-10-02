<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

/**
 * Alta / edición de un reporte del Centro de Reportes (incidencias e
 * inconsistencias del propio sistema: conductores, vehículos, rutas,
 * viajes, datos faltantes o inconsistentes, problemas administrativos).
 * "comentarios" e "historial" viajan como JSON (texto) ya armado desde el
 * front — acá solo se guardan tal cual. Para agregar un comentario o
 * cambiar el estado sin pisar el resto de la fila, usar comentar.php y
 * estado.php en vez de este endpoint.
 */
const TABLE = 'reportes';
const COLUMNS = [
    'nro', 'categoria', 'prioridad', 'descripcion', 'fecha', 'usuarioReporta',
    'estado', 'moduloRelacionado', 'registroRelacionadoNro', 'comentarios', 'historial',
];
const NUMERIC_COLS = ['nro', 'registroRelacionadoNro'];
const DATE_COLS = ['fecha'];

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_decode(file_get_contents('php://input'), true);
if (!is_array($input)) {
    json_error('Cuerpo inválido, se esperaba JSON', 422);
}

// Reporte nuevo: arranca con estado "Pendiente" y un primer registro en
// el historial, si el front no los mandó ya armados.
if (empty($input['nro'])) {
    $input['estado'] = $input['estado'] ?? 'Pendiente';
    if (empty($input['historial'])) {
        $input['historial'] = json_encode([[
            'fecha' => date('c'),
            'usuario' => $input['usuarioReporta'] ?? 'Sistema',
            'accion' => 'Reporte creado',
        ]], JSON_UNESCAPED_UNICODE);
    }
    $input['comentarios'] = $input['comentarios'] ?? json_encode([], JSON_UNESCAPED_UNICODE);
}

$row = upsert_row(TABLE, COLUMNS, NUMERIC_COLS, DATE_COLS, $input);
json_response(['ok' => true, 'row' => $row]);
