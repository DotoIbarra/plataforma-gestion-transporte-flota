<?php
/**
 * Inserta una notificación interna para el panel de administración.
 * No requiere sesión de admin: la llaman endpoints del CONDUCTOR (estado.php,
 * save.php, conductor_incidencias/save.php) cuando pasa algo que el
 * admin/operador debería ver sin tener que estar revisando cada módulo.
 */
function notify(string $tipo, string $mensaje, ?string $entidad = null, ?int $entidadId = null): void {
    try {
        $stmt = db()->prepare(
            'INSERT INTO notificaciones (tipo, mensaje, entidad, entidad_id) VALUES (?, ?, ?, ?)'
        );
        $stmt->bind_param('sssi', $tipo, $mensaje, $entidad, $entidadId);
        $stmt->execute();
        $stmt->close();
    } catch (Throwable $e) {
        // Una notificación que falla nunca debe tumbar la acción real
        // (cambiar un estado, reportar una incidencia, etc.).
        error_log('notify() falló: ' . $e->getMessage());
    }
}
