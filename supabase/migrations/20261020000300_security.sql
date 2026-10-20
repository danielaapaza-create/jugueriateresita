-- =============================================================================
-- Juguería Teresita · Seguridad (RLS y permisos)
--
-- Quién accede a qué:
--   * anon (cualquiera con la clave pública): NADA.
--   * authenticated (usuarios con sesión): solo si están en public.admins.
--       - leen pedidos y detalle
--       - gestionan productos y configuración
--       - cambian estados SOLO con admin_set_order_status (valida transiciones)
--   * service_role (solo Edge Functions del servidor): bot y pedidos.
-- =============================================================================

-- RLS en todas las tablas
alter table public.admins               enable row level security;
alter table public.business_settings    enable row level security;
alter table public.products             enable row level security;
alter table public.orders               enable row level security;
alter table public.order_items          enable row level security;
alter table public.order_status_history enable row level security;
alter table public.customer_sessions    enable row level security;
alter table public.processed_messages   enable row level security;

-- ---------------------------------------------------------------------------
-- Privilegios de tabla: se quita todo a anon/authenticated y se concede lo justo
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select                 on public.admins               to authenticated;
grant select, update         on public.business_settings    to authenticated;
grant select, insert, update on public.products             to authenticated;
grant select                 on public.orders               to authenticated;
grant select                 on public.order_items          to authenticated;
grant select                 on public.order_status_history to authenticated;
-- customer_sessions y processed_messages: solo service_role.

-- ---------------------------------------------------------------------------
-- Políticas
-- ---------------------------------------------------------------------------
create policy "admins: ver su propia fila"
  on public.admins for select to authenticated
  using (user_id = (select auth.uid()));

create policy "settings: admins leen"
  on public.business_settings for select to authenticated
  using ((select public.is_admin()));

create policy "settings: admins actualizan"
  on public.business_settings for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "products: admins leen"
  on public.products for select to authenticated
  using ((select public.is_admin()));

create policy "products: admins crean"
  on public.products for insert to authenticated
  with check ((select public.is_admin()));

create policy "products: admins actualizan"
  on public.products for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "orders: admins leen"
  on public.orders for select to authenticated
  using ((select public.is_admin()));

create policy "order_items: admins leen"
  on public.order_items for select to authenticated
  using ((select public.is_admin()));

create policy "history: admins leen"
  on public.order_status_history for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Funciones: nadie ejecuta nada salvo lo concedido explícitamente.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

-- Panel (usuarios autenticados; cada función vuelve a validar is_admin())
grant execute on function public.is_admin() to authenticated;
grant execute on function public.admin_set_order_status(uuid, public.order_status, text) to authenticated;
grant execute on function public.admin_record_notification(uuid, public.order_status, text) to authenticated;

-- Bot (solo el servidor)
grant execute on function public.claim_message(text) to service_role;
grant execute on function public.finish_message(text, text, text) to service_role;
grant execute on function public.purge_old_processed_messages() to service_role;
grant execute on function public.bot_save_session(text, text, jsonb, jsonb, jsonb, integer, timestamptz) to service_role;
grant execute on function public.create_order(text, text, text, public.delivery_method, text, jsonb, text) to service_role;
grant execute on function public.get_customer_orders(text, integer) to service_role;
grant execute on function public.get_customer_order(text, bigint) to service_role;
grant execute on function public.customer_cancel_order(text, bigint) to service_role;

-- Evitar que funciones futuras queden abiertas por defecto
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: el panel recibe pedidos nuevos al instante (respeta RLS).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.orders;
  end if;
end;
$$;
