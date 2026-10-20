// Lógica HTTP del webhook, separada de index.ts para poder probarla con
// dependencias falsas (sin red, sin base de datos).
import { handleMessage, newSession } from "../_shared/bot/state-machine.ts";
import type { BotRepository, MessageLedger, SessionStore } from "../_shared/bot/types.ts";
import { errorMessage, log, maskPhone } from "../_shared/log.ts";
import type { Sender } from "../_shared/whatsapp/client.ts";
import { isValidSignature, timingSafeEqual } from "../_shared/whatsapp/signature.ts";
import { type InboundMessage, parseWebhook } from "../_shared/whatsapp/webhook-parser.ts";

export interface WebhookConfig {
  verifyToken: string;
  appSecret: string;
  phoneNumberId: string;
}

export interface WebhookDeps {
  config: WebhookConfig;
  ledger: MessageLedger;
  sessions: SessionStore;
  repo: BotRepository;
  sender: Sender;
  now?: () => Date;
  newId?: () => string;
}

/** Mensajes más antiguos que esto (p. ej. reintentos tras una caída) no se procesan. */
export const MAX_MESSAGE_AGE_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const SAVE_ATTEMPTS = 3;

const APOLOGY =
  "😔 Tuvimos un problema técnico al procesar tu mensaje. Por favor, escríbelo de nuevo en un momento.";

export function createWebhookHandler(deps: WebhookDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // 1) Verificación del webhook (Meta la hace una vez al configurarlo)
    if (req.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token") ?? "";
      const challenge = url.searchParams.get("hub.challenge") ?? "";
      if (mode === "subscribe" && deps.config.verifyToken && timingSafeEqual(token, deps.config.verifyToken)) {
        log("info", "webhook_verified");
        return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      log("warn", "webhook_verification_rejected");
      return new Response("Forbidden", { status: 403 });
    }

    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    // 2) Autenticidad: firma HMAC del cuerpo exacto
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return new Response("Payload Too Large", { status: 413 });
    }
    const signatureOk = await isValidSignature(
      deps.config.appSecret,
      raw,
      req.headers.get("x-hub-signature-256"),
    );
    if (!signatureOk) {
      log("warn", "webhook_invalid_signature");
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      log("warn", "webhook_invalid_json");
      return new Response("Bad Request", { status: 400 });
    }

    const parsed = parseWebhook(payload, deps.config.phoneNumberId);
    if (parsed.discarded) log("warn", "webhook_messages_discarded", { count: parsed.discarded });

    // 3) Procesar mensajes en orden
    let mustRetry = false;
    for (const message of parsed.messages) {
      const outcome = await processMessage(message);
      if (outcome === "retry") mustRetry = true;
    }

    // 500 solo si no pudimos ni registrar el mensaje (BD caída): Meta reintentará.
    return mustRetry
      ? new Response("Temporary error", { status: 500 })
      : new Response("OK", { status: 200 });
  };

  async function processMessage(message: InboundMessage): Promise<"ok" | "retry"> {
    const who = maskPhone(message.from);
    let claimed: boolean;
    try {
      claimed = await deps.ledger.claim(message.id);
    } catch (err) {
      log("error", "ledger_unavailable", { from: who, error: errorMessage(err) });
      return "retry";
    }
    if (!claimed) {
      log("info", "duplicate_message_ignored", { from: who });
      return "ok";
    }

    try {
      if (message.ignore) {
        await deps.ledger.finish(message.id, "skipped");
        return "ok";
      }
      const age = now().getTime() - message.timestamp.getTime();
      if (age > MAX_MESSAGE_AGE_MS) {
        log("warn", "stale_message_skipped", { from: who, ageSeconds: Math.round(age / 1000) });
        await deps.ledger.finish(message.id, "skipped", "mensaje antiguo");
        return "ok";
      }

      void deps.sender.markRead(message.id);

      // Bloqueo optimista: si otro mensaje del mismo cliente cambió la sesión
      // mientras procesábamos, se vuelve a cargar y procesar.
      let result = null;
      for (let attempt = 1; attempt <= SAVE_ATTEMPTS && !result; attempt++) {
        const session = (await deps.sessions.load(message.from)) ?? newSession(message.from);
        const candidate = await handleMessage(session, message.input, {
          repo: deps.repo,
          now: now(),
          newId,
          profileName: message.profileName,
        });
        if (await deps.sessions.save(candidate.session, message.timestamp)) result = candidate;
        else log("warn", "session_conflict_retry", { from: who, attempt });
      }
      if (!result) throw new Error("SESSION_CONFLICT");

      // Enviar respuestas en orden; si una falla, las siguientes no tendrían sentido.
      let sendError: string | undefined;
      for (const reply of result.replies) {
        const sent = await deps.sender.sendReply(message.from, reply);
        if (!sent.ok) {
          sendError = `envío falló: status ${sent.status} code ${sent.code ?? "-"}`;
          break;
        }
      }
      await deps.ledger.finish(message.id, "done", sendError);
      log(sendError ? "warn" : "info", "message_processed", {
        from: who,
        state: result.session.state,
        replies: result.replies.length,
        sendError,
      });
      return "ok";
    } catch (err) {
      log("error", "message_processing_failed", { from: who, error: errorMessage(err) });
      await deps.ledger.finish(message.id, "failed", errorMessage(err)).catch(() => {});
      await deps.sender.sendReply(message.from, { type: "text", body: APOLOGY }).catch(() => {});
      return "ok";
    }
  }
}
