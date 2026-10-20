// Pruebas de la función que usa el panel para cambiar estados y avisar al cliente.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { type AdminDb, createAdminHandler, DbRpcError, type StatusChange } from "../admin-order-status/handler.ts";
import type { OrderStatus } from "../_shared/bot/types.ts";
import { FakeSender, replyText } from "./fakes.ts";

const NOW = new Date("2026-10-20T12:00:00Z");
const ORDER_ID = "6f1c1c1e-1111-4222-8333-444455556666";

function setup(opts: { lastInbound?: string | null; dbError?: string; template?: boolean } = {}) {
  const sender = new FakeSender();
  const recorded: { status: OrderStatus; error: string | null }[] = [];
  const auths: string[] = [];
  const db: AdminDb = {
    setStatus(_id, status) {
      if (opts.dbError) return Promise.reject(new DbRpcError(opts.dbError));
      const change: StatusChange = {
        order_id: ORDER_ID, order_number: 101, status, customer_wa_id: "51987654321",
        customer_name: "Rosa", delivery_method: "pickup", cancel_reason: null,
        last_inbound_at: opts.lastInbound === undefined ? "2026-10-20T11:30:00Z" : opts.lastInbound,
      };
      return Promise.resolve(change);
    },
    recordNotification(_id, status, error) {
      recorded.push({ status, error });
      return Promise.resolve();
    },
  };
  const handle = createAdminHandler({
    dbForUser: (a) => {
      auths.push(a);
      return db;
    },
    sender,
    template: opts.template ? { name: "actualizacion_pedido", language: "es" } : undefined,
    allowedOrigin: "https://panel.example",
    now: () => NOW,
  });
  const call = (body: unknown, auth = "Bearer jwt-de-la-duena") =>
    handle(new Request("https://x/functions/v1/admin-order-status", {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  return { sender, recorded, auths, call, handle };
}

Deno.test("aceptar pedido avisa al cliente dentro de la ventana de 24 h", async () => {
  const t = setup();
  const res = await t.call({ orderId: ORDER_ID, status: "confirmed" });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.notified, true);
  assertStringIncludes(replyText(t.sender.sent[0].reply), "pedido #101 fue ACEPTADO");
  assertEquals(t.auths, ["Bearer jwt-de-la-duena"], "usa el token del usuario, no la service role");
  assertEquals(t.recorded, [{ status: "confirmed", error: null }]);
});

Deno.test("pedido listo para recoger vs. para entregar", async () => {
  const t = setup();
  await (await t.call({ orderId: ORDER_ID, status: "ready" })).body?.cancel();
  assertStringIncludes(replyText(t.sender.sent[0].reply), "Ya puedes pasar a recogerlo");
});

Deno.test("fuera de la ventana de 24 h sin plantilla: no envía y lo registra", async () => {
  const t = setup({ lastInbound: "2026-10-19T08:00:00Z" });
  const body = await (await t.call({ orderId: ORDER_ID, status: "ready" })).json();
  assertEquals(body.notified, false);
  assertStringIncludes(body.notificationError, "24 h");
  assertEquals(t.sender.sent.length, 0);
  assertEquals(t.recorded[0].error !== null, true);
});

Deno.test("fuera de la ventana con plantilla aprobada: usa la plantilla", async () => {
  const t = setup({ lastInbound: null, template: true });
  const body = await (await t.call({ orderId: ORDER_ID, status: "ready" })).json();
  assertEquals(body.notified, true);
  assertEquals(t.sender.templates[0], { to: "51987654321", name: "actualizacion_pedido", params: ["101", "Listo"] });
});

Deno.test("si Meta responde 131047 se intenta con plantilla", async () => {
  const t = setup({ template: true });
  t.sender.nextResults.push({ ok: false, status: 400, code: 131047, outsideWindow: true });
  const body = await (await t.call({ orderId: ORDER_ID, status: "confirmed" })).json();
  assertEquals(body.notified, true);
  assertEquals(t.sender.templates.length, 1);
});

Deno.test("seguridad: sin token, no admin o transición inválida", async () => {
  const t = setup();
  const noAuth = await t.call({ orderId: ORDER_ID, status: "confirmed" }, "");
  assertEquals(noAuth.status, 401);
  await noAuth.body?.cancel();

  const bad = await t.call({ orderId: "1; drop table", status: "confirmed" });
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
  const badStatus = await t.call({ orderId: ORDER_ID, status: "pagado" });
  assertEquals(badStatus.status, 400);
  await badStatus.body?.cancel();

  const notAdmin = setup({ dbError: "NOT_AUTHORIZED" });
  const r1 = await notAdmin.call({ orderId: ORDER_ID, status: "confirmed" });
  assertEquals(r1.status, 403);
  await r1.body?.cancel();
  assertEquals(notAdmin.sender.sent.length, 0);

  const invalid = setup({ dbError: "INVALID_TRANSITION" });
  const r2 = await invalid.call({ orderId: ORDER_ID, status: "ready" });
  assertEquals(r2.status, 409);
  await r2.body?.cancel();
  assertEquals(invalid.sender.sent.length, 0);
});

Deno.test("CORS: responde preflight con el origen configurado", async () => {
  const t = setup();
  const res = await t.handle(new Request("https://x", { method: "OPTIONS" }));
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "https://panel.example");
});
