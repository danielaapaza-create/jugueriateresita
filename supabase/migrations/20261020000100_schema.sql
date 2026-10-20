-- =============================================================================
-- Juguería Teresita · Esquema base
-- Tablas: products, orders, order_items, customer_sessions, processed_messages,
--         business_settings, admins, order_status_history
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
-- pending    = pedido RECIBIDO (registrado, la dueña aún no lo acepta)
-- confirmed  = pedido ACEPTADO por la dueña
-- preparing  = en preparación
-- ready      = LISTO para recoger / para llevar al puesto
-- delivered  = entregado
-- cancelled  = cancelado (por el cliente o por la dueña)
create type public.order_status as enum (
  'pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled'
);

create type public.delivery_method as enum ('pickup', 'delivery');

-- ---------------------------------------------------------------------------
-- Utilidad: updated_at automático
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Administradores (usuarios de Supabase Auth autorizados para el panel)
-- ---------------------------------------------------------------------------
create table public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Configuración del negocio (una sola fila, id = 1)
-- ---------------------------------------------------------------------------
create table public.business_settings (
  id                            smallint primary key default 1 check (id = 1),
  business_name                 text not null default 'Juguería Teresita'
    check (char_length(btrim(business_name)) between 2 and 60),
  orders_paused                 boolean not null default false,
  pause_message                 text not null default
    'En este momento no estamos recibiendo pedidos por WhatsApp. Por favor vuelve a escribirnos más tarde.'
    check (char_length(pause_message) between 5 and 500),
  delivery_enabled              boolean not null default true,
  -- false = la dueña acepta cada pedido manualmente (política por defecto).
  auto_accept_orders            boolean not null default false,
  -- false = el cliente solo puede anular pedidos que aún no fueron aceptados.
  customer_can_cancel_confirmed boolean not null default false,
  max_quantity_per_item         integer not null default 20
    check (max_quantity_per_item between 1 and 99),
  max_open_orders_per_customer  integer not null default 3
    check (max_open_orders_per_customer between 1 and 20),
  updated_at                    timestamptz not null default now()
);

insert into public.business_settings (id) values (1);

create trigger business_settings_updated_at
  before update on public.business_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Productos (catálogo). Precios en céntimos de sol para evitar decimales.
-- ---------------------------------------------------------------------------
create table public.products (
  id           uuid primary key default gen_random_uuid(),
  category     text not null check (category in ('desayunos', 'jugos', 'extras')),
  name         text not null check (char_length(btrim(name)) between 2 and 60),
  description  text check (description is null or char_length(description) <= 140),
  price_cents  integer not null check (price_cents > 0 and price_cents <= 100000),
  -- false = AGOTADO (se muestra en el panel, no en WhatsApp)
  is_available boolean not null default true,
  -- false = archivado (ya no se vende; se conserva por los pedidos antiguos)
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index products_catalog_idx
  on public.products (category, sort_order, name)
  where is_active;

create trigger products_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Pedidos
-- ---------------------------------------------------------------------------
create table public.orders (
  id               uuid primary key default gen_random_uuid(),
  -- Número corto que ve el cliente: "Pedido #123"
  order_number     bigint generated always as identity unique,
  -- Número de WhatsApp que creó el pedido (dueño del pedido). Solo dígitos.
  customer_wa_id   text not null check (customer_wa_id ~ '^[0-9]{8,15}$'),
  customer_name    text not null check (char_length(btrim(customer_name)) between 2 and 60),
  contact_phone    text not null check (contact_phone ~ '^[0-9]{8,15}$'),
  delivery_method  public.delivery_method not null,
  stall            text check (stall is null or char_length(btrim(stall)) between 1 and 60),
  status           public.order_status not null default 'pending',
  total_cents      integer not null check (total_cents > 0),
  -- Evita pedidos duplicados si el cliente toca "Confirmar" dos veces
  -- o si Meta reenvía el mismo webhook.
  idempotency_key  text not null unique,
  cancel_reason    text check (cancel_reason is null or char_length(cancel_reason) <= 200),
  cancelled_by     text check (cancelled_by is null or cancelled_by in ('customer', 'admin')),
  -- Resultado de la última notificación de estado enviada al cliente
  last_notified_status     public.order_status,
  last_notification_error  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  confirmed_at     timestamptz,
  ready_at         timestamptz,
  delivered_at     timestamptz,
  cancelled_at     timestamptz,
  constraint stall_required_for_delivery
    check (delivery_method = 'pickup' or stall is not null)
);

create index orders_customer_idx on public.orders (customer_wa_id, created_at desc);
create index orders_status_idx on public.orders (status, created_at desc);

create trigger orders_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Detalle de pedidos: conserva nombre y precio del momento de la compra.
-- ---------------------------------------------------------------------------
create table public.order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders (id) on delete cascade,
  product_id       uuid not null references public.products (id) on delete restrict,
  product_name     text not null,
  unit_price_cents integer not null check (unit_price_cents > 0),
  quantity         integer not null check (quantity between 1 and 99),
  line_total_cents integer generated always as (unit_price_cents * quantity) stored,
  unique (order_id, product_id)
);

create index order_items_order_idx on public.order_items (order_id);

-- ---------------------------------------------------------------------------
-- Historial de estados (auditoría)
-- ---------------------------------------------------------------------------
create table public.order_status_history (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references public.orders (id) on delete cascade,
  from_status public.order_status,
  to_status   public.order_status not null,
  changed_by  text not null, -- 'bot', 'customer' o el uuid del administrador
  note        text,
  changed_at  timestamptz not null default now()
);

create index order_status_history_order_idx on public.order_status_history (order_id, changed_at);

-- ---------------------------------------------------------------------------
-- Sesiones conversacionales de WhatsApp (estado de la máquina de estados)
-- ---------------------------------------------------------------------------
create table public.customer_sessions (
  wa_id           text primary key check (wa_id ~ '^[0-9]{8,15}$'),
  state           text not null default 'main_menu' check (state in (
                    'main_menu', 'selecting_category', 'selecting_product',
                    'selecting_quantity', 'reviewing_cart',
                    'collecting_customer_details', 'selecting_delivery',
                    'awaiting_confirmation', 'order_created', 'checking_order')),
  context         jsonb not null default '{}'::jsonb,
  cart            jsonb not null default '[]'::jsonb check (jsonb_typeof(cart) = 'array'),
  -- Datos que el cliente ya dio (nombre, puesto) para no volver a escribirlos.
  profile         jsonb not null default '{}'::jsonb,
  -- Bloqueo optimista: evita que dos mensajes simultáneos pisen el estado.
  version         integer not null default 0,
  -- Último mensaje recibido del cliente: define la ventana de atención de 24 h.
  last_inbound_at timestamptz,
  -- Consentimiento para mensajes promocionales. El bot NUNCA envía promociones;
  -- se deja en false hasta que exista un flujo explícito de aceptación.
  marketing_opt_in boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Mensajes de WhatsApp ya procesados (deduplicación de webhooks)
-- No se guarda el contenido del mensaje ni el teléfono.
-- ---------------------------------------------------------------------------
create table public.processed_messages (
  wa_message_id text primary key check (char_length(wa_message_id) <= 200),
  status        text not null check (status in ('processing', 'done', 'failed', 'skipped')),
  attempts      integer not null default 1,
  last_error    text,
  received_at   timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index processed_messages_received_idx on public.processed_messages (received_at);
