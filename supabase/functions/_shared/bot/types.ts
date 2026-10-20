// Tipos compartidos del bot. No dependen de Deno ni de Supabase,
// así la lógica se puede probar sin red ni base de datos.

export const BOT_STATES = [
  "main_menu",
  "selecting_category",
  "selecting_product",
  "selecting_quantity",
  "reviewing_cart",
  "collecting_customer_details",
  "selecting_delivery",
  "awaiting_confirmation",
  "order_created",
  "checking_order",
] as const;
export type BotState = typeof BOT_STATES[number];

export type Category = "desayunos" | "jugos" | "extras";
export const CATEGORIES: ReadonlyArray<{ id: Category; label: string; emoji: string }> = [
  { id: "desayunos", label: "Desayunos", emoji: "🍳" },
  { id: "jugos", label: "Jugos", emoji: "🥤" },
  { id: "extras", label: "Extras", emoji: "🥪" },
];

export type DeliveryMethod = "pickup" | "delivery";

export type OrderStatus =
  | "pending"
  | "confirmed"
  | "preparing"
  | "ready"
  | "delivered"
  | "cancelled";

export interface Product {
  id: string;
  category: Category;
  name: string;
  description: string | null;
  priceCents: number;
  isAvailable: boolean;
  isActive: boolean;
}

export interface Settings {
  businessName: string;
  ordersPaused: boolean;
  pauseMessage: string;
  deliveryEnabled: boolean;
  autoAcceptOrders: boolean;
  customerCanCancelConfirmed: boolean;
  maxQuantityPerItem: number;
}

export interface CartLine {
  productId: string;
  quantity: number;
}

/** Opción ofrecida al cliente. Se guarda para entender respuestas "1", "2"... */
export interface Option {
  id: string;
  title: string;
  description?: string;
  keywords?: string[];
}

export interface Profile {
  name?: string;
  stall?: string;
  contactPhone?: string;
}

export interface Draft {
  name?: string;
  contactPhone?: string;
  deliveryMethod?: DeliveryMethod;
  stall?: string;
}

export interface SessionContext {
  category?: Category;
  page?: number;
  productId?: string;
  detailsStep?: "name" | "phone" | "stall";
  draft?: Draft;
  /** Se genera al mostrar el resumen; es la clave anti-duplicados del pedido. */
  checkoutId?: string;
  cartMode?: "view" | "edit";
  orderNumber?: number;
  confirmCancelOrder?: number;
  /** Total mostrado en el resumen; si cambia antes de confirmar se vuelve a mostrar. */
  confirmedTotal?: number;
  /** Nombre de perfil de WhatsApp sugerido como nombre del pedido. */
  suggestedName?: string;
  /** Búsqueda por texto ("papaya") cuyos resultados se están mostrando. */
  search?: string;
  options?: Option[];
}

export interface Session {
  waId: string;
  state: BotState;
  cart: CartLine[];
  context: SessionContext;
  profile: Profile;
  /** null = la sesión aún no existe en la base de datos */
  version: number | null;
  updatedAt: string | null;
}

/** Mensaje entrante ya normalizado. */
export type Incoming =
  | { type: "text"; text: string }
  | { type: "choice"; id: string; title: string }
  | { type: "unsupported"; kind: string };

/** Respuesta que el bot quiere enviar (independiente del formato de Meta). */
export type Reply =
  | { type: "text"; body: string }
  | { type: "buttons"; body: string; buttons: Option[] }
  | { type: "list"; body: string; buttonLabel: string; sections: { title: string; rows: Option[] }[] };

export interface OrderSummary {
  orderNumber: number;
  status: OrderStatus;
  totalCents: number;
  deliveryMethod: DeliveryMethod;
  createdAt: string;
}

export interface OrderDetail extends OrderSummary {
  customerName: string;
  stall: string | null;
  cancelReason: string | null;
  items: { productName: string; quantity: number; unitPriceCents: number; lineTotalCents: number }[];
}

export interface CreateOrderInput {
  waId: string;
  customerName: string;
  contactPhone: string;
  deliveryMethod: DeliveryMethod;
  stall: string | null;
  items: CartLine[];
  idempotencyKey: string;
}

export interface CreateOrderResult {
  orderNumber: number;
  status: OrderStatus;
  totalCents: number;
  created: boolean;
}

export type CancelResult = "cancelled" | "already_cancelled" | "not_found" | "not_allowed";

export const ORDER_ERROR_CODES = [
  "ORDERS_PAUSED",
  "DELIVERY_DISABLED",
  "STALL_REQUIRED",
  "TOO_MANY_OPEN_ORDERS",
  "EMPTY_CART",
  "CART_TOO_LARGE",
  "INVALID_ITEMS",
  "INVALID_QUANTITY",
  "PRODUCT_UNAVAILABLE",
  "IDEMPOTENCY_CONFLICT",
] as const;
export type OrderErrorCode = typeof ORDER_ERROR_CODES[number];

/** Error de negocio conocido devuelto por create_order. */
export class OrderError extends Error {
  readonly code: OrderErrorCode;
  constructor(code: OrderErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "OrderError";
    this.code = code;
  }
}

/** Acceso a datos que necesita la máquina de estados. */
export interface BotRepository {
  getSettings(): Promise<Settings>;
  /** Productos activos y disponibles (lo que se puede vender ahora). */
  listSellableProducts(category?: Category): Promise<Product[]>;
  /** Productos por id, en cualquier estado (para revisar el carrito). */
  getProductsByIds(ids: string[]): Promise<Product[]>;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  listCustomerOrders(waId: string): Promise<OrderSummary[]>;
  getCustomerOrder(waId: string, orderNumber: number): Promise<OrderDetail | null>;
  cancelCustomerOrder(waId: string, orderNumber: number): Promise<CancelResult>;
}

export interface SessionStore {
  load(waId: string): Promise<Session | null>;
  /** Devuelve false si otra invocación modificó la sesión (reintentar). */
  save(session: Session, inboundAt: Date): Promise<boolean>;
}

/** Registro de mensajes procesados (deduplicación de webhooks). */
export interface MessageLedger {
  /** true = este proceso debe atender el mensaje; false = duplicado. */
  claim(messageId: string): Promise<boolean>;
  finish(messageId: string, status: "done" | "failed" | "skipped", error?: string): Promise<void>;
}
