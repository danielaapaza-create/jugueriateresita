// deno-lint-ignore-file require-await
// Máquina de estados de la conversación de WhatsApp.
//
// Reglas de diseño:
// * Determinista: sin IA. Precios, cantidades y pedidos salen de PostgreSQL.
// * Pura respecto a la red: recibe la sesión y un repositorio, devuelve la
//   nueva sesión y las respuestas. Quien la llama guarda y envía.
// * Ante un mensaje inesperado se explica qué hacer sin perder el carrito.
import { STATUS_EMOJI, STATUS_LABEL } from "./status-messages.ts";
import {
  cleanName,
  cleanPeruvianMobile,
  cleanStall,
  formatLimaTime,
  formatPhone,
  formatSoles,
  normalize,
  parseOrderNumber,
  parseQuantity,
  truncate,
} from "./text.ts";
import {
  type BotRepository,
  type BotState,
  CATEGORIES,
  type DeliveryMethod,
  type Incoming,
  type Option,
  OrderError,
  type OrderStatus,
  type Product,
  type Reply,
  type Session,
  type Settings,
} from "./types.ts";

export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_CART_LINES = 8;
export const PAGE_SIZE = 8;
export const MAX_TEXT_LENGTH = 300;

export interface BotDeps {
  repo: BotRepository;
  now: Date;
  newId: () => string;
  /** Nombre del perfil de WhatsApp del cliente (solo como sugerencia). */
  profileName?: string;
}

export interface BotResult {
  session: Session;
  replies: Reply[];
}

export function newSession(waId: string): Session {
  return {
    waId,
    state: "main_menu",
    cart: [],
    context: {},
    profile: {},
    version: null,
    updatedAt: null,
  };
}

export async function handleMessage(
  session: Session,
  input: Incoming,
  deps: BotDeps,
): Promise<BotResult> {
  const conversation = new Conversation(structuredClone(session), deps);
  await conversation.run(input);
  return { session: conversation.session, replies: conversation.replies };
}

// ---------------------------------------------------------------------------
// Palabras clave globales (se comparan ya normalizadas: sin tildes ni signos)
// ---------------------------------------------------------------------------
const GREETINGS = new Set([
  "hola", "ola", "holi", "buenas", "buen dia", "buenos dias", "buenas tardes",
  "buenas noches", "hi", "hello", "alo",
]);
const MENU_WORDS = new Set(["menu", "inicio", "menu principal", "volver al menu", "empezar"]);
const CART_WORDS = new Set(["carrito", "ver carrito", "mi carrito"]);
const CANCEL_WORDS = new Set(["cancelar", "cancela", "salir", "cancelar todo", "borrar todo"]);
const HELP_WORDS = new Set(["ayuda", "help", "opciones"]);
const ORDERS_WORDS = new Set([
  "mis pedidos", "mi pedido", "pedidos", "estado", "estado de mi pedido",
  "consultar", "consultar pedido", "ver pedido",
]);
const BACK_WORDS = new Set(["volver", "atras", "regresar"]);
const THANKS_WORDS = new Set(["gracias", "muchas gracias", "ok", "okey", "ya", "listo", "vale", "perfecto"]);

/** Botones que siguen siendo válidos aunque vengan de un mensaje anterior. */
const GLOBAL_SAFE_PREFIXES = [
  "menu:", "cat:", "prod:", "cart:view", "order:view:",
];

const ORDERING_STATES: BotState[] = [
  "selecting_category", "selecting_product", "selecting_quantity", "reviewing_cart",
  "collecting_customer_details", "selecting_delivery", "awaiting_confirmation",
];

/** Palabras que no ayudan a buscar productos ("quiero un jugo de papaya"). */
const SEARCH_STOPWORDS = new Set([
  "quiero", "queria", "quisiera", "dame", "deme", "favor", "porfa", "porfavor", "para", "una", "uno", "unos", "unas",
]);

const SHORT_STATUS: Record<OrderStatus, string> = {
  pending: "Recibido",
  confirmed: "Aceptado",
  preparing: "Preparando",
  ready: "Listo",
  delivered: "Entregado",
  cancelled: "Cancelado",
};

interface CartView {
  lines: { product: Product; quantity: number; lineCents: number }[];
  totalCents: number;
  removed: string[];
}

class Conversation {
  readonly session: Session;
  readonly replies: Reply[] = [];
  private readonly deps: BotDeps;
  private notes: string[] = [];
  private settingsCache: Settings | null = null;

  constructor(session: Session, deps: BotDeps) {
    this.session = session;
    this.deps = deps;
  }

  // -------------------------------------------------------------------------
  // Punto de entrada
  // -------------------------------------------------------------------------
  async run(input: Incoming): Promise<void> {
    await this.dispatch(input);
    if (this.notes.length) {
      this.replies.push({ type: "text", body: this.notes.join("\n\n") });
      this.notes = [];
    }
  }

