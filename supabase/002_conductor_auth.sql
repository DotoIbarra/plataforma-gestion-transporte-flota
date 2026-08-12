-- ==========================================================================
-- MIGRACIÓN: cuentas de conductores (teléfono + contraseña) y aislamiento
-- de "rutas" por conductor, sin tocar el acceso del panel web (admin).
-- ==========================================================================
-- Ejecutar en Supabase → SQL Editor, sobre el MISMO proyecto/base que ya
-- usa la app web (schema.sql). Es seguro re-ejecutarlo.
--
-- Cómo queda el modelo de acceso después de esto:
--  · El panel web (index.html, tal como está hoy) NO inicia sesión: sigue
--    usando solo la anon key. Ante Postgres eso siempre es el rol "anon".
--    Sus políticas ahora son EXCLUSIVAS para "anon" y no cambian en nada
--    lo que el panel puede hacer: sigue viendo y editando todo.
--  · La app de conductores SÍ inicia sesión con Supabase Auth (rol
--    "authenticated" ante Postgres). Sus políticas son nuevas y limitan
--    cada conductor a sus propias rutas (columna rutas."conductorAuthId").
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1) Columnas nuevas: vínculo entre auth.users y las tablas de negocio
-- --------------------------------------------------------------------------
alter table public.conductores
  add column if not exists "authUserId" uuid unique references auth.users(id) on delete set null;

alter table public.rutas
  add column if not exists "conductorAuthId" uuid references auth.users(id) on delete set null;

create index if not exists rutas_conductor_auth_idx on public.rutas ("conductorAuthId");

-- Límites razonables en los campos de texto que llena el conductor desde el
-- celular (defensa adicional además de la que hace el cliente en JS).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'rutas_origen_len') then
    alter table public.rutas add constraint rutas_origen_len check (char_length(coalesce(origen,'')) <= 200) not valid;
    alter table public.rutas validate constraint rutas_origen_len;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rutas_destino_len') then
    alter table public.rutas add constraint rutas_destino_len check (char_length(coalesce(destino,'')) <= 200) not valid;
    alter table public.rutas validate constraint rutas_destino_len;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'rutas_observ_len') then
    alter table public.rutas add constraint rutas_observ_len check (char_length(coalesce(observaciones,'')) <= 2000) not valid;
    alter table public.rutas validate constraint rutas_observ_len;
  end if;
end $$;

-- --------------------------------------------------------------------------
-- 1.1) "nro" en rutas pasa a poder autoasignarse desde la base de datos.
--      Hasta ahora el panel web elegía el próximo nro en el navegador
--      (max(nro)+1). Eso funcionaba porque solo el panel escribía en la
--      tabla. Ahora que varios conductores pueden crear rutas al mismo
--      tiempo (y cada uno solo ve las suyas, no puede calcular el máximo
--      global), el número de ruta nuevo lo entrega Postgres de forma
--      atómica, así nunca chocan dos rutas con el mismo nro.
--      El panel web sigue pudiendo enviar su propio nro si quiere (por
--      ejemplo al restaurar desde la papelera); esto solo agrega un valor
--      por defecto para cuando no se envía ninguno.
-- --------------------------------------------------------------------------
create sequence if not exists public.rutas_nro_seq;
select setval(
  'public.rutas_nro_seq',
  greatest(coalesce((select max(nro) from public.rutas), 0), 1),
  true
);
alter table public.rutas alter column nro set default nextval('public.rutas_nro_seq');
alter sequence public.rutas_nro_seq owned by public.rutas.nro;

-- Mismo resguardo para "conductores": dos personas registrándose en el
-- mismo instante ya no pueden terminar con el mismo nro.
create sequence if not exists public.conductores_nro_seq;
select setval(
  'public.conductores_nro_seq',
  greatest(coalesce((select max(nro) from public.conductores), 0), 1),
  true
);
alter table public.conductores alter column nro set default nextval('public.conductores_nro_seq');
alter sequence public.conductores_nro_seq owned by public.conductores.nro;

-- --------------------------------------------------------------------------
-- 2) Al crearse una cuenta nueva (auth.users), crear o vincular
--    automáticamente su fila en "conductores" a partir del teléfono.
--    SECURITY DEFINER: corre con privilegios de dueño de la función, así
--    el conductor nunca necesita permiso directo de INSERT en "conductores".
-- --------------------------------------------------------------------------
create or replace function public.handle_new_driver()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_telefono text := new.raw_user_meta_data ->> 'telefono';
  v_nombres  text := coalesce(new.raw_user_meta_data ->> 'nombres', '');
  v_apellidos text := coalesce(new.raw_user_meta_data ->> 'apellidos', '');
  v_existing_nro integer;
begin
  if v_telefono is null or v_telefono = '' then
    return new; -- cuenta creada sin metadata de teléfono (no debería pasar desde la app)
  end if;

  -- ¿Ya existe un conductor con ese teléfono cargado desde el panel web,
  -- pero todavía sin cuenta vinculada? Se vincula en vez de duplicar.
  select nro into v_existing_nro
  from public.conductores
  where telefono = v_telefono and "authUserId" is null
  limit 1;

  if v_existing_nro is not null then
    update public.conductores
      set "authUserId" = new.id,
          nombres   = case when nombres = '' or nombres is null then v_nombres else nombres end,
          apellidos = case when apellidos = '' or apellidos is null then v_apellidos else apellidos end
      where nro = v_existing_nro;
  else
    insert into public.conductores (telefono, nombres, apellidos, "authUserId")
    values (v_telefono, v_nombres, v_apellidos, new.id);
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_driver on auth.users;
create trigger on_auth_user_created_driver
  after insert on auth.users
  for each row execute function public.handle_new_driver();

