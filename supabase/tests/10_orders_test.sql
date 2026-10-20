-- Pruebas de lógica de pedidos, seguridad y deduplicación.
-- Se ejecutan con ./scripts/test-sql.sh sobre una base temporal.
\set ON_ERROR_STOP 1

-- ---------------------------------------------------------------------------
-- Ayudantes de prueba
-- ---------------------------------------------------------------------------
create schema test;
grant usage on schema test to anon, authenticated, service_role;

create function test.expect_error(p_sql text, p_pattern text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'Se esperaba error "%" y no hubo error: %', p_pattern, p_sql;
exception when others then
  if sqlerrm like 'Se esperaba error%' then raise; end if;
  if sqlerrm !~ p_pattern then
    raise exception 'Error inesperado. Esperado ~ "%", obtenido "%" en: %', p_pattern, sqlerrm, p_sql;
  end if;
end $$;

create function test.eq(p_actual anyelement, p_expected anyelement, p_msg text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FALLÓ: % (esperado %, obtenido %)', p_msg, p_expected, p_actual;
  end if;
end $$;
grant execute on all functions in schema test to anon, authenticated, service_role;

-- Datos de prueba (solo para este test)
insert into public.products (id, category, name, price_cents, is_available, is_active) values
  ('00000000-0000-0000-0000-00000000000a', 'jugos',     'Jugo prueba A',  350, true,  true),
  ('00000000-0000-0000-0000-00000000000b', 'desayunos', 'Desayuno prueba B', 500, true, true),
  ('00000000-0000-0000-0000-00000000000c', 'extras',    'Extra agotado C', 100, false, true),
  ('00000000-0000-0000-0000-00000000000d', 'extras',    'Extra archivado D', 100, true, false);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'duena@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'intruso@example.com');
insert into public.admins (user_id) values ('11111111-1111-1111-1111-111111111111');

-- ---------------------------------------------------------------------------
-- 1. Creación de pedidos (como service_role, igual que el bot)
-- ---------------------------------------------------------------------------
set role service_role;

do $$
declare r record; v_items integer; v_snapshot integer;
begin
  -- El producto A aparece dos veces: se agrupa (2 + 1 = 3)
  select * into r from public.create_order('51911111111', 'Rosa', '51911111111', 'pickup', 'ignorado',
    '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":2},
      {"product_id":"00000000-0000-0000-0000-00000000000b","quantity":1},
      {"product_id":"00000000-0000-0000-0000-00000000000a","quantity":1}]', 'checkout:test-0001');
  perform test.eq(r.created, true, 'pedido nuevo');
  perform test.eq(r.status, 'pending'::public.order_status, 'estado inicial = pendiente (recibido)');
  perform test.eq(r.total_cents, 3 * 350 + 500, 'total calculado en el servidor');
  select count(*) into v_items from public.order_items where order_id = r.order_id;
  perform test.eq(v_items, 2, 'dos líneas agrupadas');
  perform test.eq((select stall from public.orders where id = r.order_id), null::text, 'recojo no guarda puesto');

  -- Idempotencia: misma clave -> mismo pedido, no se duplica
  select * into r from public.create_order('51911111111', 'Rosa', '51911111111', 'pickup', null,
    '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":9}]', 'checkout:test-0001');
  perform test.eq(r.created, false, 'segunda confirmación no crea otro pedido');
  perform test.eq((select count(*)::int from public.orders), 1, 'solo un pedido');

  -- Snapshot del precio: cambiar el precio no altera pedidos existentes
  update public.products set price_cents = 999 where id = '00000000-0000-0000-0000-00000000000a';
  select unit_price_cents into v_snapshot from public.order_items
   where product_id = '00000000-0000-0000-0000-00000000000a';
  perform test.eq(v_snapshot, 350, 'precio histórico conservado');
  update public.products set price_cents = 350 where id = '00000000-0000-0000-0000-00000000000a';
end $$;

select test.expect_error($q$ select public.create_order('51922222222','Otro','51922222222','pickup',null,
  '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":1}]','checkout:test-0001') $q$,
  'IDEMPOTENCY_CONFLICT');

select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,
  '[{"product_id":"00000000-0000-0000-0000-00000000000c","quantity":1}]','checkout:test-0002') $q$,
  'PRODUCT_UNAVAILABLE');
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,
  '[{"product_id":"00000000-0000-0000-0000-00000000000d","quantity":1}]','checkout:test-0003') $q$,
  'PRODUCT_UNAVAILABLE');
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,
  '[{"product_id":"00000000-0000-0000-0000-0000000000ff","quantity":1}]','checkout:test-0004') $q$,
  'PRODUCT_UNAVAILABLE');
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,
  '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":0}]','checkout:test-0005') $q$,
  'INVALID_QUANTITY');
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,
  '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":21}]','checkout:test-0006') $q$,
  'INVALID_QUANTITY');
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,
  '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":-1}]','checkout:test-0007') $q$,
  'INVALID_ITEMS');
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,
  '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":"2"}]','checkout:test-0008') $q$,
  'INVALID_ITEMS');
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,
  '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":1.5}]','checkout:test-0009') $q$,
  'INVALID_ITEMS');
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,
  '[]','checkout:test-0010') $q$, 'EMPTY_CART');
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','delivery','  ',
  '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":1}]','checkout:test-0011') $q$,
  'STALL_REQUIRED');
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,
  '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":1}]','x') $q$,
  'INVALID_IDEMPOTENCY_KEY');

