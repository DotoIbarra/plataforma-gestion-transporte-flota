<?php
require_once __DIR__ . '/../auth.php';
require_once __DIR__ . '/../crud_helpers.php';
require_admin();

const TABLE = 'conductores';
const COLUMNS = ['nro', 'docIdentidad', 'nombres', 'apellidos', 'licencia', 'clase', 'direccion', 'telefono', 'calificacion', 'municipalidad', 'fechaUltimoControl', 'fechaControl', 'licenciaPdf'];

json_response(['rows' => list_rows(TABLE, COLUMNS)]);