  private async dispatch(input: Incoming): Promise<void> {
    const s = this.session;
    const isNew = s.version === null;
    const expired = !isNew && s.updatedAt !== null &&
      this.deps.now.getTime() - Date.parse(s.updatedAt) > SESSION_TTL_MS;

    if (isNew || expired) {
      s.cart = [];
      s.context = {};
      const settings = await this.settings();
      return this.showMainMenu(
        `¡Hola! 👋 Bienvenido(a) a *${settings.businessName}*.\nHaz tu pedido por aquí, sin dejar tu puesto.`,
      );
    }

    if (input.type === "unsupported") {
      this.note("Por ahora solo puedo leer mensajes de texto y botones 🙏");
      return this.rerender();
    }
    if (input.type === "text" && input.text.length > MAX_TEXT_LENGTH) {
      this.note("Tu mensaje es muy largo. Usa los botones o escribe una respuesta corta 🙏");
      return this.rerender();
    }

    const option = this.resolveOption(input);
    if (input.type === "choice" && !option) {
      this.note("Ese botón es de un mensaje anterior. Usa estas opciones:");
      return this.rerender();
    }
    if (option) return this.onOption(option.id);

    const text = (input as { type: "text"; text: string }).text;
    const n = normalize(text);
    if (GREETINGS.has(n) || MENU_WORDS.has(n)) return this.showMainMenu();
    if (CART_WORDS.has(n)) return this.showCart();
    if (CANCEL_WORDS.has(n)) return this.cancelFlow();
    if (ORDERS_WORDS.has(n)) return this.showOrderList();
    if (BACK_WORDS.has(n)) return this.goBack();
    if (HELP_WORDS.has(n)) {
      this.note(HELP_TEXT);
      return this.rerender();
    }
    return this.onText(text, n);
  }

  /** Convierte la entrada en una de las opciones ofrecidas en el último mensaje. */
  private resolveOption(input: Incoming): Option | undefined {
    const options = this.session.context.options ?? [];
    if (input.type === "choice") {
      const found = options.find((o) => o.id === input.id);
      if (found) return found;
      if (GLOBAL_SAFE_PREFIXES.some((p) => input.id.startsWith(p))) {
        return { id: input.id, title: input.title };
      }
      return undefined;
    }
    if (input.type !== "text") return undefined;
    const n = normalize(input.text);
    if (/^\d{1,2}$/.test(n)) {
      const index = Number(n);
      if (index >= 1 && index <= options.length) return options[index - 1];
      return undefined;
    }
    return options.find((o) =>
      normalize(o.title) === n || (o.keywords ?? []).some((k) => normalize(k) === n)
    );
  }

  // -------------------------------------------------------------------------
  // Opciones (botones, filas de lista o números escritos)
  // -------------------------------------------------------------------------
  private async onOption(id: string): Promise<void> {
    const [kind, action, arg] = id.split(":");
    switch (kind) {
      case "menu":
        if (action === "order") return this.startOrder();
        if (action === "catalog") return this.sendCatalog();
        if (action === "orders") return this.showOrderList();
        return this.showMainMenu();
      case "cat":
        return this.selectCategory(action);
      case "page":
        this.session.context.page = Math.max(0, Number(action) || 0);
        return this.showProducts();
      case "nav":
        if (action === "categories") return this.showCategories();
        return this.showMainMenu();
      case "prod":
        return this.selectProduct(id.slice("prod:".length));
      case "qty":
        return this.addToCart(Number(action));
      case "cart":
        return this.onCartOption(action, id.slice(`cart:${action}:`.length));
      case "name":
        return this.onNameOption(action);
      case "phone":
        this.draft().contactPhone = this.session.waId;
        return this.afterPhone();
      case "stall": {
        const stall = this.session.profile.stall;
        if (!stall) return this.askDetail("stall");
        this.draft().stall = stall;
        return this.showConfirmation(true);
      }
      case "delivery":
        return this.chooseDelivery(action as DeliveryMethod);
      case "confirm":
        if (action === "yes") return this.confirmOrder();
        if (action === "edit") return this.showCart();
        return this.cancelFlow();
      case "order":
        return this.onOrderOption(action, Number(arg));
      default:
        return this.unexpected();
    }
  }

  // -------------------------------------------------------------------------
  // Texto libre según el estado
  // -------------------------------------------------------------------------
  private async onText(raw: string, n: string): Promise<void> {
    const s = this.session;
    if (THANKS_WORDS.has(n) && (s.state === "order_created" || s.state === "checking_order")) {
      this.say("¡Gracias a ti! 😊 Escribe *menú* cuando necesites algo.");
      return;
    }

    switch (s.state) {
      case "selecting_quantity": {
        const qty = parseQuantity(raw);
        if (qty !== null) return this.addToCart(qty);
        const max = (await this.settings()).maxQuantityPerItem;
        this.note(`Escribe solo la cantidad con números, del 1 al ${max} (por ejemplo: *2*).`);
        return this.askQuantity();
      }
      case "collecting_customer_details":
        return this.onDetailText(raw);
    }

    const orderNumber = parseOrderNumber(raw);
    if (orderNumber && (orderNumber.explicit || s.state === "checking_order")) {
      return this.showOrderDetail(orderNumber.value);
    }

    if (n.length >= 3) {
      const handled = await this.searchProducts(n);
      if (handled) return;
    }
    return this.unexpected();
  }

  private async unexpected(): Promise<void> {
    this.note("No entendí tu mensaje 🤔 Elige una de estas opciones (o escribe *ayuda*):");
    return this.rerender();
  }