reset role;

-- Pausa de pedidos y entrega deshabilitada
update public.business_settings set orders_paused = true;
set role service_role;
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,
  '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":1}]','checkout:test-0012') $q$,
  'ORDERS_PAUSED');
reset role;
update public.business_settings set orders_paused = false, delivery_enabled = false;
set role service_role;
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','delivery','Puesto 4',
  '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":1}]','checkout:test-0013') $q$,
  'DELIVERY_DISABLED');
reset role;
update public.business_settings set delivery_enabled = true;

-- Límite de pedidos abiertos por cliente (por defecto 3)
set role service_role;
do $$
declare r record;
begin
  select * into r from public.create_order('51911111111','Rosa','51911111111','delivery','Puesto 45',
    '[{"product_id":"00000000-0000-0000-0000-00000000000b","quantity":1}]','checkout:test-0014');
  perform test.eq((select stall from public.orders where id = r.order_id), 'Puesto 45', 'entrega guarda puesto');
  perform public.create_order('51911111111','Rosa','51911111111','pickup',null,
    '[{"product_id":"00000000-0000-0000-0000-00000000000b","quantity":1}]','checkout:test-0015');
end $$;
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,
  '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":1}]','checkout:test-0016') $q$,
  'TOO_MANY_OPEN_ORDERS');

-- ---------------------------------------------------------------------------
-- 2. Privacidad: nadie consulta ni anula pedidos ajenos
-- ---------------------------------------------------------------------------
do $$
declare v_num bigint;
begin
  select order_number into v_num from public.orders where idempotency_key = 'checkout:test-0001';
  perform test.eq(public.get_customer_order('51922222222', v_num), null::jsonb, 'pedido ajeno = no existe');
  perform test.eq((public.get_customer_order('51911111111', v_num) ->> 'total_cents')::int, 1550, 'dueño ve su pedido');
  perform test.eq((select count(*)::int from public.get_customer_orders('51922222222', 5)), 0, 'lista ajena vacía');
  perform test.eq((select count(*)::int from public.get_customer_orders('51911111111', 5)), 3, 'lista propia');

  perform test.eq(public.customer_cancel_order('51922222222', v_num), 'not_found', 'no anula pedido ajeno');
  perform test.eq((select status from public.orders where order_number = v_num), 'pending'::public.order_status, 'sigue pendiente');
  perform test.eq(public.customer_cancel_order('51911111111', v_num), 'cancelled', 'dueño anula pendiente');
  perform test.eq(public.customer_cancel_order('51911111111', v_num), 'already_cancelled', 'anular dos veces');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 3. Panel: solo administradores
-- ---------------------------------------------------------------------------
-- anon no ve nada
set role anon;
select test.expect_error('select * from public.products', 'permission denied');
select test.expect_error('select * from public.orders', 'permission denied');
select test.expect_error($q$ select public.claim_message('wamid.x') $q$, 'permission denied');
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,'[]','checkout:anon-1') $q$, 'permission denied');
reset role;

-- usuario autenticado que NO es admin
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select test.eq((select count(*)::int from public.products), 0, 'no-admin no ve productos');
select test.eq((select count(*)::int from public.orders), 0, 'no-admin no ve pedidos');
select test.expect_error($q$ insert into public.products (category, name, price_cents) values ('jugos','Hack',1) $q$, 'row-level security');
select test.expect_error($q$ update public.orders set status = 'delivered' $q$, 'permission denied');
select test.expect_error($q$ select public.admin_set_order_status((select id from public.orders limit 1), 'confirmed') $q$, 'NOT_AUTHORIZED');
select test.expect_error($q$ select * from public.customer_sessions $q$, 'permission denied');
select test.expect_error($q$ select public.create_order('51911111111','Rosa','51911111111','pickup',null,'[]','checkout:auth-1') $q$, 'permission denied');
select test.expect_error($q$ select public.get_customer_order('51911111111', 1) $q$, 'permission denied');
reset role;

