// Envío de mensajes con la WhatsApp Cloud API oficial (Graph API de Meta).
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
import type { Reply } from "../bot/types.ts";
import { errorMessage, log, maskPhone } from "../log.ts";
import { toPayloads, type WhatsAppPayload } from "./payloads.ts";

export interface WhatsAppConfig {
  token: string;
  phoneNumberId: string;
  apiVersion?: string;
}

export type SendResult =
  | { ok: true; messageId?: string }
  | { ok: false; status: number; code?: number; title?: string; outsideWindow: boolean };

export interface Sender {
  sendReply(to: string, reply: Reply): Promise<SendResult>;
  sendTemplate(to: string, name: string, language: string, params: string[]): Promise<SendResult>;
  markRead(messageId: string): Promise<void>;
}

/** Error 131047: han pasado más de 24 h desde el último mensaje del cliente. */
export const OUTSIDE_WINDOW_CODE = 131047;
/** Errores de límite de velocidad: se reintentan con espera. */
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131056]);

const DEFAULT_API_VERSION = "v23.0";

export interface ClientOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
}

export function createWhatsAppClient(config: WhatsAppConfig, opts: ClientOptions = {}): Sender {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const url = `https://graph.facebook.com/${config.apiVersion ?? DEFAULT_API_VERSION}/${config.phoneNumberId}/messages`;

  async function post(payload: WhatsAppPayload): Promise<SendResult> {
    let last: SendResult = { ok: false, status: 0, outsideWindow: false };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let retryable = false;
      try {
        const res = await fetchFn(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const data = await res.json().catch(() => ({})) as {
          messages?: { id?: string }[];
          error?: { code?: number; error_subcode?: number; message?: string; error_data?: { details?: string } };
        };
        if (res.ok) return { ok: true, messageId: data.messages?.[0]?.id };

        const code = data.error?.code;
        last = {
          ok: false,
          status: res.status,
          code,
          title: data.error?.message?.slice(0, 120),
          outsideWindow: code === OUTSIDE_WINDOW_CODE,
        };
        retryable = res.status >= 500 || res.status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code));
        log("warn", "whatsapp_send_failed", {
          to: maskPhone(String(payload.to ?? "")),
          status: res.status,
          code,
          attempt,
          retryable,
        });
      } catch (err) {
        // Red caída o tiempo de espera agotado
        retryable = true;
        last = { ok: false, status: 0, title: errorMessage(err), outsideWindow: false };
        log("warn", "whatsapp_send_network_error", { attempt, error: errorMessage(err) });
      }
      if (!retryable || attempt === maxAttempts) break;
      await sleep(400 * 3 ** (attempt - 1)); // 400 ms, 1.2 s, ...
    }
    return last;
  }

  return {
    async sendReply(to, reply) {
      let result: SendResult = { ok: true };
      for (const payload of toPayloads(to, reply)) {
        result = await post(payload);
        if (!result.ok) return result;
      }
      return result;
    },

    sendTemplate(to, name, language, params) {
      return post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "template",
        template: {
          name,
          language: { code: language },
          components: params.length
            ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }]
            : [],
        },
      });
    },

    async markRead(messageId) {
      // Doble check azul: buena señal para el cliente. No es crítico.
      try {
        const res = await fetchFn(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        await res.body?.cancel();
      } catch (err) {
        log("warn", "whatsapp_mark_read_failed", { error: errorMessage(err) });
      }
    },
  };
}
