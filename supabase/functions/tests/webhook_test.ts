// Pruebas del webhook: verificación GET, firma, duplicados, errores y reintentos.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { computeSignature } from "../_shared/whatsapp/signature.ts";
import { createWebhookHandler, MAX_MESSAGE_AGE_MS } from "../whatsapp-webhook/handler.ts";
import { FakeSender, MemoryLedger, MemoryRepo, MemorySessions, replyText } from "./fakes.ts";

const SECRET = "app-secret-de-prueba";
const PHONE_ID = "123456789012345";
const NOW = new Date("2026-10-20T11:00:00Z");
const URL_BASE = "https://example.supabase.co/functions/v1/whatsapp-webhook";

function setup() {
  const deps = {
    config: { verifyToken: "verificame", appSecret: SECRET, phoneNumberId: PHONE_ID },
    ledger: new MemoryLedger(),
    sessions: new MemorySessions(),
    repo: new MemoryRepo(),
    sender: new FakeSender(),
    now: () => NOW,
  };
  return { ...deps, handle: createWebhookHandler(deps) };
}

function textMessage(id: string, body: string, opts: { from?: string; phoneId?: string; at?: Date } = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "51900000000", phone_number_id: opts.phoneId ?? PHONE_ID },
          contacts: [{ profile: { name: "Rosa" }, wa_id: opts.from ?? "51987654321" }],
          messages: [{
            from: opts.from ?? "51987654321",
            id,
            timestamp: String(Math.floor((opts.at ?? NOW).getTime() / 1000)),
            type: "text",
            text: { body },
          }],
        },
      }],
    }],
  };
}

async function signedPost(handle: (r: Request) => Promise<Response>, payload: unknown, secret = SECRET) {
  const raw = JSON.stringify(payload);
  const sig = await computeSignature(secret, raw);
  return handle(new Request(URL_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${sig}` },
    body: raw,
  }));
}

Deno.test("GET: verificación correcta devuelve el challenge", async () => {
  const { handle } = setup();
  const res = await handle(new Request(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=verificame&hub.challenge=12345`));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "12345");
});

Deno.test("GET: token incorrecto o modo incorrecto -> 403", async () => {
  const { handle } = setup();
  for (const qs of ["hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1", "hub.mode=unsubscribe&hub.verify_token=verificame&hub.challenge=1", ""]) {
    const res = await handle(new Request(`${URL_BASE}?${qs}`));
    assertEquals(res.status, 403);
    await res.body?.cancel();
  }
});

Deno.test("POST sin firma, firma inválida o secreto distinto -> 401 y no se procesa", async () => {
  const { handle, sender, ledger } = setup();
  const payload = textMessage("wamid.1", "hola");
  const noSig = await handle(new Request(URL_BASE, { method: "POST", body: JSON.stringify(payload) }));
  assertEquals(noSig.status, 401);
  const badSig = await handle(new Request(URL_BASE, {
    method: "POST",
    headers: { "X-Hub-Signature-256": "sha256=" + "0".repeat(64) },
    body: JSON.stringify(payload),
  }));
  assertEquals(badSig.status, 401);
  const otherSecret = await signedPost(handle, payload, "otro-secreto");
  assertEquals(otherSecret.status, 401);
  // Cuerpo alterado después de firmar
  const raw = JSON.stringify(payload);
  const sig = await computeSignature(SECRET, raw);
  const tampered = await handle(new Request(URL_BASE, {
    method: "POST",
    headers: { "X-Hub-Signature-256": `sha256=${sig}` },
    body: raw.replace("hola", "HOLA"),
  }));
  assertEquals(tampered.status, 401);
  for (const r of [noSig, badSig, otherSecret, tampered]) await r.body?.cancel();
  assertEquals(sender.sent.length, 0);
  assertEquals(ledger.rows.size, 0);
});

Deno.test("POST válido: responde al cliente y guarda la sesión", async () => {
  const { handle, sender, sessions, ledger } = setup();
  const res = await signedPost(handle, textMessage("wamid.1", "hola"));
  assertEquals(res.status, 200);
  assertEquals(sender.sent.length, 1);
  assertEquals(sender.sent[0].to, "51987654321");
  assertStringIncludes(replyText(sender.sent[0].reply), "Bienvenido(a)");
  assertEquals(sessions.rows.get("51987654321")?.state, "main_menu");
  assertEquals(ledger.rows.get("wamid.1")?.status, "done");
  assertEquals(sender.read, ["wamid.1"]);
});

Deno.test("DUPLICADOS: el mismo mensaje reenviado por Meta se procesa una sola vez", async () => {
  const { handle, sender } = setup();
  await signedPost(handle, textMessage("wamid.1", "hola"));
  await signedPost(handle, textMessage("wamid.2", "1"));
  const before = sender.sent.length;
  const again = await signedPost(handle, textMessage("wamid.2", "1"));
  assertEquals(again.status, 200);
  assertEquals(sender.sent.length, before);
});

Deno.test("mensajes de otro número de la cuenta se ignoran", async () => {
  const { handle, sender } = setup();
  const res = await signedPost(handle, textMessage("wamid.1", "hola", { phoneId: "999" }));
  assertEquals(res.status, 200);
  assertEquals(sender.sent.length, 0);
});

