import { useState } from "react";
import { limaTime, minutesAgo, NEXT_ACTIONS, phoneLabel, soles, STATUS_LABEL } from "../format";
import { supabase } from "../supabase";
import type { Order, OrderStatus } from "../types";

interface Props {
  order: Order;
  onChanged: () => void;
}

const ERRORS: Record<string, string> = {
  invalid_transition: "Ese cambio de estado no está permitido (quizá otra persona ya lo cambió).",
  not_authorized: "Tu cuenta no tiene permiso.",
  order_not_found: "El pedido ya no existe.",
};

export default function OrderCard({ order, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function change(to: OrderStatus) {
    let note: string | null = null;
    if (to === "cancelled") {
      const reason = window.prompt(
        `¿Por qué se cancela el pedido #${order.order_number}? (el cliente verá este motivo)`,
        "Producto agotado",
      );
      if (reason === null) return;
      note = reason.trim().slice(0, 200) || null;
    }
    setBusy(true);
    setMessage(null);
    const { data, error } = await supabase.functions.invoke("admin-order-status", {
      body: { orderId: order.id, status: to, note },
    });
    setBusy(false);
    if (error) {
      let code = "";
      try {
        code = (await (error as { context?: Response }).context?.json())?.error ?? "";
      } catch {
        // respuesta sin JSON
      }
      setMessage(ERRORS[code] ?? "No se pudo actualizar. Revisa tu conexión e inténtalo otra vez.");
      onChanged();
      return;
    }
    if (data && !data.notified) {
      setMessage(`Estado actualizado, pero el cliente NO fue avisado: ${data.notificationError}`);
    }
    onChanged();
  }

  const waLink = `https://wa.me/${order.customer_wa_id}`;
  const notifyFailed = order.last_notification_error && order.status !== "pending";

  return (
    <article className={`card order status-${order.status}`}>
      <header>
        <h2>#{order.order_number}</h2>
        <span className="muted">
          {limaTime(order.created_at)} · {minutesAgo(order.created_at)}
        </span>
      </header>
      <p className="who">
        <b>{order.customer_name}</b> ·{" "}
        <a href={`tel:+${order.contact_phone}`}>📞 {phoneLabel(order.contact_phone)}</a> ·{" "}
        <a href={waLink} target="_blank" rel="noreferrer">WhatsApp</a>
      </p>
      <p className={`delivery ${order.delivery_method}`}>
        {order.delivery_method === "delivery" ? `🛵 LLEVAR A: ${order.stall}` : "🛍️ Recoge en la juguería"}
      </p>
      <ul className="items">
        {order.order_items.map((i) => (
          <li key={i.product_name}>
            <b>{i.quantity} ×</b> {i.product_name} <span className="muted">{soles(i.line_total_cents)}</span>
          </li>
        ))}
      </ul>
      <p className="total">Total: {soles(order.total_cents)}</p>
      <p className="muted small">Estado: {STATUS_LABEL[order.status]}</p>
      {order.status === "cancelled" && order.cancel_reason && (
        <p className="muted small">
          Motivo: {order.cancel_reason} ({order.cancelled_by === "customer" ? "lo anuló el cliente" : "lo cancelaste tú"})
        </p>
      )}
      {notifyFailed && <p className="banner warn small">⚠️ Cliente no avisado: {order.last_notification_error}</p>}
      {message && <p className="banner warn small">{message}</p>}
      <div className="actions">
        {NEXT_ACTIONS[order.status].map((a) => (
          <button key={a.to} className={a.kind} disabled={busy} onClick={() => change(a.to)}>
            {a.label}
          </button>
        ))}
      </div>
    </article>
  );
}
