// Envía a tu Edge Function un webhook FIRMADO igual que lo haría Meta.
// Sirve para comprobar firma, base de datos y respuestas ANTES de conectar Meta.
// ⚠️ Es una simulación: NO demuestra que WhatsApp esté conectado. Esa prueba
//    solo se cumple escribiendo desde un celular real al número de WhatsApp.
//
// Uso (desde la raíz del repositorio):
//   export WEBHOOK_URL=https://TU-PROYECTO.supabase.co/functions/v1/whatsapp-webhook
//   export WHATSAPP_APP_SECRET=...        (el mismo configurado en Supabase)
//   export WHATSAPP_PHONE_NUMBER_ID=...   (el mismo configurado en Supabase)
//   export TEST_FROM=51987654321          (tu número; recibirás la respuesta si
//                                          está en la lista de destinatarios de prueba)
//   deno run --allow-env --allow-net scripts/send-test-webhook.ts "hola"
import { computeSignature } from "../supabase/functions/_shared/whatsapp/signature.ts";

const env = (name: string) => {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(`Falta la variable ${name}`);
    Deno.exit(1);
  }
  return v;
};

const url = env("WEBHOOK_URL");
const secret = env("WHATSAPP_APP_SECRET");
const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID");
const from = env("TEST_FROM");
const text = Deno.args[0] ?? "hola";

const payload = {
  object: "whatsapp_business_account",
  entry: [{
    id: "PRUEBA",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "000", phone_number_id: phoneNumberId },
        contacts: [{ profile: { name: "Prueba" }, wa_id: from }],
        messages: [{
          from,
          id: `wamid.prueba.${crypto.randomUUID()}`,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: "text",
          text: { body: text },
        }],
      },
    }],
  }],
};

const raw = JSON.stringify(payload);
const signature = await computeSignature(secret, raw);

const signed = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${signature}` },
  body: raw,
});
console.log(`Con firma correcta   -> HTTP ${signed.status} (esperado 200)`);
await signed.body?.cancel();

const unsigned = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + "0".repeat(64) },
  body: raw,
});
console.log(`Con firma falsa      -> HTTP ${unsigned.status} (esperado 401)`);
await unsigned.body?.cancel();
