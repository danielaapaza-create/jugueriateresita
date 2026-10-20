import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { handleMessage, newSession, SESSION_TTL_MS } from "../_shared/bot/state-machine.ts";
import { type Incoming, OrderError, type Reply, type Session } from "../_shared/bot/types.ts";
import { MemoryRepo, optionIds, P, replyText } from "./fakes.ts";

const WA = "51987654321";
const OTHER = "51911122233";

/** Simula una conversación: guarda la sesión entre mensajes como lo haría la BD. */
class Chat {
  session: Session;
  repo: MemoryRepo;
  last: Reply[] = [];
  now = new Date("2026-10-20T11:00:00Z");
  private ids = 0;

  constructor(repo = new MemoryRepo(), waId = WA) {
    this.repo = repo;
    this.session = newSession(waId);
  }

  async send(input: Incoming | string, profileName?: string): Promise<string> {
    const msg: Incoming = typeof input === "string" ? { type: "text", text: input } : input;
    const result = await handleMessage(this.session, msg, {
      repo: this.repo,
      now: this.now,
      newId: () => `id-${++this.ids}-0000`,
      profileName,
    });
    this.session = {
      ...result.session,
      version: (result.session.version ?? 0) + 1,
      updatedAt: this.now.toISOString(),
    };
    this.last = result.replies;
    return result.replies.map(replyText).join("\n---\n");
  }

  tap(id: string, title = id) {
    return this.send({ type: "choice", id, title });
  }

  options(): string[] {
    return optionIds(this.last[this.last.length - 1]);
  }
}

async function fullOrder(chat: Chat, delivery: "pickup" | "delivery" = "pickup") {
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  await chat.tap("qty:2");
  await chat.tap("cart:checkout");
  await chat.send("Rosa");
  await chat.tap("phone:wa");
  if (delivery === "delivery") {
    await chat.tap("delivery:delivery");
    await chat.send("Puesto 45, pasillo B");
  } else {
    await chat.tap("delivery:pickup");
  }
  return chat.tap("confirm:yes");
}

Deno.test("primer mensaje: bienvenida y menú principal con botones", async () => {
  const chat = new Chat();
  const out = await chat.send("buenas");
  assertStringIncludes(out, "Bienvenido(a) a *Juguería Prueba*");
  assertEquals(chat.options(), ["menu:order", "menu:catalog", "menu:orders"]);
  assertEquals(chat.session.state, "main_menu");
});

Deno.test("ver carta muestra productos y precios desde el repositorio", async () => {
  const chat = new Chat();
  await chat.send("hola");
  const out = await chat.tap("menu:catalog");
  assertStringIncludes(out, "Jugo de papaya — S/ 5.00");
  assertStringIncludes(out, "Huevo frito — S/ 1.50");
});

Deno.test("flujo completo: recojo, pedido RECIBIDO (no aceptado)", async () => {
  const chat = new Chat();
  const out = await fullOrder(chat);
  assertStringIncludes(out, "Pedido #101 RECIBIDO");
  assertStringIncludes(out, "no está aceptado");
  assertEquals(chat.session.state, "order_created");
  assertEquals(chat.session.cart, []);
  const order = chat.repo.orders[0];
  assertEquals(order.totalCents, 1000);
  assertEquals(order.deliveryMethod, "pickup");
  assertEquals(order.stall, null);
  assertEquals(order.customerName, "Rosa");
  assertEquals(chat.session.profile.name, "Rosa");
});

