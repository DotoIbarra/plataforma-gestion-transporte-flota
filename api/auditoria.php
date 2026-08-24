<?php
require_once __DIR__ . '/config.php';

/**
 * Deja constancia en la tabla `auditoria` de quién hizo qué. A diferencia
 * de `notify()` (que solo avisa a los administradores en la campanita),
 * esto queda guardado para siempre y alimenta el panel "Auditoría" del
 * admin, con el actor real (admin/operador logueado, o conductor) —
 * nunca lo que mande el navegador, siempre uno ya resuelto en el backend.
 *
 * Nunca debe tumbar la acción real si falla (igual criterio que notify()).
 */
function audit(string $actorTipo, string $actorNombre, string $accion, string $entidad, ?int $entidadId = null, ?string $detalle = null): void {
    try {
        $stmt = db()->prepare(
            'INSERT INTO auditoria (actor_tipo, actor_nombre, accion, entidad, entidad_id, detalle) VALUES (?, ?, ?, ?, ?, ?)'
        );
        $stmt->bind_param('sssiss', $actorTipo, $actorNombre, $accion, $entidad, $entidadId, $detalle);
        $stmt->execute();
        $stmt->close();
    } catch (Throwable $e) {
        error_log('audit() falló: ' . $e->getMessage());
    }
}