  /** Vuelve a mostrar la pregunta del estado actual, sin perder el carrito. */
  private async rerender(): Promise<void> {
    const c = this.session.context;
    switch (this.session.state) {
      case "main_menu":
        return this.showMainMenu();
      case "selecting_category":
        return this.showCategories();
      case "selecting_product":
        return this.showProducts();
      case "selecting_quantity":
        return this.askQuantity();
      case "reviewing_cart":
        return c.cartMode === "edit" ? this.showCartEditor() : this.showCart();
      case "collecting_customer_details":
        return this.askDetail(c.detailsStep ?? "name");
      case "selecting_delivery":
        return this.askDelivery();
      case "awaiting_confirmation":
        return this.showConfirmation(false);
      case "order_created":
        return this.showOrderCreatedOptions();
      case "checking_order":
        if (c.confirmCancelOrder) return this.askCancelConfirmation(c.confirmCancelOrder);
        return c.orderNumber ? this.showOrderDetail(c.orderNumber) : this.showOrderList();
    }
  }

  private async goBack(): Promise<void> {
    const c = this.session.context;
    switch (this.session.state) {
      case "selecting_product":
        return this.showCategories();
      case "selecting_quantity":
        return c.category || c.search ? this.showProducts() : this.showCategories();
      case "reviewing_cart":
        return c.cartMode === "edit" ? this.showCart() : this.showCategories();
      case "collecting_customer_details":
      case "selecting_delivery":
      case "awaiting_confirmation":
        return this.showCart();
      case "checking_order":
        return c.orderNumber ? this.showOrderList() : this.showMainMenu();
      default:
        return this.showMainMenu();
    }
  }

  // -------------------------------------------------------------------------
  // Menú principal y carta
  // -------------------------------------------------------------------------
  private async showMainMenu(intro?: string): Promise<void> {
    const s = this.session;
    const settings = await this.settings();
    this.setState("main_menu", { keepDraft: false });
    const lines = [intro ?? "¿Qué deseas hacer?"];
    if (s.cart.length) {
      const count = s.cart.reduce((sum, l) => sum + l.quantity, 0);
      lines.push(`🛒 Tienes ${count} producto(s) en tu carrito.`);
    }
    if (settings.ordersPaused) lines.push("⏸️ En este momento no estamos tomando pedidos.");
    this.ask(lines.join("\n\n"), [
      { id: "menu:order", title: s.cart.length ? "Seguir pidiendo" : "Hacer pedido", keywords: ["pedir", "hacer pedido", "quiero pedir", "pedido nuevo"] },
      { id: "menu:catalog", title: "Ver carta y precios", keywords: ["carta", "precios", "ver carta", "lista"] },
      { id: "menu:orders", title: "Mis pedidos", keywords: ["consultar pedido"] },
    ]);
  }

  private async sendCatalog(): Promise<void> {
    const products = await this.deps.repo.listSellableProducts();
    if (!products.length) {
      this.note("Por ahora no tenemos productos disponibles 😔");
      return this.showMainMenu();
    }
    const blocks: string[] = ["📋 *Carta de hoy*"];
    for (const cat of CATEGORIES) {
      const items = products.filter((p) => p.category === cat.id);
      if (!items.length) continue;
      blocks.push(
        `${cat.emoji} *${cat.label}*\n` +
          items.map((p) => `• ${p.name} — ${formatSoles(p.priceCents)}`).join("\n"),
      );
    }
    this.say(truncate(blocks.join("\n\n"), 3500));
    return this.showMainMenu("¿Deseas hacer un pedido?");
  }

  // -------------------------------------------------------------------------
  // Catálogo: categorías, productos y cantidad
  // -------------------------------------------------------------------------
  private async pausedGuard(): Promise<boolean> {
    const settings = await this.settings();
    if (!settings.ordersPaused) return false;
    this.note(`⏸️ ${settings.pauseMessage}`);
    await this.showMainMenu();
    return true;
  }

  private async startOrder(): Promise<void> {
    if (await this.pausedGuard()) return;
    return this.showCategories();
  }

  private async showCategories(): Promise<void> {
    if (await this.pausedGuard()) return;
    const products = await this.deps.repo.listSellableProducts();
    const available = CATEGORIES.filter((c) => products.some((p) => p.category === c.id));
    if (!available.length) {
      this.note("Por ahora no tenemos productos disponibles 😔");
      return this.showMainMenu();
    }
    this.setState("selecting_category");
    this.session.context.category = undefined;
    this.session.context.search = undefined;
    const options: Option[] = available.map((c) => ({
      id: `cat:${c.id}`,
      title: `${c.emoji} ${c.label}`,
      description: `${products.filter((p) => p.category === c.id).length} opciones`,
      keywords: [c.label, c.id],
    }));
    if (this.session.cart.length) {
      options.push({ id: "cart:view", title: "🛒 Ver carrito", keywords: ["carrito"] });
    }
    options.push({ id: "menu:main", title: "↩️ Menú principal" });
    this.ask("¿Qué deseas pedir? Elige una categoría:\n\n" + numbered(options), options, "Ver categorías");
  }

  private async selectCategory(id: string): Promise<void> {
    const category = CATEGORIES.find((c) => c.id === id);
    if (!category) return this.unexpected();
    if (await this.pausedGuard()) return;
    this.session.context.category = category.id;
    this.session.context.search = undefined;
    this.session.context.page = 0;
    return this.showProducts();
  }

  private async listedProducts(): Promise<Product[]> {
    const c = this.session.context;
    if (c.search) return matchProducts(await this.deps.repo.listSellableProducts(), c.search);
    if (c.category) return this.deps.repo.listSellableProducts(c.category);
    return [];
  }