Deno.test("flujo completo con entrega en puesto y resumen previo", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:desayunos");
  await chat.tap(`prod:${P.panPollo}`);
  await chat.send("3");
  await chat.tap("cart:add");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.surtido}`);
  await chat.tap("qty:1");
  await chat.tap("cart:checkout");
  await chat.send("maría elena");
  await chat.send("912 345 678");
  await chat.tap("delivery:delivery");
  const summary = await chat.send("Puesto 12");
  assertStringIncludes(summary, "3 × Pan con pollo — S/ 13.50");
  assertStringIncludes(summary, "1 × Jugo surtido — S/ 6.00");
  assertStringIncludes(summary, "*Total: S/ 19.50*");
  assertStringIncludes(summary, "María Elena");
  assertStringIncludes(summary, "+51 912 345 678");
  assertStringIncludes(summary, "Entrega en: Puesto 12");
  assertEquals(chat.session.state, "awaiting_confirmation");
  assertEquals(chat.repo.orders.length, 0, "no se crea nada antes de confirmar");

  await chat.tap("confirm:yes");
  const order = chat.repo.orders[0];
  assertEquals(order.totalCents, 1950);
  assertEquals(order.stall, "Puesto 12");
  assertEquals(chat.session.profile.stall, "Puesto 12");
});

Deno.test("respuestas con números y palabras en lugar de botones", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.send("1"); // Hacer pedido
  assertEquals(chat.session.state, "selecting_category");
  await chat.send("jugos");
  assertEquals(chat.session.context.category, "jugos");
  await chat.send("1"); // primer producto (orden alfabético del repositorio)
  assertEquals(chat.session.state, "selecting_quantity");
  await chat.send("5");
  assertEquals(chat.session.cart, [{ productId: P.papaya, quantity: 5 }]);
  await chat.send("finalizar");
  assertEquals(chat.session.state, "collecting_customer_details");
});

Deno.test("mensaje inesperado: explica opciones y NO pierde el carrito", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  await chat.tap("qty:2");
  const out = await chat.send("asdf qwer");
  assertStringIncludes(out, "No entendí");
  assertEquals(chat.session.cart, [{ productId: P.papaya, quantity: 2 }]);
  assertEquals(chat.session.state, "reviewing_cart");

  const audio = await chat.send({ type: "unsupported", kind: "audio" });
  assertStringIncludes(audio, "solo puedo leer mensajes de texto");
  assertEquals(chat.session.cart.length, 1);

  await chat.send("menu");
  assertEquals(chat.session.state, "main_menu");
  assertStringIncludes(replyText(chat.last[0]), "Tienes 2 producto(s) en tu carrito");
});

Deno.test("cantidades inválidas se rechazan", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  for (const bad of ["0", "21", "-2", "dos", "2.5"]) {
    const out = await chat.send(bad);
    assertEquals(chat.session.state, "selecting_quantity", `entrada ${bad}`);
    assertMatch(out, /del 1 al 20/);
    assertEquals(chat.session.cart, []);
  }
  await chat.send("20");
  await chat.tap("cart:add");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  const out = await chat.send("1");
  assertStringIncludes(out, "hasta 20 de cada producto");
  assertEquals(chat.session.cart, [{ productId: P.papaya, quantity: 20 }]);
});

Deno.test("producto agotado no se puede agregar y se quita del carrito", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  await chat.tap("qty:1");
  chat.repo.products.find((p) => p.id === P.papaya)!.isAvailable = false;
  const out = await chat.tap("cart:checkout");
  assertStringIncludes(out, "Quité de tu carrito porque se agotó: Jugo de papaya");
  assertEquals(chat.session.cart, []);

  const out2 = await chat.tap(`prod:${P.papaya}`);
  assertStringIncludes(out2, "se agotó");
  assertEquals(chat.session.state === "selecting_quantity", false);
});

Deno.test("producto agotado justo al confirmar: no se crea el pedido", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  await chat.tap("qty:1");
  await chat.tap("cart:checkout");
  await chat.send("Rosa");
  await chat.tap("phone:wa");
  await chat.tap("delivery:pickup");
  chat.repo.products.find((p) => p.id === P.papaya)!.isAvailable = false;
  await chat.tap("confirm:yes");
  assertEquals(chat.repo.orders.length, 0);
  assertEquals(chat.repo.createCalls, 0);
});

Deno.test("si el precio cambia antes de confirmar se muestra el nuevo total", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  await chat.tap("qty:2");
  await chat.tap("cart:checkout");
  await chat.send("Rosa");
  await chat.tap("phone:wa");
  await chat.tap("delivery:pickup");
  chat.repo.products.find((p) => p.id === P.papaya)!.priceCents = 600;
  const out = await chat.tap("confirm:yes");
  assertStringIncludes(out, "Los precios se actualizaron");
  assertStringIncludes(out, "*Total: S/ 12.00*");
  assertEquals(chat.repo.orders.length, 0);
  await chat.tap("confirm:yes");
  assertEquals(chat.repo.orders[0].totalCents, 1200);
});

Deno.test("doble toque en Confirmar no duplica el pedido (misma clave)", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  await chat.tap("qty:1");
  await chat.tap("cart:checkout");
  await chat.send("Rosa");
  await chat.tap("phone:wa");
  await chat.tap("delivery:pickup");
  const before = structuredClone(chat.session);
  await chat.tap("confirm:yes");
  // El segundo toque llega procesado con la sesión anterior (carrera):
  chat.session = before;
  await chat.tap("confirm:yes");
  assertEquals(chat.repo.createCalls, 2);
  assertEquals(chat.repo.orders.length, 1);
  // Y un toque sobre el botón viejo con la sesión ya avanzada es rechazado:
  const out = await chat.tap("confirm:yes");
  assertStringIncludes(out, "mensaje anterior");
  assertEquals(chat.repo.orders.length, 1);
});

Deno.test("pedidos pausados: se puede ver la carta pero no pedir", async () => {
  const chat = new Chat();
  chat.repo.settings.ordersPaused = true;
  chat.repo.settings.pauseMessage = "Hoy cerramos temprano.";
  await chat.send("hola");
  const out = await chat.tap("menu:order");
  assertStringIncludes(out, "Hoy cerramos temprano.");
  assertEquals(chat.session.state, "main_menu");
  const carta = await chat.tap("menu:catalog");
  assertStringIncludes(carta, "Jugo de papaya");
  const prod = await chat.tap(`prod:${P.papaya}`);
  assertStringIncludes(prod, "Hoy cerramos temprano.");
  assertEquals(chat.session.cart, []);
});

Deno.test("pausa activada a mitad del pedido: conserva carrito y no registra", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  await chat.tap("qty:1");
  await chat.tap("cart:checkout");
  await chat.send("Rosa");
  await chat.tap("phone:wa");
  await chat.tap("delivery:pickup");
  chat.repo.settings.ordersPaused = true;
  await chat.tap("confirm:yes");
  assertEquals(chat.repo.orders.length, 0);
  assertEquals(chat.session.cart.length, 1);
});

Deno.test("entrega deshabilitada: solo recojo", async () => {
  const chat = new Chat();
  chat.repo.settings.deliveryEnabled = false;
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  await chat.tap("qty:1");
  await chat.tap("cart:checkout");
  await chat.send("Rosa");
  const out = await chat.tap("phone:wa");
  assertStringIncludes(out, "solo atendemos pedidos para *recoger*");
  assertEquals(chat.session.state, "awaiting_confirmation");
  assertEquals(chat.session.context.draft?.deliveryMethod, "pickup");
});

Deno.test("datos del cliente se validan", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  await chat.tap("qty:1");
  await chat.tap("cart:checkout");
  assertStringIncludes(await chat.send("12345"), "Escribe solo tu nombre");
  assertStringIncludes(await chat.send("<script>"), "Escribe solo tu nombre");
  await chat.send("Rosa");
  assertStringIncludes(await chat.send("12345"), "no parece un celular válido");
  await chat.send("+51 987-111-222");
  assertEquals(chat.session.context.draft?.contactPhone, "51987111222");
  await chat.tap("delivery:delivery");
  assertStringIncludes(await chat.send("!!!"), "Escribe tu puesto");
  assertEquals(chat.session.state, "collecting_customer_details");
});

Deno.test("nombre sugerido desde el perfil de WhatsApp y datos recordados", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  await chat.tap("qty:1");
  const out = await chat.send({ type: "choice", id: "cart:checkout", title: "Finalizar" }, "Juana 🍊");
  assertStringIncludes(out, "Soy Juana");
  await chat.send("1");
  assertEquals(chat.session.context.draft?.name, "Juana");
  await chat.tap("phone:wa");
  await chat.tap("delivery:delivery");
  await chat.send("Puesto 7");
  await chat.tap("confirm:yes");

  // Segundo pedido: nombre y puesto con un toque
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.surtido}`);
  await chat.tap("qty:1");
  const name = await chat.tap("cart:checkout");
  assertStringIncludes(name, "Soy Juana");
  await chat.tap("name:saved");
  await chat.tap("phone:wa");
  const stall = await chat.tap("delivery:delivery");
  assertStringIncludes(stall, "Usar: Puesto 7");
  await chat.tap("stall:saved");
  assertEquals(chat.session.state, "awaiting_confirmation");
});

