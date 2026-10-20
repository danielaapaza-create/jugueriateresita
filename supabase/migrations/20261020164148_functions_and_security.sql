-- =============================================================================
-- Juguería Teresita · Funciones de negocio
-- Toda la lógica que cambia pedidos vive aquí, dentro de transacciones.
-- Los errores de negocio se lanzan con mensajes en MAYÚSCULAS (ORDERS_PAUSED,
-- PRODUCT_UNAVAILABLE, ...) para que el bot pueda reconocerlos.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ¿El usuario autenticado es administrador?
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admins a where a.user_id = (select auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- Transiciones de estado permitidas (solo la dueña cambia estados).
-- ---------------------------------------------------------------------------
create or replace function public.order_transition_allowed(
  p_from public.order_status,
  p_to   public.order_status
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'pending'   then p_to in ('confirmed', 'cancelled')
    when 'confirmed' then p_to in ('preparing', 'ready', 'cancelled')
    when 'preparing' then p_to in ('ready', 'cancelled')
    when 'ready'     then p_to in ('delivered', 'cancelled')
    else false -- delivered y cancelled son estados finales
  end;
$$;

-- ---------------------------------------------------------------------------
-- Deduplicación de mensajes de WhatsApp.
-- Devuelve true si este proceso "reclama" el mensaje y debe procesarlo.
-- Un mensaje se puede reintentar si falló o quedó colgado más de 2 minutos,
-- hasta 3 intentos en total.
-- ---------------------------------------------------------------------------
create or replace function public.claim_message(p_message_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.processed_messages as pm (wa_message_id, status)
  values (p_message_id, 'processing')
  on conflict (wa_message_id) do update
     set status = 'processing',
         attempts = pm.attempts + 1,
         last_error = null,
         updated_at = now()
   where pm.attempts < 3
     and (pm.status = 'failed'
          or (pm.status = 'processing' and pm.updated_at < now() - interval '2 minutes'));
  return found;
end;
$$;

create or replace function public.finish_message(
  p_message_id text,
  p_status     text,
  p_error      text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.processed_messages
     set status = p_status,
         last_error = left(p_error, 300),
         updated_at = now()
   where wa_message_id = p_message_id;
$$;

-- Limpieza opcional (ver docs): borra registros de deduplicación antiguos.
create or replace function public.purge_old_processed_messages()
returns integer
language sql
security definer
set search_path = ''
as $$
  with d as (
    delete from public.processed_messages
     where received_at < now() - interval '30 days'
    returning 1
  )
  select count(*)::integer from d;
$$;

-- ---------------------------------------------------------------------------
-- Guardar sesión con bloqueo optimista.
-- p_expected_version = null  -> sesión nueva
-- Devuelve la nueva versión, o null si otro mensaje la modificó antes.
-- ---------------------------------------------------------------------------
create or replace function public.bot_save_session(
  p_wa_id            text,
  p_state            text,
  p_context          jsonb,
  p_cart             jsonb,
  p_profile          jsonb,
  p_expected_version integer,
  p_inbound_at       timestamptz
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version integer;
begin
  if p_expected_version is null then
    insert into public.customer_sessions
      (wa_id, state, context, cart, profile, version, last_inbound_at)
    values
      (p_wa_id, p_state, p_context, p_cart, p_profile, 1, p_inbound_at)
    on conflict (wa_id) do nothing
    returning version into v_version;
  else
    update public.customer_sessions s
       set state = p_state,
           context = p_context,
           cart = p_cart,
           profile = p_profile,
           version = s.version + 1,
           last_inbound_at = greatest(s.last_inbound_at, p_inbound_at),
           updated_at = now()
     where s.wa_id = p_wa_id
       and s.version = p_expected_version
    returning s.version into v_version;
  end if;
  return v_version;
end;
$$;

-- ---------------------------------------------------------------------------
-- Crear pedido (lo llama solo el bot con la service role).
-- * Recalcula precios desde products (nunca confía en precios del cliente).
-- * Guarda nombre y precio de cada producto en order_items.
-- * Valida disponibilidad bloqueando las filas de products.
-- * Idempotente por p_idempotency_key.
-- ---------------------------------------------------------------------------
create or replace function public.create_order(
  p_wa_id           text,
  p_customer_name   text,
  p_contact_phone   text,
  p_delivery_method public.delivery_method,
  p_stall           text,
  p_items           jsonb,
  p_idempotency_key text
)
returns table (
  order_id     uuid,
  order_number bigint,
  status       public.order_status,
  total_cents  integer,
  created      boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_settings public.business_settings;
  v_order    public.orders;
  v_req      jsonb;
  v_total    bigint;
  v_open     integer;
  v_bad      text;
  v_stall    text := nullif(btrim(coalesce(p_stall, '')), '');
begin
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 200 then
    raise exception 'INVALID_IDEMPOTENCY_KEY';
  end if;

  -- 1) ¿Ya existe? (doble toque en "Confirmar" o webhook repetido)
  select * into v_order from public.orders o where o.idempotency_key = p_idempotency_key;
  if found then
    if v_order.customer_wa_id <> p_wa_id then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return query select v_order.id, v_order.order_number, v_order.status, v_order.total_cents, false;
    return;
  end if;

  -- 2) Reglas del negocio
  select * into v_settings from public.business_settings bs where bs.id = 1;
  if v_settings.orders_paused then
    raise exception 'ORDERS_PAUSED';
  end if;
  if p_delivery_method = 'delivery' and not v_settings.delivery_enabled then
    raise exception 'DELIVERY_DISABLED';
  end if;
  if p_delivery_method = 'delivery' and v_stall is null then
    raise exception 'STALL_REQUIRED';
  end if;
  if p_delivery_method = 'pickup' then
    v_stall := null;
  end if;

  select count(*) into v_open
    from public.orders o
   where o.customer_wa_id = p_wa_id
     and o.status in ('pending', 'confirmed', 'preparing')
     and o.created_at > now() - interval '12 hours';
  if v_open >= v_settings.max_open_orders_per_customer then
    raise exception 'TOO_MANY_OPEN_ORDERS';
  end if;

  -- 3) Validar estructura del carrito
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
  end if;
  if jsonb_array_length(p_items) > 15 then
    raise exception 'CART_TOO_LARGE';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) e
     where jsonb_typeof(e) <> 'object'
        or coalesce(e ->> 'product_id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        or jsonb_typeof(e -> 'quantity') is distinct from 'number'
        or (e ->> 'quantity') !~ '^[0-9]{1,3}$'
  ) then
    raise exception 'INVALID_ITEMS';
  end if;

  -- Agrupar por producto (si el mismo producto aparece dos veces se suma).
  select jsonb_agg(jsonb_build_object('product_id', s.product_id, 'quantity', s.qty))
    into v_req
    from (
      select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'quantity')::integer) as qty
        from jsonb_array_elements(p_items) e
       group by 1
    ) s;

  if exists (
    select 1 from jsonb_to_recordset(v_req) r(product_id uuid, quantity integer)
     where r.quantity < 1 or r.quantity > v_settings.max_quantity_per_item
  ) then
    raise exception 'INVALID_QUANTITY';
  end if;

  -- 4) Bloquear productos y validar disponibilidad
  perform 1
     from public.products p
    where p.id in (select r.product_id from jsonb_to_recordset(v_req) r(product_id uuid, quantity integer))
    for share;

  select string_agg(coalesce(p.name, 'desconocido'), ', ')
    into v_bad
    from jsonb_to_recordset(v_req) r(product_id uuid, quantity integer)
    left join public.products p on p.id = r.product_id
   where p.id is null or not p.is_active or not p.is_available;
  if v_bad is not null then
    raise exception 'PRODUCT_UNAVAILABLE' using detail = v_bad;
  end if;

  -- 5) Total calculado en el servidor
  select sum(p.price_cents::bigint * r.quantity)
    into v_total
    from jsonb_to_recordset(v_req) r(product_id uuid, quantity integer)
    join public.products p on p.id = r.product_id;

  -- 6) Insertar pedido (si otra transacción ganó con la misma clave, devolverla)
  insert into public.orders
    (customer_wa_id, customer_name, contact_phone, delivery_method, stall,
     status, total_cents, idempotency_key)
  values
    (p_wa_id, btrim(p_customer_name), p_contact_phone, p_delivery_method, v_stall,
     'pending', v_total::integer, p_idempotency_key)
  on conflict (idempotency_key) do nothing
  returning * into v_order;

  if not found then
    select * into v_order from public.orders o where o.idempotency_key = p_idempotency_key;
    if v_order.customer_wa_id <> p_wa_id then
      raise exception 'IDEMPOTENCY_CONFLICT';
    end if;
    return query select v_order.id, v_order.order_number, v_order.status, v_order.total_cents, false;
    return;
  end if;

  insert into public.order_items (order_id, product_id, product_name, unit_price_cents, quantity)
  select v_order.id, p.id, p.name, p.price_cents, r.quantity
    from jsonb_to_recordset(v_req) r(product_id uuid, quantity integer)
    join public.products p on p.id = r.product_id;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (v_order.id, null, 'pending', 'bot', 'Pedido recibido por WhatsApp');

  -- Política automática explícita (desactivada por defecto)
  if v_settings.auto_accept_orders then
    update public.orders o
       set status = 'confirmed', confirmed_at = now()
     where o.id = v_order.id
    returning * into v_order;
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
    values (v_order.id, 'pending', 'confirmed', 'bot', 'Aceptación automática configurada');
  end if;

  return query select v_order.id, v_order.order_number, v_order.status, v_order.total_cents, true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Consultas del cliente: SIEMPRE filtradas por el número de WhatsApp que