  private async showProducts(): Promise<void> {
    const c = this.session.context;
    const products = await this.listedProducts();
    if (!products.length) {
      this.note("Ya no quedan productos disponibles en esa categoría 😔");
      return this.showCategories();
    }
    const pages = Math.ceil(products.length / PAGE_SIZE);
    const page = Math.min(c.page ?? 0, pages - 1);
    const visible = products.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    const options: Option[] = visible.map((p) => ({
      id: `prod:${p.id}`,
      title: p.name,
      description: [formatSoles(p.priceCents), p.description].filter(Boolean).join(" · "),
      keywords: [p.name],
    }));
    if (page + 1 < pages) options.push({ id: `page:${page + 1}`, title: "➡️ Ver más", keywords: ["mas", "ver mas"] });
    options.push({ id: "nav:categories", title: "↩️ Categorías", keywords: ["categorias"] });
    if (page + 1 >= pages && this.session.cart.length) {
      options.push({ id: "cart:view", title: "🛒 Ver carrito", keywords: ["carrito"] });
    }

    const label = c.search
      ? `Resultados para "${c.search}"`
      : CATEGORIES.find((x) => x.id === c.category)?.label ?? "Productos";
    const priced = options.map((o, i) =>
      o.id.startsWith("prod:")
        ? `${i + 1}. ${o.title} — ${formatSoles(visible[i].priceCents)}`
        : `${i + 1}. ${o.title}`
    );
    this.setState("selecting_product");
    c.page = page;
    this.ask(
      `*${label}*${pages > 1 ? ` (página ${page + 1} de ${pages})` : ""}\nElige un producto:\n\n${priced.join("\n")}`,
      options,
      "Ver productos",
    );
  }

  /** Búsqueda por nombre ("papaya" -> Jugo de papaya). Devuelve true si respondió. */
  private async searchProducts(query: string): Promise<boolean> {
    const state = this.session.state;
    if (!["main_menu", "selecting_category", "selecting_product", "reviewing_cart", "order_created"].includes(state)) {
      return false;
    }
    const matches = matchProducts(await this.deps.repo.listSellableProducts(), query);
    if (!matches.length) return false;
    if (matches.length === 1) {
      await this.selectProduct(matches[0].id);
      return true;
    }
    if (await this.pausedGuard()) return true;
    this.session.context.search = query;
    this.session.context.category = undefined;
    this.session.context.page = 0;
    await this.showProducts();
    return true;
  }

  private async selectProduct(productId: string): Promise<void> {
    if (await this.pausedGuard()) return;
    const [product] = await this.deps.repo.getProductsByIds([productId]);
    if (!product || !product.isActive || !product.isAvailable) {
      this.note(`😔 ${product ? `*${product.name}* se agotó.` : "Ese producto ya no está disponible."}`);
      return this.session.context.category || this.session.context.search
        ? this.showProducts()
        : this.showCategories();
    }
    this.session.context.productId = product.id;
    if (!this.session.context.category && !this.session.context.search) {
      this.session.context.category = product.category;
    }
    this.setState("selecting_quantity");
    return this.askQuantity(product);
  }

  private async askQuantity(known?: Product): Promise<void> {
    const productId = this.session.context.productId;
    const product = known ?? (productId ? (await this.deps.repo.getProductsByIds([productId]))[0] : undefined);
    if (!product) return this.showCategories();
    const max = (await this.settings()).maxQuantityPerItem;
    this.setState("selecting_quantity");
    this.ask(
      `*${product.name}* — ${formatSoles(product.priceCents)} c/u\n\n¿Cuántos deseas? Toca un botón o escribe un número del 1 al ${max}.\n_(Escribe *volver* para elegir otro producto)_`,
      [1, 2, 3].map((q) => ({ id: `qty:${q}`, title: String(q) })),
    );
  }

