-- ==========================================================================
-- CONTROL DE FLOTA VEHICULAR — Esquema Supabase (PostgreSQL)
-- ==========================================================================
-- Diseño: la app original guarda 4 bloques de datos en localStorage
-- (flota_data_v1, flota_catalogos_v1, flota_trash_v1, flota_log_v1), cada
-- uno como un único blob JSON. Para migrar con cambios mínimos en el
-- frontend (sin tocar la lógica ni la estructura de DB/CAT/TRASH/LOG en
-- app.js), se usa una tabla clave-valor con columna JSONB que reemplaza
-- 1 a 1 esas 4 claves de localStorage por 4 filas en PostgreSQL.
-- ==========================================================================

create table if not exists public.app_storage (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table public.app_storage is
  'Almacenamiento clave-valor de la app Control de Flota. Cada fila reemplaza una clave de localStorage (flota_data_v1, flota_catalogos_v1, flota_trash_v1, flota_log_v1).';

-- Fila inicial vacía (opcional; la app también las crea sola en el primer uso)
insert into public.app_storage (key, value) values
  ('flota_data_v1', '{
    "flota": [], "seguros": [], "impuestos": [], "conductores": [],
    "talleres": [], "rutas": [], "multas": [], "mantenimiento": [], "fletes": []
  }'::jsonb),
  ('flota_catalogos_v1', '{}'::jsonb),
  ('flota_trash_v1', '{}'::jsonb),
  ('flota_log_v1', '[]'::jsonb)
on conflict (key) do nothing;

-- ==========================================================================
-- ROW LEVEL SECURITY — acceso público sin autenticación
-- ==========================================================================
-- La app no implementa login: cualquier visitante con la anon key debe
-- poder leer y escribir. Se habilita RLS y se otorga acceso total al rol
-- "anon" (y "authenticated", por si en el futuro se agrega login).

alter table public.app_storage enable row level security;

drop policy if exists "Público puede leer" on public.app_storage;
create policy "Público puede leer"
  on public.app_storage for select
  to anon, authenticated
  using (true);

drop policy if exists "Público puede insertar" on public.app_storage;
create policy "Público puede insertar"
  on public.app_storage for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Público puede actualizar" on public.app_storage;
create policy "Público puede actualizar"
  on public.app_storage for update
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Público puede borrar" on public.app_storage;
create policy "Público puede borrar"
  on public.app_storage for delete
  to anon, authenticated
  using (true);
