// Dobles de prueba en memoria. Imitan las reglas de las funciones SQL
// (las reglas reales se prueban aparte en supabase/tests/*.sql).
import {
  type BotRepository,
  type CancelResult,
  type Category,
  type CreateOrderInput,
  type CreateOrderResult,
  type MessageLedger,
  OrderError,
  type OrderDetail,
  type OrderStatus,
  type OrderSummary,
  type Product,
  type Reply,
  type Session,
  type SessionStore,
  type Settings,
} from "../_shared/bot/types.ts";
import type { SendResult, Sender } from "../_shared/whatsapp/client.ts";

export const P = {
  papaya: "00000000-0000-4000-8000-000000000001",
  surtido: "00000000-0000-4000-8000-000000000002",
  panPollo: "00000000-0000-4000-8000-000000000003",
  tamal: "00000000-0000-4000-8000-000000000004",
  huevo: "00000000-0000-4000-8000-000000000005",
};

export function sampleProducts(): Product[] {
  const p = (id: string, category: Category, name: string, priceCents: number): Product => ({
    id, category, name, description: null, priceCents, isAvailable: true, isActive: true,
  });
  return [
    p(P.papaya, "jugos", "Jugo de papaya", 500),
    p(P.surtido, "jugos", "Jugo surtido", 600),
    p(P.panPollo, "desayunos", "Pan con pollo", 450),
    p(P.tamal, "desayunos", "Tamal", 400),
    p(P.huevo, "extras", "Huevo frito", 150),
  ];
}

export function defaultSettings(): Settings {
  return {
    businessName: "Juguería Prueba",
    ordersPaused: false,
    pauseMessage: "Volvemos pronto.",
    deliveryEnabled: true,
    autoAcceptOrders: false,
    customerCanCancelConfirmed: false,
    maxQuantityPerItem: 20,
  };
}

interface StoredOrder extends OrderDetail {
  waId: string;
  idempotencyKey: string;
}

export class MemoryRepo implements BotRepository {
  products: Product[] = sampleProducts();
  settings: Settings = defaultSettings();
  orders: StoredOrder[] = [];
  createCalls = 0;
  private seq = 100;

  getSettings() {
    return Promise.resolve({ ...this.settings });
  }
  listSellableProducts(category?: Category) {
    return Promise.resolve(
      this.products.filter((p) => p.isActive && p.isAvailable && (!category || p.category === category)),
    );
  }
  getProductsByIds(ids: string[]) {
    return Promise.resolve(this.products.filter((p) => ids.includes(p.id)).map((p) => ({ ...p })));
  }
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    this.createCalls++;
    const existing = this.orders.find((o) => o.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.waId !== input.waId) throw new OrderError("IDEMPOTENCY_CONFLICT");
      return Promise.resolve({ orderNumber: existing.orderNumber, status: existing.status, totalCents: existing.totalCents, created: false });
    }
    if (this.settings.ordersPaused) throw new OrderError("ORDERS_PAUSED");
    if (input.deliveryMethod === "delivery" && !this.settings.deliveryEnabled) throw new OrderError("DELIVERY_DISABLED");
    const items = input.items.map((i) => {
      const p = this.products.find((x) => x.id === i.productId);
      if (!p || !p.isAvailable || !p.isActive) throw new OrderError("PRODUCT_UNAVAILABLE");
      return { productName: p.name, quantity: i.quantity, unitPriceCents: p.priceCents, lineTotalCents: p.priceCents * i.quantity };
    });
    const status: OrderStatus = this.settings.autoAcceptOrders ? "confirmed" : "pending";
    const order: StoredOrder = {
      orderNumber: ++this.seq,
      status,
      totalCents: items.reduce((s, i) => s + i.lineTotalCents, 0),
      deliveryMethod: input.deliveryMethod,
      createdAt: new Date("2026-10-20T12:00:00Z").toISOString(),
      customerName: input.customerName,
      stall: input.stall,
      cancelReason: null,
      items,
      waId: input.waId,
      idempotencyKey: input.idempotencyKey,
    };
    this.orders.push(order);
    return Promise.resolve({ orderNumber: order.orderNumber, status, totalCents: order.totalCents, created: true });
  }
  listCustomerOrders(waId: string): Promise<OrderSummary[]> {
    return Promise.resolve(this.orders.filter((o) => o.waId === waId).reverse());
  }
  getCustomerOrder(waId: string, orderNumber: number): Promise<OrderDetail | null> {
    return Promise.resolve(this.orders.find((o) => o.waId === waId && o.orderNumber === orderNumber) ?? null);
  }
  cancelCustomerOrder(waId: string, orderNumber: number): Promise<CancelResult> {
    const o = this.orders.find((x) => x.waId === waId && x.orderNumber === orderNumber);
    if (!o) return Promise.resolve("not_found");
    if (o.status === "cancelled") return Promise.resolve("already_cancelled");
    if (!(o.status === "pending" || (o.status === "confirmed" && this.settings.customerCanCancelConfirmed))) {
      return Promise.resolve("not_allowed");
    }
    o.status = "cancelled";
    return Promise.resolve("cancelled");
  }
}