-- escribe. Si el pedido es de otra persona se responde igual que si no existe.
-- ---------------------------------------------------------------------------
create or replace function public.get_customer_orders(p_wa_id text, p_limit integer default 5)
returns table (
  order_number    bigint,
  status          public.order_status,
  total_cents     integer,
  delivery_method public.delivery_method,
  created_at      timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.order_number, o.status, o.total_cents, o.delivery_method, o.created_at
    from public.orders o
   where o.customer_wa_id = p_wa_id
     and o.created_at > now() - interval '3 days'
   order by o.created_at desc
   limit least(greatest(coalesce(p_limit, 5), 1), 9);
$$;

create or replace function public.get_customer_order(p_wa_id text, p_order_number bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'order_number', o.order_number,
           'status', o.status,
           'total_cents', o.total_cents,
           'delivery_method', o.delivery_method,
           'stall', o.stall,
           'customer_name', o.customer_name,
           'created_at', o.created_at,
           'cancel_reason', o.cancel_reason,
           'items', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'product_name', i.product_name,
                      'quantity', i.quantity,
                      'unit_price_cents', i.unit_price_cents,
                      'line_total_cents', i.line_total_cents
                    ) order by i.product_name)
               from public.order_items i
              where i.order_id = o.id
           ), '[]'::jsonb)
         )
    from public.orders o
   where o.customer_wa_id = p_wa_id
     and o.order_number = p_order_number;