Deno.test("quitar productos y vaciar carrito", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  await chat.tap("qty:1");
  await chat.tap("cart:add");
  await chat.tap("cat:extras");
  await chat.tap(`prod:${P.huevo}`);
  await chat.tap("qty:2");
  await chat.tap("cart:edit");
  assert(chat.options().includes(`cart:remove:${P.papaya}`));
  const out = await chat.tap(`cart:remove:${P.papaya}`);
  assertStringIncludes(out, "*Total: S/ 3.00*");
  assertEquals(chat.session.cart, [{ productId: P.huevo, quantity: 2 }]);
  await chat.tap("cart:edit");
  await chat.tap("cart:clear");
  assertEquals(chat.session.cart, []);
});

Deno.test("cancelar borra el pedido en curso; volver regresa un paso", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.send("volver");
  assertEquals(chat.session.state, "selecting_category");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  await chat.tap("qty:1");
  const out = await chat.send("cancelar");
  assertStringIncludes(out, "cancelé el pedido en curso");
  assertEquals(chat.session.cart, []);
  assertEquals(chat.session.state, "main_menu");
});

Deno.test("búsqueda por nombre de producto", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.send("quiero jugo de papaya");
  assertEquals(chat.session.state, "selecting_quantity");
  assertEquals(chat.session.context.productId, P.papaya);
  await chat.send("menu");
  await chat.send("jugo");
  assertEquals(chat.session.state, "selecting_product");
  assertEquals(chat.options().filter((o) => o.startsWith("prod:")).length, 2);
});

