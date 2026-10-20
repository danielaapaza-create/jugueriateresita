# 🥤 Juguería Teresita · Pedidos por WhatsApp

Un chatbot que funciona **dentro de WhatsApp**, usando la **API oficial de WhatsApp Business (Cloud API) de Meta**, para que las comerciantes del mercado pidan desayunos y jugos sin dejar su puesto. Viene con un **panel web privado** para el celular de la dueña.

> **Estado:** el código está completo y probado con pruebas automáticas (Deno + PostgreSQL). **Todavía no está conectado a WhatsApp.** Eso se confirma solo cuando completes la [etapa 7 de la guía](docs/02-guia-paso-a-paso.md#etapa-7--conectar-el-webhook-en-meta-y-hacer-la-prueba-real) con un mensaje real enviado y recibido.

## Qué hace

**Cliente (en WhatsApp):** escribe al número → recibe el menú con botones → consulta la carta con precios → elige productos y cantidades → revisa su carrito → da su nombre, teléfono y puesto → elige recojo o entrega → confirma → recibe su **número de pedido** → consulta el estado o lo anula (si las reglas lo permiten).

**Dueña (panel web en el celular):** inicia sesión → ve los pedidos por estado (por aceptar, aceptados, en preparación, listos, entregados, cancelados) → **acepta o rechaza** → marca *en preparación*, *listo* y *entregado* (el cliente recibe un aviso por WhatsApp) → gestiona productos, precios y agotados → pausa los pedidos cuando quiera.

## Arquitectura

```
 Celular del cliente                      Celular de la dueña
   (WhatsApp)                               (navegador)
       │                                        │
       ▼                                        ▼
 Meta WhatsApp Cloud API              Panel React (GitHub Pages)
       │  webhook firmado (HMAC)                │ Supabase Auth + RLS
       ▼                                        ▼
 Edge Function whatsapp-webhook      Edge Function admin-order-status
   · verifica firma                    · usa la sesión de la dueña
   · deduplica mensajes                · cambia estado (con reglas)
   · máquina de estados                · avisa al cliente (24 h / plantilla)
       │                                        │
       └──────────────►  PostgreSQL  ◄──────────┘
                (productos, pedidos, sesiones, mensajes procesados)
```

| Pieza | Tecnología | Carpeta |
|---|---|---|
| Base de datos y reglas de negocio | Supabase PostgreSQL (migraciones SQL) | `supabase/migrations/` |
| Bot de WhatsApp | Supabase Edge Function (Deno + TypeScript) | `supabase/functions/whatsapp-webhook/` |
| Cambios de estado desde el panel | Supabase Edge Function | `supabase/functions/admin-order-status/` |
| Lógica compartida (máquina de estados, cliente de WhatsApp) | TypeScript | `supabase/functions/_shared/` |
| Panel de administración | React + Vite + TypeScript | `admin/` |
| Pruebas | Deno test + PostgreSQL | `supabase/functions/tests/`, `supabase/tests/` |

## Documentación

1. [Plan técnico y decisiones](docs/01-plan-tecnico.md): estados, modelo de datos y seguridad.
2. [**Guía paso a paso**](docs/02-guia-paso-a-paso.md), pensada para quien está aprendiendo: qué instalar, qué comandos ejecutar y cómo verificar cada etapa.
3. [Reglas de WhatsApp](docs/03-reglas-whatsapp.md): ventana de 24 h, plantillas, costos y consentimiento.
4. [Manual de la dueña](docs/04-manual-de-la-duena.md): uso diario del panel.

## Probar en tu computadora (sin credenciales)

```bash
# Bot: pruebas de la conversación, webhook, firma, duplicados y errores
deno task test

# Base de datos: migraciones + pruebas de pedidos, seguridad y duplicados
./scripts/test-sql.sh          # requiere PostgreSQL instalado (no como root)

# Panel
cd admin && npm install && npm run build
```

## Seguridad en una línea por tema

- **Secretos** (`WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, service role…) solo en *Supabase → Edge Functions → Secrets*. Nunca en el panel, en GitHub ni en los registros.
- **Webhooks** sin firma `X-Hub-Signature-256` válida se rechazan (401).
- **Duplicados**: cada mensaje de WhatsApp se procesa una sola vez (`processed_messages`), y cada pedido tiene una clave única (`idempotency_key`).
- **Privacidad**: un número de WhatsApp solo ve y anula **sus** pedidos (la base de datos filtra por el número que escribe).
- **Estados**: solo una administradora puede cambiarlos, y solo con transiciones válidas (`pendiente → aceptado → en preparación → listo → entregado`).
- **Precios**: siempre los calcula PostgreSQL; cada línea del pedido guarda el precio del momento.