$$;

-- ---------------------------------------------------------------------------
-- Anulación por el cliente (según reglas configuradas).
-- Resultado: 'cancelled' | 'already_cancelled' | 'not_found' | 'not_allowed'
-- ---------------------------------------------------------------------------
create or replace function public.customer_cancel_order(p_wa_id text, p_order_number bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   public.orders;
  v_allowed boolean;
begin
  select * into v_order
    from public.orders o
   where o.order_number = p_order_number
     and o.customer_wa_id = p_wa_id
   for update;

  if not found then
    return 'not_found';
  end if;
  if v_order.status = 'cancelled' then
    return 'already_cancelled';
  end if;

  select v_order.status = 'pending'
         or (v_order.status = 'confirmed' and bs.customer_can_cancel_confirmed)
    into v_allowed
    from public.business_settings bs
   where bs.id = 1;

  if not v_allowed then
    return 'not_allowed';
  end if;

  update public.orders o
     set status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = 'customer',
         cancel_reason = 'Anulado por el cliente desde WhatsApp'
   where o.id = v_order.id;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (v_order.id, v_order.status, 'cancelled', 'customer', 'Anulado desde WhatsApp');

  return 'cancelled';
end;
$$;

-- ---------------------------------------------------------------------------
-- Cambio de estado por la dueña (panel). Valida admin y transición.
-- Devuelve los datos necesarios para notificar al cliente por WhatsApp.
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_order_status(
  p_order_id uuid,
  p_status   public.order_status,
  p_note     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order   public.orders;
  v_from    public.order_status;
  v_inbound timestamptz;
  v_note    text := nullif(btrim(left(coalesce(p_note, ''), 200)), '');
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;

  select * into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'ORDER_NOT_FOUND';
  end if;

  if not public.order_transition_allowed(v_order.status, p_status) then
    raise exception 'INVALID_TRANSITION' using detail = v_order.status::text || ' -> ' || p_status::text;
  end if;
  v_from := v_order.status;

  update public.orders o
     set status        = p_status,
         confirmed_at  = case when p_status = 'confirmed' then now() else o.confirmed_at end,
         ready_at      = case when p_status = 'ready'     then now() else o.ready_at end,
         delivered_at  = case when p_status = 'delivered' then now() else o.delivered_at end,
         cancelled_at  = case when p_status = 'cancelled' then now() else o.cancelled_at end,
         cancelled_by  = case when p_status = 'cancelled' then 'admin' else o.cancelled_by end,
         cancel_reason = case when p_status = 'cancelled' then v_note else o.cancel_reason end
   where o.id = p_order_id
  returning * into v_order;

  insert into public.order_status_history (order_id, from_status, to_status, changed_by, note)
  values (p_order_id, v_from, p_status, (select auth.uid())::text, v_note);

  select s.last_inbound_at into v_inbound
    from public.customer_sessions s
   where s.wa_id = v_order.customer_wa_id;

  return jsonb_build_object(
    'order_id', v_order.id,
    'order_number', v_order.order_number,
    'status', v_order.status,
    'customer_wa_id', v_order.customer_wa_id,
    'customer_name', v_order.customer_name,
    'delivery_method', v_order.delivery_method,
    'cancel_reason', v_order.cancel_reason,
    'last_inbound_at', v_inbound
  );
end;
$$;

-- Registro del resultado de la notificación (para avisar en el panel si falló).
create or replace function public.admin_record_notification(
  p_order_id uuid,
  p_status   public.order_status,
  p_error    text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  update public.orders o
     set last_notified_status = case when p_error is null then p_status else o.last_notified_status end,
         last_notification_error = left(p_error, 300)
   where o.id = p_order_id;
end;
$$;

-- =============================================================================
-- Seguridad (en la misma migración: las funciones nunca quedan expuestas)
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
