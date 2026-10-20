// Firma, formato de mensajes, cliente con reintentos y registros seguros.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { cleanName, cleanPeruvianMobile, cleanStall, normalize, parseOrderNumber, parseQuantity } from "../_shared/bot/text.ts";
import { errorMessage, log, maskPhone } from "../_shared/log.ts";
import { createWhatsAppClient } from "../_shared/whatsapp/client.ts";
import { LIMITS, toPayloads } from "../_shared/whatsapp/payloads.ts";
import { computeSignature, isValidSignature, timingSafeEqual } from "../_shared/whatsapp/signature.ts";
import { parseWebhook } from "../_shared/whatsapp/webhook-parser.ts";

Deno.test("firma HMAC-SHA256 coincide con un vector conocido", async () => {
  // echo -n '{"a":1}' | openssl dgst -sha256 -hmac secreto
  const sig = await computeSignature("secreto", '{"a":1}');
  assertEquals(sig.length, 64);
  assert(await isValidSignature("secreto", '{"a":1}', `sha256=${sig}`));
  assert(await isValidSignature("secreto", '{"a":1}', `sha256=${sig.toUpperCase()}`));
  assertEquals(await isValidSignature("secreto", '{"a":2}', `sha256=${sig}`), false);
  assertEquals(await isValidSignature("", '{"a":1}', `sha256=${sig}`), false, "sin secreto nunca es válido");
  assertEquals(await isValidSignature("secreto", '{"a":1}', sig), false, "falta prefijo");
  assertEquals(await isValidSignature("secreto", '{"a":1}', null), false);
  assertEquals(timingSafeEqual("abc", "abc"), true);
  assertEquals(timingSafeEqual("abc", "abd"), false);
  assertEquals(timingSafeEqual("abc", "abcd"), false);
});

Deno.test("payloads respetan los límites de WhatsApp", () => {
  const longTitle = "Jugo especial de la casa con mucha fruta";
  const rows = Array.from({ length: 14 }, (_, i) => ({ id: `prod:${i}`, title: longTitle, description: "x".repeat(100) }));
  const [list] = toPayloads("51987654321", {
    type: "list", body: "Elige", buttonLabel: "Ver todas las opciones del menú", sections: [{ title: "Opciones", rows }],
  });
  // deno-lint-ignore no-explicit-any
  const action = (list as any).interactive.action;
  assertEquals(action.sections[0].rows.length, LIMITS.maxRows);
  assert(Array.from(action.sections[0].rows[0].title as string).length <= LIMITS.rowTitle);
  assert(Array.from(action.sections[0].rows[0].description as string).length <= LIMITS.rowDescription);
  assert(Array.from(action.button as string).length <= LIMITS.listButton);

  const [buttons] = toPayloads("51987654321", {
    type: "buttons", body: "¿?", buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: longTitle })),
  });
  // deno-lint-ignore no-explicit-any
  const btns = (buttons as any).interactive.action.buttons;
  assertEquals(btns.length, 3);
  assert(btns.every((b: { reply: { title: string } }) => Array.from(b.reply.title).length <= LIMITS.buttonTitle));

  const long = toPayloads("51987654321", { type: "buttons", body: "a".repeat(2000), buttons: [{ id: "x", title: "X" }] });
  assertEquals(long.length, 2, "texto largo se envía aparte");
  assertEquals(long[0].type, "text");
});

function fakeFetch(responses: Array<{ status: number; body: unknown } | "network">) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift() ?? { status: 200, body: { messages: [{ id: "wamid.ok" }] } };
    if (next === "network") return Promise.reject(new TypeError("network down"));
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
  };
  return { fn: fn as typeof fetch, calls };
}

const cfg = { token: "EAAtokensecretodeprueba1234567890", phoneNumberId: "1234567890" };
const noSleep = () => Promise.resolve();