Deno.test("avisos de estado (entregado/leído) no generan respuestas", async () => {
  const { handle, sender } = setup();
  const payload = {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      metadata: { phone_number_id: PHONE_ID },
      statuses: [{ id: "wamid.x", status: "delivered", recipient_id: "51987654321" }],
    } }] }],
  };
  const res = await signedPost(handle, payload);
  assertEquals(res.status, 200);
  assertEquals(sender.sent.length, 0);
});

Deno.test("mensajes antiguos (reintentos tras una caída) no se procesan", async () => {
  const { handle, sender, ledger } = setup();
  const old = new Date(NOW.getTime() - MAX_MESSAGE_AGE_MS - 60_000);
  await signedPost(handle, textMessage("wamid.old", "1", { at: old }));
  assertEquals(sender.sent.length, 0);
  assertEquals(ledger.rows.get("wamid.old")?.status, "skipped");
});

Deno.test("BD caída al registrar el mensaje -> 500 para que Meta reintente", async () => {
  const { handle, ledger, sender } = setup();
  ledger.down = true;
  const res = await signedPost(handle, textMessage("wamid.1", "hola"));
  assertEquals(res.status, 500);
  assertEquals(sender.sent.length, 0);
});

Deno.test("error inesperado: se disculpa, marca fallo y responde 200", async () => {
  const { handle, repo, sender, ledger } = setup();
  repo.getSettings = () => Promise.reject(new Error("timeout de base de datos"));
  const res = await signedPost(handle, textMessage("wamid.1", "hola"));
  assertEquals(res.status, 200);
  assertEquals(ledger.rows.get("wamid.1")?.status, "failed");
  assertStringIncludes(replyText(sender.sent[0].reply), "problema técnico");
});

Deno.test("conflicto de sesión (dos mensajes a la vez): se reintenta y no se pierde", async () => {
  const { handle, sessions, sender } = setup();
  await signedPost(handle, textMessage("wamid.1", "hola"));
  sessions.conflicts = 2;
  const res = await signedPost(handle, textMessage("wamid.2", "1"));
  assertEquals(res.status, 200);
  assertEquals(sessions.rows.get("51987654321")?.state, "selecting_category");
  assertEquals(sender.sent.length, 2);
});

Deno.test("conflicto persistente: falla controlada sin respuestas a medias", async () => {
  const { handle, sessions, sender, ledger } = setup();
  await signedPost(handle, textMessage("wamid.1", "hola"));
  sessions.conflicts = 10;
  await signedPost(handle, textMessage("wamid.2", "1"));
  assertEquals(ledger.rows.get("wamid.2")?.status, "failed");
  assertStringIncludes(replyText(sender.sent[1].reply), "problema técnico");
});

Deno.test("si WhatsApp rechaza el envío se registra sin romper el flujo", async () => {
  const { handle, sender, ledger } = setup();
  sender.nextResults.push({ ok: false, status: 400, code: 131026, outsideWindow: false });
  const res = await signedPost(handle, textMessage("wamid.1", "hola"));
  assertEquals(res.status, 200);
  assertEquals(ledger.rows.get("wamid.1")?.status, "done");
  assert(ledger.rows.get("wamid.1")?.error?.includes("131026"));
});

Deno.test("JSON inválido con firma válida -> 400", async () => {
  const { handle } = setup();
  const raw = "{no es json";
  const sig = await computeSignature(SECRET, raw);
  const res = await handle(new Request(URL_BASE, {
    method: "POST",
    headers: { "X-Hub-Signature-256": `sha256=${sig}` },
    body: raw,
  }));
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("métodos no permitidos -> 405", async () => {
  const { handle } = setup();
  const res = await handle(new Request(URL_BASE, { method: "PUT" }));
  assertEquals(res.status, 405);
  await res.body?.cancel();
});

Deno.test("conversación real por webhook hasta crear el pedido", async () => {
  const { handle, repo, sender } = setup();
  let n = 0;
  const say = (text: string) => signedPost(handle, textMessage(`wamid.${++n}`, text));
  const tap = (id: string) => {
    const payload = textMessage(`wamid.${++n}`, "");
    // deno-lint-ignore no-explicit-any
    const msg = payload.entry[0].changes[0].value.messages[0] as any;
    msg.type = "interactive";
    delete msg.text;
    msg.interactive = { type: "button_reply", button_reply: { id, title: id } };
    return signedPost(handle, payload);
  };
  await say("hola");
  await say("1");
  await say("jugos");
  await say("jugo de papaya");
  await say("2");
  await say("finalizar");
  await tap("name:wa");
  await tap("phone:wa");
  await tap("delivery:pickup");
  await say("si");
  assertEquals(repo.orders.length, 1);
  assertEquals(repo.orders[0].customerName, "Rosa");
  assertEquals(repo.orders[0].totalCents, 1000);
  assertStringIncludes(replyText(sender.sent.at(-1)!.reply), "¿Deseas algo más?");
  assertStringIncludes(replyText(sender.sent.at(-1)!.reply), "RECIBIDO");
});