-- administradora
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$
declare v_id uuid; v_res jsonb;
begin
  perform test.eq((select count(*)::int from public.products), 4, 'admin ve productos');
  select id into v_id from public.orders where idempotency_key = 'checkout:test-0014';

  -- Ni siquiera la dueña puede editar la tabla directamente
  perform test.expect_error(format($q$ update public.orders set status = 'ready' where id = %L $q$, v_id), 'permission denied');
  perform test.expect_error(format($q$ delete from public.order_items where order_id = %L $q$, v_id), 'permission denied');

  -- Transición inválida: pendiente -> listo (debe aceptarse primero)
  perform test.expect_error(format($q$ select public.admin_set_order_status(%L, 'ready') $q$, v_id), 'INVALID_TRANSITION');

  v_res := public.admin_set_order_status(v_id, 'confirmed');
  perform test.eq(v_res ->> 'status', 'confirmed', 'aceptado');
  perform test.eq(v_res ->> 'customer_wa_id', '51911111111', 'devuelve destinatario');
  v_res := public.admin_set_order_status(v_id, 'preparing');
  v_res := public.admin_set_order_status(v_id, 'ready');
  v_res := public.admin_set_order_status(v_id, 'delivered');
  perform test.eq((select count(*)::int from public.order_status_history where order_id = v_id), 5, 'historial completo');
  perform test.expect_error(format($q$ select public.admin_set_order_status(%L, 'cancelled') $q$, v_id), 'INVALID_TRANSITION');

  -- Gestión de productos
  update public.products set is_available = false where id = '00000000-0000-0000-0000-00000000000a';
  perform test.eq((select is_available from public.products where id = '00000000-0000-0000-0000-00000000000a'), false, 'marcar agotado');
  update public.products set is_available = true where id = '00000000-0000-0000-0000-00000000000a';
  perform test.expect_error($q$ delete from public.products $q$, 'permission denied');
  perform test.expect_error($q$ update public.products set price_cents = 0 $q$, 'check constraint');

  update public.business_settings set orders_paused = true;
  update public.business_settings set orders_paused = false;
end $$;
reset role;

-- El cliente no puede anular un pedido ya aceptado (regla por defecto)
set role service_role;
do $$
declare r record; v_num bigint;
begin
  select order_number into v_num from public.orders where idempotency_key = 'checkout:test-0015';
  perform test.eq(public.customer_cancel_order('51911111111', v_num), 'cancelled', 'anula pendiente');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- 4. Deduplicación de mensajes
-- ---------------------------------------------------------------------------
set role service_role;
do $$
begin
  perform test.eq(public.claim_message('wamid.AAA'), true, 'primer webhook se procesa');
  perform test.eq(public.claim_message('wamid.AAA'), false, 'duplicado en proceso se ignora');
  perform public.finish_message('wamid.AAA', 'done');
  perform test.eq(public.claim_message('wamid.AAA'), false, 'duplicado ya procesado se ignora');

  perform test.eq(public.claim_message('wamid.BBB'), true, 'nuevo');
  perform public.finish_message('wamid.BBB', 'failed', 'error de red');
  perform test.eq(public.claim_message('wamid.BBB'), true, 'reintento tras fallo');
  perform public.finish_message('wamid.BBB', 'failed', 'error de red');
  perform test.eq(public.claim_message('wamid.BBB'), true, 'tercer intento');
  perform public.finish_message('wamid.BBB', 'failed', 'error de red');
  perform test.eq(public.claim_message('wamid.BBB'), false, 'máximo 3 intentos');
end $$;

-- ---------------------------------------------------------------------------
-- 5. Sesiones con bloqueo optimista
-- ---------------------------------------------------------------------------
do $$
begin
  perform test.eq(public.bot_save_session('51933333333','main_menu','{}','[]','{}', null, now()), 1, 'sesión nueva');
  perform test.eq(public.bot_save_session('51933333333','main_menu','{}','[]','{}', null, now()), null::int, 'doble creación detectada');
  perform test.eq(public.bot_save_session('51933333333','reviewing_cart','{}','[]','{}', 1, now()), 2, 'actualización');
  perform test.eq(public.bot_save_session('51933333333','main_menu','{}','[]','{}', 1, now()), null::int, 'versión vieja rechazada');
  perform test.expect_error($q$ select public.bot_save_session('51933333333','estado_raro','{}','[]','{}', 2, now()) $q$, 'check constraint');
end $$;
reset role;

-- Política del cliente con pedidos aceptados configurable
update public.business_settings set customer_can_cancel_confirmed = false;
set role service_role;
do $$
declare r record;
begin
  -- pedido aceptado automáticamente (política explícita)
  reset role;
  update public.business_settings set auto_accept_orders = true;
  set role service_role;
  select * into r from public.create_order('51944444444','Juan','51944444444','pickup',null,
    '[{"product_id":"00000000-0000-0000-0000-00000000000a","quantity":1}]','checkout:test-0020');
  perform test.eq(r.status, 'confirmed'::public.order_status, 'aceptación automática si está activada');
  perform test.eq(public.customer_cancel_order('51944444444', r.order_number), 'not_allowed', 'no anula aceptado');
  reset role;
  update public.business_settings set auto_accept_orders = false;
end $$;
reset role;

\echo '   ✔ todas las aserciones pasaron'
