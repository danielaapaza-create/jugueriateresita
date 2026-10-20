// Implementación del repositorio y de las sesiones sobre Supabase.
// Se usa con la service role SOLO dentro de la Edge Function del webhook.
// Todas las operaciones sobre pedidos pasan por funciones SQL que validan
// propiedad del pedido, precios y disponibilidad dentro de una transacción.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.0";
import {
  type BotRepository,
  BOT_STATES,
  type CancelResult,
  type Category,
  type CreateOrderInput,
  type CreateOrderResult,
  type MessageLedger,
  ORDER_ERROR_CODES,
  OrderError,
  type OrderDetail,
  type OrderErrorCode,
  type OrderSummary,
  type Product,
  type Session,
  type SessionStore,
  type Settings,
} from "./types.ts";

interface ProductRow {
  id: string;
  category: Category;
  name: string;
  description: string | null;
  price_cents: number;
  is_available: boolean;
  is_active: boolean;
}

const PRODUCT_COLUMNS = "id, category, name, description, price_cents, is_available, is_active";

function toProduct(r: ProductRow): Product {
  return {
    id: r.id,
    category: r.category,
    name: r.name,
    description: r.description,
    priceCents: r.price_cents,
    isAvailable: r.is_available,
    isActive: r.is_active,
  };
}

/** Error de base de datos sin detalles sensibles. */
class DbError extends Error {
  constructor(op: string, err: { message?: string; code?: string }) {
    super(`${op} falló (${err.code ?? "?"}): ${(err.message ?? "").slice(0, 120)}`);
    this.name = "DbError";
  }
}

export function createSupabaseRepository(db: SupabaseClient): BotRepository {
  return {
    async getSettings(): Promise<Settings> {
      const { data, error } = await db.from("business_settings").select("*").eq("id", 1).single();
      if (error) throw new DbError("getSettings", error);
      return {
        businessName: data.business_name,
        ordersPaused: data.orders_paused,
        pauseMessage: data.pause_message,
        deliveryEnabled: data.delivery_enabled,
        autoAcceptOrders: data.auto_accept_orders,
        customerCanCancelConfirmed: data.customer_can_cancel_confirmed,
        maxQuantityPerItem: data.max_quantity_per_item,
      };
    },

    async listSellableProducts(category?: Category): Promise<Product[]> {
      let q = db.from("products").select(PRODUCT_COLUMNS)
        .eq("is_active", true).eq("is_available", true);
      if (category) q = q.eq("category", category);
      const { data, error } = await q.order("sort_order").order("name");
      if (error) throw new DbError("listSellableProducts", error);
      return (data as ProductRow[]).map(toProduct);
    },

    async getProductsByIds(ids: string[]): Promise<Product[]> {
      const valid = ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
      if (!valid.length) return [];
      const { data, error } = await db.from("products").select(PRODUCT_COLUMNS).in("id", valid);
      if (error) throw new DbError("getProductsByIds", error);
      return (data as ProductRow[]).map(toProduct);
    },

    async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
      const { data, error } = await db.rpc("create_order", {
        p_wa_id: input.waId,
        p_customer_name: input.customerName,
        p_contact_phone: input.contactPhone,
        p_delivery_method: input.deliveryMethod,
        p_stall: input.stall,
        p_items: input.items.map((i) => ({ product_id: i.productId, quantity: i.quantity })),
        p_idempotency_key: input.idempotencyKey,
      });
      if (error) {
        const code = ORDER_ERROR_CODES.find((c) => error.message === c);
        if (code) throw new OrderError(code as OrderErrorCode, error.details ?? undefined);
        throw new DbError("createOrder", error);
      }
      const row = (data as Record<string, unknown>[])[0];
      return {
        orderNumber: Number(row.order_number),
        status: row.status as CreateOrderResult["status"],
        totalCents: Number(row.total_cents),
        created: Boolean(row.created),
      };
    },

    async listCustomerOrders(waId: string): Promise<OrderSummary[]> {
      const { data, error } = await db.rpc("get_customer_orders", { p_wa_id: waId, p_limit: 5 });
      if (error) throw new DbError("listCustomerOrders", error);
      return (data as Record<string, unknown>[]).map((r) => ({
        orderNumber: Number(r.order_number),
        status: r.status as OrderSummary["status"],
        totalCents: Number(r.total_cents),
        deliveryMethod: r.delivery_method as OrderSummary["deliveryMethod"],
        createdAt: String(r.created_at),
      }));
    },

    async getCustomerOrder(waId: string, orderNumber: number): Promise<OrderDetail | null> {
      const { data, error } = await db.rpc("get_customer_order", { p_wa_id: waId, p_order_number: orderNumber });
      if (error) throw new DbError("getCustomerOrder", error);
      if (!data) return null;
      const r = data as Record<string, unknown>;
      return {
        orderNumber: Number(r.order_number),
        status: r.status as OrderDetail["status"],
        totalCents: Number(r.total_cents),
        deliveryMethod: r.delivery_method as OrderDetail["deliveryMethod"],
        createdAt: String(r.created_at),
        customerName: String(r.customer_name),
        stall: (r.stall as string | null) ?? null,
        cancelReason: (r.cancel_reason as string | null) ?? null,
        items: ((r.items as Record<string, unknown>[]) ?? []).map((i) => ({
          productName: String(i.product_name),
          quantity: Number(i.quantity),
          unitPriceCents: Number(i.unit_price_cents),
          lineTotalCents: Number(i.line_total_cents),
        })),
      };
    },

    async cancelCustomerOrder(waId: string, orderNumber: number): Promise<CancelResult> {
      const { data, error } = await db.rpc("customer_cancel_order", { p_wa_id: waId, p_order_number: orderNumber });
      if (error) throw new DbError("cancelCustomerOrder", error);
      return data as CancelResult;
    },
  };
}

export function createSupabaseSessionStore(db: SupabaseClient): SessionStore {
  return {
    async load(waId: string): Promise<Session | null> {
      const { data, error } = await db.from("customer_sessions")
        .select("wa_id, state, context, cart, profile, version, updated_at")
        .eq("wa_id", waId)
        .maybeSingle();
      if (error) throw new DbError("loadSession", error);
      if (!data) return null;
      return {
        waId: data.wa_id,
        state: BOT_STATES.includes(data.state) ? data.state : "main_menu",
        context: data.context ?? {},
        cart: Array.isArray(data.cart) ? data.cart : [],
        profile: data.profile ?? {},
        version: data.version,
        updatedAt: data.updated_at,
      };
    },

    async save(session: Session, inboundAt: Date): Promise<boolean> {
      const { data, error } = await db.rpc("bot_save_session", {
        p_wa_id: session.waId,
        p_state: session.state,
        p_context: session.context,
        p_cart: session.cart,
        p_profile: session.profile,
        p_expected_version: session.version,
        p_inbound_at: inboundAt.toISOString(),
      });
      if (error) throw new DbError("saveSession", error);
      return data !== null;
    },
  };
}

export function createSupabaseMessageLedger(db: SupabaseClient): MessageLedger {
  return {
    async claim(messageId) {
      const { data, error } = await db.rpc("claim_message", { p_message_id: messageId });
      if (error) throw new DbError("claimMessage", error);
      return data === true;
    },
    async finish(messageId, status, err) {
      const { error } = await db.rpc("finish_message", {
        p_message_id: messageId,
        p_status: status,
        p_error: err ?? null,
      });
      if (error) throw new DbError("finishMessage", error);
    },
  };
}