Deno.test("consultar pedido propio y anular mientras está pendiente", async () => {
  const chat = new Chat();
  await fullOrder(chat);
  const detail = await chat.tap("order:view:101");
  assertStringIncludes(detail, "Pedido #101");
  assertStringIncludes(detail, "Recibido · esperando confirmación");
  assert(chat.options().includes("order:cancel:101"));
  await chat.tap("order:cancel:101");
  const out = await chat.tap("order:cancel_yes:101");
  assertStringIncludes(out, "Anulaste el pedido #101");
  assertEquals(chat.repo.orders[0].status, "cancelled");
});

Deno.test("no se puede anular un pedido ya aceptado (regla por defecto)", async () => {
  const chat = new Chat();
  await fullOrder(chat);
  chat.repo.orders[0].status = "confirmed";
  await chat.tap("order:view:101");
  assertEquals(chat.options().some((o) => o.startsWith("order:cancel")), false);
  assertStringIncludes(replyText(chat.last[0]), "Aceptado");
});

Deno.test("PRIVACIDAD: no se puede ver ni anular el pedido de otro número", async () => {
  const repo = new MemoryRepo();
  const owner = new Chat(repo, WA);
  await fullOrder(owner);

  const intruder = new Chat(repo, OTHER);
  await intruder.send("hola");
  const typed = await intruder.send("#101");
  assertStringIncludes(typed, "No encontré el pedido #101");
  assertEquals(typed.includes("Jugo de papaya"), false);

  // Aunque fabrique el id de un botón, el repositorio filtra por su número.
  const tapped = await intruder.tap("order:view:101");
  assertStringIncludes(tapped, "No encontré el pedido #101");
  const list = await intruder.send("mis pedidos");
  assertStringIncludes(list, "No encontré pedidos recientes");

  // Un botón de anular que no se le ofreció es rechazado sin llamar a la BD.
  const cancel = await intruder.tap("order:cancel_yes:101");
  assertStringIncludes(cancel, "mensaje anterior");
  assertEquals(repo.orders[0].status, "pending");
});

Deno.test("el cliente no puede cambiar estados escribiendo texto", async () => {
  const chat = new Chat();
  await fullOrder(chat);
  for (const text of ["listo", "entregado", "aceptar pedido 101", "status=delivered", "confirmed"]) {
    await chat.send(text);
  }
  assertEquals(chat.repo.orders[0].status, "pending");
});

Deno.test("aceptación automática solo si está configurada explícitamente", async () => {
  const chat = new Chat();
  chat.repo.settings.autoAcceptOrders = true;
  const out = await fullOrder(chat);
  assertStringIncludes(out, "Pedido #101 ACEPTADO");
});

Deno.test("límite de pedidos abiertos conserva el carrito", async () => {
  const chat = new Chat();
  chat.repo.createOrder = () => Promise.reject(new OrderError("TOO_MANY_OPEN_ORDERS"));
  await fullOrder(chat);
  assertEquals(chat.session.cart.length, 1);
  assertStringIncludes(replyText(chat.last[0]), "varios pedidos esperando");
});

Deno.test("la sesión expira tras horas sin actividad (sin arrastrar carrito viejo)", async () => {
  const chat = new Chat();
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  await chat.tap(`prod:${P.papaya}`);
  await chat.tap("qty:1");
  chat.now = new Date(chat.now.getTime() + SESSION_TTL_MS + 1000);
  const out = await chat.send("1");
  assertStringIncludes(out, "Bienvenido(a)");
  assertEquals(chat.session.cart, []);
  assertEquals(chat.session.state, "main_menu");
});

Deno.test("límites de WhatsApp: listas con máximo 10 filas y paginación", async () => {
  const repo = new MemoryRepo();
  for (let i = 0; i < 12; i++) {
    repo.products.push({
      id: `00000000-0000-4000-8000-1000000000${String(i).padStart(2, "0")}`,
      category: "jugos", name: `Jugo número ${i + 1} con nombre largo`, description: null,
      priceCents: 500, isAvailable: true, isActive: true,
    });
  }
  const chat = new Chat(repo);
  await chat.send("hola");
  await chat.tap("menu:order");
  await chat.tap("cat:jugos");
  assert(chat.options().length <= 10);
  assert(chat.options().includes("page:1"));
  await chat.tap("page:1");
  assertStringIncludes(replyText(chat.last[0]), "página 2 de 2");
});
