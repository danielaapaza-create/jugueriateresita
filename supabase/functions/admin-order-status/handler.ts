// Cambio de estado de un pedido desde el panel + aviso al cliente por WhatsApp.
//
// Seguridad:
// * Usa el token de sesión (JWT) de la dueña, NO la service role.
// * La función SQL admin_set_order_status vuelve a verificar que sea admin
//   y que la transición sea válida (pendiente -> aceptado -> ... ).
//
// Ventana de atención de 24 h:
// * Si el cliente escribió hace menos de 24 h se envía un mensaje normal.
// * Si no, solo se puede escribir con una PLANTILLA aprobada por Meta
//   (WHATSAPP_TEMPLATE_ORDER_UPDATE). Si no hay plantilla, no se envía y el
//   panel muestra que el cliente no fue notificado.
import { STATUS_LABEL, statusNotificationText } from "../_shared/bot/status-messages.ts";
import type { DeliveryMethod, OrderStatus } from "../_shared/bot/types.ts";
import { errorMessage, log, maskPhone } from "../_shared/log.ts";
import type { Sender } from "../_shared/whatsapp/client.ts";

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Margen de seguridad para no enviar justo cuando la ventana se cierra. */
const WINDOW_MARGIN_MS = 10 * 60 * 1000;

const STATUSES: OrderStatus[] = ["pending", "confirmed", "preparing", "ready", "delivered", "cancelled"];

export interface StatusChange {
  order_id: string;
  order_number: number;
  status: OrderStatus;
  customer_wa_id: string;
  customer_name: string;
  delivery_method: DeliveryMethod;
  cancel_reason: string | null;
  last_inbound_at: string | null;
}

/** Operaciones de base de datos con los permisos del usuario que llama. */
export interface AdminDb {
  setStatus(orderId: string, status: OrderStatus, note: string | null): Promise<StatusChange>;
  recordNotification(orderId: string, status: OrderStatus, error: string | null): Promise<void>;
}

export class DbRpcError extends Error {
  readonly dbMessage: string;
  constructor(dbMessage: string) {
    super(dbMessage);
    this.dbMessage = dbMessage;
  }
}

export interface AdminDeps {
  dbForUser(authorization: string): AdminDb;
  sender: Sender;
  template?: { name: string; language: string };
  allowedOrigin: string;
  now?: () => Date;
}

export function createAdminHandler(deps: AdminDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const cors = {
    "Access-Control-Allow-Origin": deps.allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

    const authorization = req.headers.get("authorization") ?? "";
    if (!/^Bearer\s+\S+$/.test(authorization)) return json(401, { error: "unauthorized" });

    let body: { orderId?: unknown; status?: unknown; note?: unknown };
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid_json" });
    }
    const orderId = typeof body.orderId === "string" ? body.orderId : "";
    const status = body.status as OrderStatus;
    const note = typeof body.note === "string" ? body.note.slice(0, 200) : null;
    if (!/^[0-9a-f-]{36}$/i.test(orderId) || !STATUSES.includes(status)) {
      return json(400, { error: "invalid_input" });
    }

    const db = deps.dbForUser(authorization);
    let change: StatusChange;
    try {
      change = await db.setStatus(orderId, status, note);
    } catch (err) {
      const msg = err instanceof DbRpcError ? err.dbMessage : "";
      if (msg === "NOT_AUTHORIZED") return json(403, { error: "not_authorized" });
      if (msg === "ORDER_NOT_FOUND") return json(404, { error: "order_not_found" });
      if (msg === "INVALID_TRANSITION") return json(409, { error: "invalid_transition" });
      log("error", "admin_set_status_failed", { error: errorMessage(err) });
      return json(500, { error: "internal_error" });
    }

    const notificationError = await notify(change);
    try {
      await db.recordNotification(orderId, status, notificationError);
    } catch (err) {
      log("warn", "record_notification_failed", { error: errorMessage(err) });
    }

    return json(200, {
      ok: true,
      orderNumber: change.order_number,
      status: change.status,
      notified: notificationError === null,
      notificationError,
    });
  };

  /** Devuelve null si se notificó, o un motivo legible si no. */
  async function notify(change: StatusChange): Promise<string | null> {
    const to = change.customer_wa_id;
    const lastInbound = change.last_inbound_at ? Date.parse(change.last_inbound_at) : NaN;
    const insideWindow = Number.isFinite(lastInbound) &&
      now().getTime() - lastInbound < SERVICE_WINDOW_MS - WINDOW_MARGIN_MS;

    if (insideWindow) {
      const text = statusNotificationText({
        orderNumber: change.order_number,
        status: change.status,
        deliveryMethod: change.delivery_method,
        cancelReason: change.cancel_reason,
      });
      const res = await deps.sender.sendReply(to, { type: "text", body: text });
      if (res.ok) return null;
      if (!res.outsideWindow) {
        log("warn", "status_notification_failed", { to: maskPhone(to), code: res.code });
        return `WhatsApp rechazó el mensaje (código ${res.code ?? res.status}).`;
      }
      // Meta dice que la ventana ya cerró: intentar con plantilla.
    }

    if (!deps.template) {
      return "Pasaron más de 24 h desde el último mensaje del cliente y no hay plantilla aprobada configurada. Avísale por llamada.";
    }
    const res = await deps.sender.sendTemplate(to, deps.template.name, deps.template.language, [
      String(change.order_number),
      STATUS_LABEL[change.status],
    ]);
    if (res.ok) return null;
    log("warn", "status_template_failed", { to: maskPhone(to), code: res.code });
    return `No se pudo enviar la plantilla (código ${res.code ?? res.status}).`;
  }
}
