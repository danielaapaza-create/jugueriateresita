-- =============================================================================
-- DATOS DE PRUEBA SOLO PARA DESARROLLO LOCAL (supabase db reset).
-- No son productos ni precios reales: la dueña carga la carta real desde el
-- panel (pestaña "Productos"). Este archivo NO se aplica en producción.
-- =============================================================================
insert into public.products (category, name, description, price_cents, sort_order) values
  ('desayunos', 'Desayuno de prueba 1', 'Producto ficticio para pruebas', 100, 1),
  ('desayunos', 'Desayuno de prueba 2', null, 200, 2),
  ('jugos',     'Jugo de prueba 1', 'Producto ficticio para pruebas', 300, 1),
  ('jugos',     'Jugo de prueba 2', null, 400, 2),
  ('extras',    'Extra de prueba 1', null, 50, 1);