  private async addToCart(quantity: number): Promise<void> {
    const s = this.session;
    const settings = await this.settings();
    if (settings.ordersPaused) {
      await this.pausedGuard();
      return;
    }
    const productId = s.context.productId;
    if (!productId) return this.showCategories();
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > settings.maxQuantityPerItem) {
      this.note(`La cantidad debe ser un número del 1 al ${settings.maxQuantityPerItem}.`);
      return this.askQuantity();
    }
    const [product] = await this.deps.repo.getProductsByIds([productId]);
    if (!product || !product.isActive || !product.isAvailable) {
      this.note("😔 Ese producto se acaba de agotar.");
      return this.showCategories();
    }
    const existing = s.cart.find((l) => l.productId === productId);
    const newQty = (existing?.quantity ?? 0) + quantity;
    if (newQty > settings.maxQuantityPerItem) {
      this.note(
        `Puedes pedir hasta ${settings.maxQuantityPerItem} de cada producto. Ya tienes ${existing?.quantity ?? 0} en tu carrito.`,
      );
      return this.askQuantity(product);
    }
    if (!existing && s.cart.length >= MAX_CART_LINES) {
      this.note(`Tu carrito ya tiene ${MAX_CART_LINES} productos distintos, que es el máximo por pedido.`);
      return this.showCart();
    }
    if (existing) existing.quantity = newQty;
    else s.cart.push({ productId, quantity });
    this.note(`✅ Agregué ${quantity} × ${product.name}.`);
    return this.showCart();
  }

  // -------------------------------------------------------------------------
  // Carrito
  // -------------------------------------------------------------------------
  /** Carga el carrito con precios actuales y quita lo que se agotó. */
  private async loadCart(): Promise<CartView> {
    const s = this.session;
    const products = s.cart.length
      ? await this.deps.repo.getProductsByIds(s.cart.map((l) => l.productId))
      : [];
    const byId = new Map(products.map((p) => [p.id, p]));
    const view: CartView = { lines: [], totalCents: 0, removed: [] };
    const kept = [];
    for (const line of s.cart) {
      const product = byId.get(line.productId);
      if (!product || !product.isActive || !product.isAvailable) {
        view.removed.push(product?.name ?? "un producto");
        continue;
      }
      const lineCents = product.priceCents * line.quantity;
      view.lines.push({ product, quantity: line.quantity, lineCents });
      view.totalCents += lineCents;
      kept.push(line);
    }
    s.cart = kept;
    if (view.removed.length) {
      this.note(`⚠️ Quité de tu carrito porque se agotó: ${view.removed.join(", ")}.`);
    }
    return view;
  }

  private async showCart(): Promise<void> {
    const cart = await this.loadCart();
    if (!cart.lines.length) {
      this.note("🛒 Tu carrito está vacío.");
      return (await this.settings()).ordersPaused ? this.showMainMenu() : this.showCategories();
    }
    this.setState("reviewing_cart");
    this.session.context.cartMode = "view";
    this.ask(`🛒 *Tu carrito*\n${cartLines(cart)}`, [
      { id: "cart:checkout", title: "✅ Finalizar pedido", keywords: ["finalizar", "terminar", "pagar", "eso es todo", "nada mas"] },
      { id: "cart:add", title: "➕ Agregar más", keywords: ["agregar", "mas", "agregar mas"] },
      { id: "cart:edit", title: "✏️ Quitar productos", keywords: ["quitar", "modificar", "editar"] },
    ]);
  }

  private async showCartEditor(): Promise<void> {
    const cart = await this.loadCart();
    if (!cart.lines.length) return this.showCart();
    this.setState("reviewing_cart");
    this.session.context.cartMode = "edit";
    const options: Option[] = cart.lines.map((l) => ({
      id: `cart:remove:${l.product.id}`,
      title: `Quitar ${l.product.name}`,
      description: `${l.quantity} × ${formatSoles(l.product.priceCents)}`,
    }));
    options.push({ id: "cart:clear", title: "🗑️ Vaciar carrito", keywords: ["vaciar"] });
    options.push({ id: "cart:view", title: "↩️ Volver al carrito" });
    this.ask("¿Qué producto deseas quitar?\n\n" + numbered(options), options, "Ver carrito");
  }

  private async onCartOption(action: string, productId: string): Promise<void> {
    const s = this.session;
    switch (action) {
      case "view":
        return this.showCart();
      case "add":
        return this.showCategories();
      case "edit":
        return this.showCartEditor();
      case "checkout":
        return this.startCheckout();
      case "clear":
        s.cart = [];
        this.note("🗑️ Vacié tu carrito.");
        return this.showMainMenu();
      case "remove": {
        const before = s.cart.length;
        s.cart = s.cart.filter((l) => l.productId !== productId);
        if (s.cart.length !== before) this.note("Listo, lo quité de tu carrito.");
        return this.showCart();
      }
      default:
        return this.unexpected();
    }
  }

  private async cancelFlow(): Promise<void> {
    const s = this.session;
    const hadSomething = s.cart.length > 0 || ORDERING_STATES.includes(s.state);
    s.cart = [];
    s.context = {};
    if (hadSomething) this.note("Listo, cancelé el pedido en curso 👍");
    return this.showMainMenu();
  }

  // -------------------------------------------------------------------------
  // Datos del cliente, entrega y confirmación
  // -------------------------------------------------------------------------
  private draft() {
    return (this.session.context.draft ??= {});
  }

  private async startCheckout(): Promise<void> {
    if (await this.pausedGuard()) return;
    const cart = await this.loadCart();
    if (!cart.lines.length || cart.removed.length) return this.showCart();
    this.session.context.draft = {};
    return this.askDetail("name");
  }

  private askDetail(step: "name" | "phone" | "stall"): void {
    const s = this.session;
    this.setState("collecting_customer_details");
    s.context.detailsStep = step;
    if (step === "name") {
      const options: Option[] = [];
      if (s.profile.name) {
        options.push({ id: "name:saved", title: `Soy ${s.profile.name}` });
      } else {
        // El nombre de perfil puede traer emojis: se dejan solo letras.
        const suggestion = this.deps.profileName
          ? cleanName(this.deps.profileName.replace(/[^\p{L} .'-]/gu, " "))
          : null;
        if (suggestion) {
          s.context.suggestedName = suggestion;
          options.push({ id: "name:wa", title: `Soy ${suggestion}` });
        }
      }
      this.ask(
        `👤 ¿A nombre de quién va el pedido?\nEscribe tu nombre${options.length ? " o toca el botón" : ""}.`,
        options,
      );
      return;
    }
    if (step === "phone") {
      this.ask(
        `📞 ¿A qué número te contactamos?\nToca *Usar este número* (${formatPhone(s.waId)}) o escribe otro celular de 9 dígitos.`,
        [{ id: "phone:wa", title: "Usar este número", keywords: ["este", "este numero", "el mismo", "mismo"] }],
      );
      return;
    }
    const options: Option[] = s.profile.stall
      ? [{ id: "stall:saved", title: `Usar: ${s.profile.stall}` }]
      : [];
    this.ask(
      `🏪 ¿A qué puesto te lo llevamos?\nEscribe el número o la referencia (ej.: *Puesto 45, pasillo B*).`,
      options,
    );
  }

  private onNameOption(action: string): Promise<void> | void {
    const s = this.session;
    const name = action === "saved" ? s.profile.name : s.context.suggestedName;
    if (!name) return this.askDetail("name");
    this.draft().name = name;
    return this.askDetail("phone");
  }

  private async onDetailText(raw: string): Promise<void> {
    const step = this.session.context.detailsStep ?? "name";
    if (step === "name") {
      const name = cleanName(raw);
      if (!name) {
        this.note("Escribe solo tu nombre, con letras (de 2 a 40 caracteres).");
        return this.askDetail("name");
      }
      this.draft().name = name;
      return this.askDetail("phone");
    }
    if (step === "phone") {
      const phone = cleanPeruvianMobile(raw);
      if (!phone) {
        this.note("Ese número no parece un celular válido. Escribe 9 dígitos, por ejemplo: *987654321*.");
        return this.askDetail("phone");
      }
      this.draft().contactPhone = phone;
      return this.afterPhone();
    }
    const stall = cleanStall(raw);
    if (!stall) {
      this.note("Escribe tu puesto en pocas palabras (máximo 40 caracteres).");
      return this.askDetail("stall");
    }
    this.draft().stall = stall;
    return this.showConfirmation(true);
  }

  private async afterPhone(): Promise<void> {
    const settings = await this.settings();
    if (!settings.deliveryEnabled) {
      this.draft().deliveryMethod = "pickup";
      this.draft().stall = undefined;
      this.note("ℹ️ Por ahora solo atendemos pedidos para *recoger* en la juguería.");
      return this.showConfirmation(true);
    }
    return this.askDelivery();
  }

  private askDelivery(): void {
    this.setState("selecting_delivery");
    this.ask("🛍️ ¿Cómo recibes tu pedido?", [
      { id: "delivery:pickup", title: "Paso a recoger", keywords: ["recojo", "recoger", "yo recojo", "paso", "voy"] },
      { id: "delivery:delivery", title: "Llévalo a mi puesto", keywords: ["entrega", "delivery", "llevar", "traer", "a mi puesto", "llevalo"] },
    ]);
  }

  private async chooseDelivery(method: DeliveryMethod): Promise<void> {
    if (method === "pickup") {
      this.draft().deliveryMethod = "pickup";
      this.draft().stall = undefined;
      return this.showConfirmation(true);
    }
    if (method !== "delivery") return this.unexpected();
    if (!(await this.settings()).deliveryEnabled) {
      this.note("ℹ️ En este momento no estamos haciendo entregas. Puedes pasar a recoger.");
      return this.askDelivery();
    }
    this.draft().deliveryMethod = "delivery";
    return this.askDetail("stall");
  }

  /** Muestra el resumen final. fresh = genera una nueva clave de pedido. */
  private async showConfirmation(fresh: boolean): Promise<void> {
    const s = this.session;
    const d = this.draft();
    if (!d.name) return this.askDetail("name");
    if (!d.contactPhone) return this.askDetail("phone");
    if (!d.deliveryMethod) return this.askDelivery();
    if (d.deliveryMethod === "delivery" && !d.stall) return this.askDetail("stall");

    const cart = await this.loadCart();
    if (!cart.lines.length || cart.removed.length) return this.showCart();

    const settings = await this.settings();
    this.setState("awaiting_confirmation");
    if (fresh || !s.context.checkoutId) s.context.checkoutId = this.deps.newId();
    s.context.confirmedTotal = cart.totalCents;

    const delivery = d.deliveryMethod === "delivery"
      ? `🛵 Entrega en: ${d.stall}`
      : "🛍️ Recojo en la juguería";
    const policy = settings.autoAcceptOrders
      ? "Al confirmar, tu pedido quedará registrado y aceptado."
      : "Al confirmar, tu pedido quedará *RECIBIDO*. Te avisaremos por aquí cuando la juguería lo *ACEPTE*.";
    this.ask(
      `📝 *Revisa tu pedido*\n\n${cartLines(cart)}\n\n👤 ${d.name}\n📞 ${formatPhone(d.contactPhone)}\n${delivery}\n\n${policy}`,
      [
        { id: "confirm:yes", title: "✅ Confirmar", keywords: ["si", "confirmar", "confirmo", "ok", "dale", "correcto"] },
        { id: "confirm:edit", title: "✏️ Modificar", keywords: ["modificar", "cambiar", "editar"] },
        { id: "confirm:cancel", title: "❌ Cancelar", keywords: ["no", "cancelar"] },
      ],
    );
  }

  private async confirmOrder(): Promise<void> {
    const s = this.session;
    if (await this.pausedGuard()) return;
    const d = this.draft();
    const checkoutId = s.context.checkoutId;
    if (!checkoutId || !d.name || !d.contactPhone || !d.deliveryMethod) {
      return this.showConfirmation(true);
    }
    const cart = await this.loadCart();
    if (!cart.lines.length || cart.removed.length) return this.showCart();
    if (cart.totalCents !== s.context.confirmedTotal) {
      this.note("⚠️ Los precios se actualizaron. Revisa el nuevo total antes de confirmar:");
      return this.showConfirmation(true);
    }

    let result;
    try {
      result = await this.deps.repo.createOrder({
        waId: s.waId,
        customerName: d.name,
        contactPhone: d.contactPhone,
        deliveryMethod: d.deliveryMethod,
        stall: d.deliveryMethod === "delivery" ? d.stall ?? null : null,
        items: s.cart.map((l) => ({ productId: l.productId, quantity: l.quantity })),
        idempotencyKey: `checkout:${checkoutId}`,
      });
    } catch (err) {
      if (!(err instanceof OrderError)) throw err;
      return this.onOrderError(err);
    }

    s.profile.name = d.name;
    s.profile.contactPhone = d.contactPhone;
    if (d.deliveryMethod === "delivery" && d.stall) s.profile.stall = d.stall;
    s.cart = [];
    s.context = { orderNumber: result.orderNumber };
    this.setState("order_created");

    const header = result.status === "pending"
      ? `🕐 *Pedido #${result.orderNumber} RECIBIDO*\nTotal: ${formatSoles(result.totalCents)}\n\nTodavía *no está aceptado*. La juguería lo revisará y te avisaremos por aquí cuando lo acepte.`
      : `✅ *Pedido #${result.orderNumber} ACEPTADO*\nTotal: ${formatSoles(result.totalCents)}\n\nTe avisaremos por aquí cuando esté listo.`;
    this.note(header);
    return this.showOrderCreatedOptions();
  }

  private async onOrderError(err: OrderError): Promise<void> {
    switch (err.code) {
      case "ORDERS_PAUSED":
        await this.pausedGuard();
        return;
      case "DELIVERY_DISABLED":
        this.note("ℹ️ En este momento no estamos haciendo entregas. Puedes pasar a recoger.");
        return this.askDelivery();
      case "STALL_REQUIRED":
        return this.askDetail("stall");
      case "TOO_MANY_OPEN_ORDERS":
        this.note(
          "Ya tienes varios pedidos esperando atención. Espera a que los atendamos o revísalos en *Mis pedidos*. Tu carrito sigue guardado.",
        );
        return this.showMainMenu();
      case "PRODUCT_UNAVAILABLE":
        this.note("😔 Uno de los productos se acaba de agotar.");
        return this.showCart();
      default:
        this.note("No pudimos registrar el pedido con esos datos. Revisa tu carrito, por favor.");
        return this.showCart();
    }
  }

  private showOrderCreatedOptions(): void {
    const n = this.session.context.orderNumber;
    this.setState("order_created");
    const options: Option[] = [];
    if (n) options.push({ id: `order:view:${n}`, title: "Ver mi pedido", keywords: ["ver pedido", "estado"] });
    options.push({ id: "menu:order", title: "Hacer otro pedido", keywords: ["otro pedido", "pedir"] });
    options.push({ id: "menu:main", title: "Menú principal" });
    this.ask("¿Deseas algo más?", options);
  }

  // -------------------------------------------------------------------------
  // Consulta y anulación de pedidos (solo los del número que escribe)
  // -------------------------------------------------------------------------
  private async showOrderList(): Promise<void> {
    const orders = await this.deps.repo.listCustomerOrders(this.session.waId);
    if (!orders.length) {
      this.note("No encontré pedidos recientes en este número de WhatsApp.");
      return this.showMainMenu();
    }
    if (orders.length === 1) return this.showOrderDetail(orders[0].orderNumber);
    this.setState("checking_order");
    this.session.context.orderNumber = undefined;
    const options: Option[] = orders.map((o) => ({
      id: `order:view:${o.orderNumber}`,
      title: `#${o.orderNumber} · ${SHORT_STATUS[o.status]}`,
      description: `${formatSoles(o.totalCents)} · ${formatLimaTime(o.createdAt)}`,
      keywords: [`#${o.orderNumber}`],
    }));
    options.push({ id: "menu:main", title: "↩️ Menú principal" });
    this.ask("📦 *Tus pedidos recientes*\nElige uno para ver el detalle:\n\n" + numbered(options), options, "Ver pedidos");
  }

  private async showOrderDetail(orderNumber: number): Promise<void> {
    const s = this.session;
    const order = await this.deps.repo.getCustomerOrder(s.waId, orderNumber);
    if (!order) {
      // Igual respuesta si no existe o si es de otra persona.
      this.note(`No encontré el pedido #${orderNumber} en este número de WhatsApp.`);
      return this.showMainMenu();
    }
    const settings = await this.settings();
    this.setState("checking_order");
    s.context.orderNumber = order.orderNumber;
    s.context.confirmCancelOrder = undefined;

    const items = order.items
      .map((i) => `${i.quantity} × ${i.productName} — ${formatSoles(i.lineTotalCents)}`)
      .join("\n");
    const delivery = order.deliveryMethod === "delivery"
      ? `🛵 Entrega en: ${order.stall ?? "-"}`
      : "🛍️ Recojo en la juguería";
    const reason = order.status === "cancelled" && order.cancelReason ? `\nMotivo: ${order.cancelReason}` : "";
    const cancellable = order.status === "pending" ||
      (order.status === "confirmed" && settings.customerCanCancelConfirmed);

    const options: Option[] = [{ id: "order:refresh", title: "🔄 Actualizar", keywords: ["actualizar"] }];
    if (cancellable) {
      options.push({ id: `order:cancel:${order.orderNumber}`, title: "Anular pedido", keywords: ["anular", "anular pedido", "cancelar pedido", "cancelar"] });
    } else {
      options.push({ id: "order:list", title: "Mis pedidos" });
    }
    options.push({ id: "menu:main", title: "Menú principal" });

    this.ask(
      `📦 *Pedido #${order.orderNumber}* (${formatLimaTime(order.createdAt)})\n\n${items}\n*Total: ${formatSoles(order.totalCents)}*\n${delivery}\n\nEstado: ${STATUS_EMOJI[order.status]} *${STATUS_LABEL[order.status]}*${reason}`,
      options,
    );
  }

  private askCancelConfirmation(orderNumber: number): void {
    this.setState("checking_order");
    this.session.context.orderNumber = orderNumber;
    this.session.context.confirmCancelOrder = orderNumber;
    this.ask(`¿Seguro que deseas anular el pedido #${orderNumber}?`, [
      { id: `order:cancel_yes:${orderNumber}`, title: "Sí, anular", keywords: ["si", "anular"] },
      { id: "order:cancel_no", title: "No, mantener", keywords: ["no", "mantener"] },
    ]);
  }

  private async onOrderOption(action: string, orderNumber: number): Promise<void> {
    const c = this.session.context;
    switch (action) {
      case "view":
        return Number.isSafeInteger(orderNumber) ? this.showOrderDetail(orderNumber) : this.showOrderList();
      case "refresh":
        return c.orderNumber ? this.showOrderDetail(c.orderNumber) : this.showOrderList();
      case "list":
        return this.showOrderList();
      case "cancel":
        return this.askCancelConfirmation(orderNumber);
      case "cancel_no":
        return c.orderNumber ? this.showOrderDetail(c.orderNumber) : this.showMainMenu();
      case "cancel_yes": {
        const result = await this.deps.repo.cancelCustomerOrder(this.session.waId, orderNumber);
        c.confirmCancelOrder = undefined;
        if (result === "not_found") {
          this.note(`No encontré el pedido #${orderNumber} en este número de WhatsApp.`);
          return this.showMainMenu();
        }
        this.note(
          result === "cancelled"
            ? `❌ Anulaste el pedido #${orderNumber}.`
            : result === "already_cancelled"
            ? `El pedido #${orderNumber} ya estaba cancelado.`
            : `El pedido #${orderNumber} ya fue aceptado por la juguería y no se puede anular desde aquí. Si necesitas cambiarlo, comunícate directamente con la juguería.`,
        );
        return this.showOrderDetail(orderNumber);
      }
      default:
        return this.unexpected();
    }
  }

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------
  private async settings(): Promise<Settings> {
    return (this.settingsCache ??= await this.deps.repo.getSettings());
  }

  private setState(state: BotState, opts: { keepDraft?: boolean } = {}): void {
    const s = this.session;
    s.state = state;
    if (state !== "checking_order") {
      s.context.orderNumber = state === "order_created" ? s.context.orderNumber : undefined;
      s.context.confirmCancelOrder = undefined;
    }
    if (opts.keepDraft === false) {
      s.context.draft = undefined;
      s.context.checkoutId = undefined;
      s.context.confirmedTotal = undefined;
    }
  }

  /** Texto que se antepone a la siguiente pregunta (un solo mensaje). */
  private note(text: string): void {
    this.notes.push(text);
  }

  private say(body: string): void {
    if (this.notes.length) {
      body = [...this.notes, body].join("\n\n");
      this.notes = [];
    }
    this.replies.push({ type: "text", body });
  }

  /** Envía una pregunta con opciones y las recuerda para interpretar la respuesta. */
  private ask(body: string, options: Option[], listLabel = "Ver opciones"): void {
    const fullBody = [...this.notes, body].join("\n\n");
    this.notes = [];
    this.session.context.options = options;
    if (!options.length) {
      this.replies.push({ type: "text", body: fullBody });
    } else if (options.length <= 3) {
      this.replies.push({ type: "buttons", body: fullBody, buttons: options });
    } else {
      this.replies.push({
        type: "list",
        body: fullBody,
        buttonLabel: listLabel,
        sections: [{ title: "Opciones", rows: options }],
      });
    }
  }
}

const HELP_TEXT = [
  "ℹ️ *Ayuda*",
  "Toca los botones o responde con el número de la opción.",
  "También puedes escribir:",
  "• *menú* – volver al inicio",
  "• *carrito* – ver tu carrito",
  "• *volver* – regresar un paso",
  "• *cancelar* – borrar el pedido en curso",
  "• *mis pedidos* – ver el estado de tus pedidos",
].join("\n");

function numbered(options: Option[]): string {
  return options.map((o, i) => `${i + 1}. ${o.title}`).join("\n");
}

function cartLines(cart: CartView): string {
  const lines = cart.lines.map((l) =>
    `${l.quantity} × ${l.product.name} — ${formatSoles(l.lineCents)}`
  );
  return `${lines.join("\n")}\n*Total: ${formatSoles(cart.totalCents)}*`;
}

/** Coincidencia determinista: todas las palabras buscadas están en el nombre. */
export function matchProducts(products: Product[], query: string): Product[] {
  const words = normalize(query).split(" ").filter((w) => w.length >= 3 && !SEARCH_STOPWORDS.has(w));
  if (!words.length) return [];
  return products.filter((p) => {
    const name = normalize(p.name);
    return words.every((w) => name.includes(w));
  });
}
