import { useCallback, useEffect, useRef, useState } from "react";
import { STATUS_TABS } from "../format";
import { supabase } from "../supabase";
import type { Order, OrderStatus } from "../types";
import OrderCard from "./OrderCard";

const ACTIVE: OrderStatus[] = ["pending", "confirmed", "preparing", "ready"];

/** Pitido corto para avisar de pedidos nuevos (sin archivos de audio). */
function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    navigator.vibrate?.([200, 100, 200]);
  } catch {
    // El navegador puede bloquear el audio hasta que se toque la pantalla.
  }
}

export default function OrdersView() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [tab, setTab] = useState<OrderStatus>("pending");
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const knownPending = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [ordersRes, settingsRes] = await Promise.all([
      supabase
        .from("orders")
        .select("*, order_items(product_name, quantity, unit_price_cents, line_total_cents)")
        .or(`status.in.(${ACTIVE.join(",")}),created_at.gte.${since}`)
        .order("created_at", { ascending: true })
        .limit(300),
      supabase.from("business_settings").select("orders_paused").eq("id", 1).single(),
    ]);
    if (ordersRes.error) {
      setError("No se pudieron cargar los pedidos. Revisa tu conexión.");
      return;
    }
    setError(null);
    const list = ordersRes.data as Order[];
    setOrders(list);
    setPaused(Boolean(settingsRes.data?.orders_paused));
    setUpdatedAt(new Date());

    const pendingIds = new Set(list.filter((o) => o.status === "pending").map((o) => o.id));
    if (knownPending.current && [...pendingIds].some((id) => !knownPending.current!.has(id))) beep();
    knownPending.current = pendingIds;
  }, []);

  useEffect(() => {
    load();
    // Tiempo real: cualquier cambio en pedidos recarga la lista.
    const channel = supabase
      .channel("orders-panel")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => load())
      .subscribe();
    // Respaldo por si el tiempo real se corta (mala señal en el mercado).
    const timer = setInterval(load, 30_000);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(timer);
    };
  }, [load]);

  const visible = orders.filter((o) => o.status === tab);
  // Activos: el más antiguo primero. Historial: el más reciente primero.
  if (!ACTIVE.includes(tab)) visible.reverse();

  return (
    <section>
      <header className="topbar">
        <h1>Pedidos</h1>
        <button onClick={load} aria-label="Actualizar">🔄</button>
      </header>
      {paused && <p className="banner warn">⏸️ Los pedidos por WhatsApp están PAUSADOS (Ajustes).</p>}
      {error && <p className="banner error">{error}</p>}
      <div className="chips">
        {STATUS_TABS.map((t) => {
          const count = orders.filter((o) => o.status === t.status).length;
          return (
            <button
              key={t.status}
              className={`chip ${tab === t.status ? "active" : ""} ${t.status === "pending" && count ? "alert" : ""}`}
              onClick={() => setTab(t.status)}
            >
              {t.label} <b>{count}</b>
            </button>
          );
        })}
      </div>
      {!ACTIVE.includes(tab) && <p className="muted small">Mostrando las últimas 24 horas.</p>}
      {visible.length === 0 && <p className="empty">No hay pedidos aquí.</p>}
      {visible.map((o) => <OrderCard key={o.id} order={o} onChanged={load} />)}
      {updatedAt && <p className="muted small center-text">Actualizado {updatedAt.toLocaleTimeString("es-PE")}</p>}
    </section>
  );
}
