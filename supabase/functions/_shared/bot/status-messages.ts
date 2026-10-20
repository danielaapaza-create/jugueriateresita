// Textos de estado que ve el cliente. Distinguen claramente:
// RECIBIDO (pending) · ACEPTADO (confirmed) · LISTO (ready).
// Ningún texto promete tiempos de entrega.
import type { DeliveryMethod, OrderStatus } from "./types.ts";

export const STATUS_LABEL: Record<OrderStatus, string> = {
  pending: "Recibido · esperando confirmación de la juguería",
  confirmed: "Aceptado",
  preparing: "En preparación",
  ready: "Listo",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

export const STATUS_EMOJI: Record<OrderStatus, string> = {
  pending: "🕐",
  confirmed: "✅",
  preparing: "👩‍🍳",
  ready: "🥤",
  delivered: "📦",
  cancelled: "❌",
};

export interface StatusNotice {
  orderNumber: number;
  status: OrderStatus;
  deliveryMethod: DeliveryMethod;
  cancelReason?: string | null;
}

/** Mensaje que se envía al cliente cuando la dueña cambia el estado. */
export function statusNotificationText(n: StatusNotice): string {
  const id = `#${n.orderNumber}`;
  switch (n.status) {
    case "pending":
      return `🕐 Tu pedido ${id} fue recibido y está esperando confirmación.`;
    case "confirmed":
      return `✅ ¡Tu pedido ${id} fue ACEPTADO! Te avisaremos cuando esté listo.`;
    case "preparing":
      return `👩‍🍳 Tu pedido ${id} está en preparación.`;
    case "ready":
      return n.deliveryMethod === "delivery"
        ? `🥤 ¡Tu pedido ${id} está LISTO! Te lo llevaremos a tu puesto.`
        : `🥤 ¡Tu pedido ${id} está LISTO! Ya puedes pasar a recogerlo.`;
    case "delivered":
      return `📦 Tu pedido ${id} fue entregado. ¡Gracias por tu compra!`;
    case "cancelled": {
      const reason = n.cancelReason ? `\nMotivo: ${n.cancelReason}` : "";
      return `❌ Lo sentimos, tu pedido ${id} fue cancelado por la juguería.${reason}\nEscribe *menú* si deseas hacer otro pedido.`;
    }
  }
}