Deno.test("cliente: envía a la Graph API con el token en el encabezado", async () => {
  const f = fakeFetch([{ status: 200, body: { messages: [{ id: "wamid.abc" }] } }]);
  const client = createWhatsAppClient(cfg, { fetchFn: f.fn, sleep: noSleep });
  const res = await client.sendReply("51987654321", { type: "text", body: "hola" });
  assertEquals(res, { ok: true, messageId: "wamid.abc" });
  assertEquals(f.calls[0].url, "https://graph.facebook.com/v23.0/1234567890/messages");
  assertEquals((f.calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${cfg.token}`);
  const body = JSON.parse(String(f.calls[0].init.body));
  assertEquals(body.messaging_product, "whatsapp");
  assertEquals(body.to, "51987654321");
});

Deno.test("cliente: reintenta errores 5xx, 429 y de red", async () => {
  const f = fakeFetch(["network", { status: 503, body: {} }, { status: 200, body: { messages: [{ id: "w" }] } }]);
  const client = createWhatsAppClient(cfg, { fetchFn: f.fn, sleep: noSleep });
  const res = await client.sendReply("51987654321", { type: "text", body: "hola" });
  assert(res.ok);
  assertEquals(f.calls.length, 3);

  const g = fakeFetch([{ status: 429, body: { error: { code: 130429 } } }, { status: 429, body: { error: { code: 130429 } } }, { status: 429, body: { error: { code: 130429 } } }]);
  const c2 = createWhatsAppClient(cfg, { fetchFn: g.fn, sleep: noSleep });
  const r2 = await c2.sendReply("51987654321", { type: "text", body: "hola" });
  assertEquals(r2.ok, false);
  assertEquals(g.calls.length, 3, "máximo 3 intentos");
});

Deno.test("cliente: NO reintenta errores permanentes y detecta ventana de 24 h", async () => {
  const f = fakeFetch([{ status: 400, body: { error: { code: 131047, message: "Re-engagement message" } } }]);
  const client = createWhatsAppClient(cfg, { fetchFn: f.fn, sleep: noSleep });
  const res = await client.sendReply("51987654321", { type: "text", body: "hola" });
  assertEquals(f.calls.length, 1);
  assertEquals(res.ok, false);
  if (!res.ok) {
    assertEquals(res.outsideWindow, true);
    assertEquals(res.code, 131047);
  }
});

Deno.test("cliente: plantilla con parámetros", async () => {
  const f = fakeFetch([]);
  const client = createWhatsAppClient(cfg, { fetchFn: f.fn, sleep: noSleep });
  await client.sendTemplate("51987654321", "actualizacion_pedido", "es", ["101", "Listo"]);
  const body = JSON.parse(String(f.calls[0].init.body));
  assertEquals(body.type, "template");
  assertEquals(body.template.name, "actualizacion_pedido");
  assertEquals(body.template.components[0].parameters, [{ type: "text", text: "101" }, { type: "text", text: "Listo" }]);
});

Deno.test("registros: nunca incluyen tokens, textos ni teléfonos completos", () => {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (l: string) => lines.push(l);
  try {
    log("error", "prueba", {
      token: "EAAsecreto",
      text: "mi dirección privada",
      error: errorMessage(new Error(`fallo Bearer EAAabcdefghijklmnopqrstuvwxyz123 para 51987654321`)),
      from: maskPhone("51987654321"),
    });
  } finally {
    Object.assign(console, orig);
  }
  const out = lines.join("\n");
  assertEquals(out.includes("EAAsecreto"), false);
  assertEquals(out.includes("EAAabcdefghijklmnopqrstuvwxyz123"), false);
  assertEquals(out.includes("mi dirección privada"), false);
  assertEquals(out.includes("51987654321"), false);
  assertStringIncludes(out, "51******321");
});

Deno.test("parser: tipos de mensaje y datos mal formados", () => {
  const wrap = (msgs: unknown[]) => ({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "1" }, messages: msgs } }] }],
  });
  const base = { from: "51987654321", timestamp: "1760958000" };
  const parsed = parseWebhook(wrap([
    { ...base, id: "a", type: "text", text: { body: "hola" } },
    { ...base, id: "b", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "cat:jugos", title: "Jugos" } } },
    { ...base, id: "c", type: "audio", audio: {} },
    { ...base, id: "d", type: "reaction", reaction: {} },
    { ...base, id: "e", from: "no-es-numero", type: "text", text: { body: "x" } },
    "basura",
  ]), "1");
  assertEquals(parsed.messages.map((m) => m.input.type), ["text", "choice", "unsupported", "unsupported"]);
  assertEquals(parsed.messages[3].ignore, true);
  assertEquals(parsed.discarded, 2);
  assertEquals(parseWebhook({ object: "page" }, "1").messages.length, 0);
  assertEquals(parseWebhook(null, "1").messages.length, 0);
});

Deno.test("texto: normalización y validaciones", () => {
  assertEquals(normalize("  ¡Menú!! "), "menu");
  assertEquals(parseQuantity("x3"), 3);
  assertEquals(parseQuantity("3 unidades"), 3);
  assertEquals(parseQuantity("tres"), null);
  assertEquals(parseOrderNumber("#123"), { value: 123, explicit: true });
  assertEquals(parseOrderNumber("pedido 45"), { value: 45, explicit: true });
  assertEquals(parseOrderNumber("45"), { value: 45, explicit: false });
  assertEquals(cleanName("  rosa   maría "), "Rosa María");
  assertEquals(cleanName("DROP TABLE;"), null);
  assertEquals(cleanPeruvianMobile("987 654 321"), "51987654321");
  assertEquals(cleanPeruvianMobile("+51 987654321"), "51987654321");
  assertEquals(cleanPeruvianMobile("012345678"), null);
  assertEquals(cleanStall("  Puesto 45 <b> "), "Puesto 45 b");
  assertEquals(cleanStall("x".repeat(41)), null);
});
