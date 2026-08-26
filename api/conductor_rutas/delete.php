<?php
require_once __DIR__ . '/../conductor_auth.php';
require_conductor();

/**
 * Los conductores nunca pueden eliminar rutas — ni siquiera las propias.
 * Esa acción es exclusiva del panel de administración
 * (api/rutas/delete.php). Este endpoint queda solo para responder con un
 * 403 claro si algo del cliente todavía intenta llamarlo.
 */
json_error('No tienes permisos para eliminar rutas. Esa acción es exclusiva del panel de administración.', 403);