-- --------------------------------------------------------------------------
-- 3) Al guardar una ruta nueva desde la app de conductor, completar sola
--    la columna "conductorAuthId" con quien está autenticado (el conductor
--    no puede escribir ahí un uuid ajeno aunque lo intente manualmente).
-- --------------------------------------------------------------------------
create or replace function public.set_ruta_conductor_auth_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() = 'authenticated' then
    new."conductorAuthId" := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_ruta_conductor_auth_id on public.rutas;
create trigger trg_set_ruta_conductor_auth_id
  before insert on public.rutas
  for each row execute function public.set_ruta_conductor_auth_id();

-- --------------------------------------------------------------------------
-- 4) RLS: separar las políticas "públicas" (panel web, anon) de las nuevas
--    políticas "por conductor" (app de conductores, authenticated).
-- --------------------------------------------------------------------------

-- 4.1 Las políticas públicas existentes pasan a aplicar SOLO al rol anon
--     (antes decían "to anon, authenticated" en todas las tablas).
do $$
declare
  t text;
begin
  for t in select unnest(array[
    'flota','seguros','impuestos','conductores','talleres',
    'rutas','multas','mantenimiento','fletes','app_storage'
  ]) loop
    execute format('drop policy if exists "Público puede leer" on public.%I', t);
    execute format('create policy "Público puede leer" on public.%I for select to anon using (true)', t);

    execute format('drop policy if exists "Público puede insertar" on public.%I', t);
    execute format('create policy "Público puede insertar" on public.%I for insert to anon with check (true)', t);

    execute format('drop policy if exists "Público puede actualizar" on public.%I', t);
    execute format('create policy "Público puede actualizar" on public.%I for update to anon using (true) with check (true)', t);

    execute format('drop policy if exists "Público puede borrar" on public.%I', t);
    execute format('create policy "Público puede borrar" on public.%I for delete to anon using (true)', t);
  end loop;
end $$;

-- 4.2 rutas: cada conductor autenticado solo ve/crea/edita/borra las suyas.
drop policy if exists "Conductor lee sus rutas" on public.rutas;
create policy "Conductor lee sus rutas" on public.rutas
  for select to authenticated
  using ("conductorAuthId" = auth.uid());

drop policy if exists "Conductor crea sus rutas" on public.rutas;
create policy "Conductor crea sus rutas" on public.rutas
  for insert to authenticated
  with check (true); -- el valor real lo fuerza el trigger set_ruta_conductor_auth_id

drop policy if exists "Conductor edita sus rutas" on public.rutas;
create policy "Conductor edita sus rutas" on public.rutas
  for update to authenticated
  using ("conductorAuthId" = auth.uid())
  with check ("conductorAuthId" = auth.uid());

drop policy if exists "Conductor borra sus rutas" on public.rutas;
create policy "Conductor borra sus rutas" on public.rutas
  for delete to authenticated
  using ("conductorAuthId" = auth.uid());

-- 4.3 conductores: cada conductor autenticado solo ve/edita su propia ficha
--     (nombre, licencia, teléfono, etc.), nunca la de otros. No puede
--     borrar ni crear filas directamente (eso lo hace el trigger de arriba).
drop policy if exists "Conductor lee su ficha" on public.conductores;
create policy "Conductor lee su ficha" on public.conductores
  for select to authenticated
  using ("authUserId" = auth.uid());

drop policy if exists "Conductor edita su ficha" on public.conductores;
create policy "Conductor edita su ficha" on public.conductores
  for update to authenticated
  using ("authUserId" = auth.uid())
  with check ("authUserId" = auth.uid());

-- 4.4 flota: el conductor necesita leerla (para elegir placa al crear una
--     ruta), pero no editarla.
drop policy if exists "Conductor lee flota" on public.flota;
create policy "Conductor lee flota" on public.flota
  for select to authenticated using (true);

-- 4.5 app_storage: el conductor solo puede leer el catálogo de "estados de
--     vehículo" (el desplegable Estado del formulario de ruta), nada más
--     de esa tabla (ni papelera ni historial de otros).
drop policy if exists "Conductor lee catalogo estados" on public.app_storage;
create policy "Conductor lee catalogo estados" on public.app_storage
  for select to authenticated
  using (key = 'flota_catalogos_v1');

-- --------------------------------------------------------------------------
-- 5) Realtime: para que el panel web muestre al instante las rutas que
--    crea/edita/borra un conductor desde su app (sin recargar la página).
-- --------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rutas'
  ) then
    alter publication supabase_realtime add table public.rutas;
  end if;
end $$;

-- ==========================================================================
-- IMPORTANTE — configurar también en el Dashboard de Supabase:
--
-- Authentication → Providers → Email:
--   • Mantener "Email" habilitado (se usa un correo interno derivado del
--     teléfono, el conductor nunca lo ve ni lo escribe).
--   • Desactivar "Confirm email" (Enable email confirmations = OFF), porque
--     ese correo interno no existe de verdad y nunca podría confirmarse.
--
-- Authentication → Policies / Settings → Password:
--   • Password minimum length: 8 (o más).
--
-- Authentication → Rate Limits:
--   • Dejar los límites por defecto de Supabase para sign-up / sign-in:
--     ya protegen contra fuerza bruta e intentos masivos de registro.
-- ==========================================================================