export class MemorySessions implements SessionStore {
  rows = new Map<string, Session>();
  /** Simula que otro mensaje modificó la sesión N veces antes de guardar. */
  conflicts = 0;
  load(waId: string) {
    const s = this.rows.get(waId);
    return Promise.resolve(s ? structuredClone(s) : null);
  }
  save(session: Session, _inboundAt: Date) {
    if (this.conflicts > 0) {
      this.conflicts--;
      return Promise.resolve(false);
    }
    const current = this.rows.get(session.waId);
    if ((current?.version ?? null) !== session.version) return Promise.resolve(false);
    this.rows.set(session.waId, {
      ...structuredClone(session),
      version: (session.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    });
    return Promise.resolve(true);
  }
}

export class MemoryLedger implements MessageLedger {
  rows = new Map<string, { status: string; attempts: number; error?: string }>();
  down = false;
  claim(id: string) {
    if (this.down) return Promise.reject(new Error("connection refused"));
    const row = this.rows.get(id);
    if (!row) {
      this.rows.set(id, { status: "processing", attempts: 1 });
      return Promise.resolve(true);
    }
    if (row.status === "failed" && row.attempts < 3) {
      row.status = "processing";
      row.attempts++;
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }
  finish(id: string, status: "done" | "failed" | "skipped", error?: string) {
    const row = this.rows.get(id)!;
    row.status = status;
    row.error = error;
    return Promise.resolve();
  }
}

export class FakeSender implements Sender {
  sent: { to: string; reply: Reply }[] = [];
  templates: { to: string; name: string; params: string[] }[] = [];
  read: string[] = [];
  nextResults: SendResult[] = [];
  sendReply(to: string, reply: Reply) {
    this.sent.push({ to, reply });
    return Promise.resolve(this.nextResults.shift() ?? { ok: true as const });
  }
  sendTemplate(to: string, name: string, _language: string, params: string[]) {
    this.templates.push({ to, name, params });
    return Promise.resolve(this.nextResults.shift() ?? { ok: true as const });
  }
  markRead(id: string) {
    this.read.push(id);
    return Promise.resolve();
  }
}

/** Texto completo de una respuesta (para buscar frases en las pruebas). */
export function replyText(r: Reply): string {
  if (r.type === "text") return r.body;
  if (r.type === "buttons") return `${r.body}\n[${r.buttons.map((b) => b.title).join(" | ")}]`;
  return `${r.body}\n[${r.sections.flatMap((s) => s.rows.map((x) => x.title)).join(" | ")}]`;
}

export function optionIds(r: Reply | undefined): string[] {
  if (!r || r.type === "text") return [];
  if (r.type === "buttons") return r.buttons.map((b) => b.id);
  return r.sections.flatMap((s) => s.rows.map((x) => x.id));
}
