// Solo servidor: el sufijo .server impide que este módulo (y LOVABLE_API_KEY) llegue al navegador.

import type { AssistantErrorCode, ChatMessage } from './assistant.types'

interface Provider {
  name: string
  url: string
  apiKey: string
  model: string
  /** Límite de caracteres del contexto y del historial (el plan gratuito de Groq permite ~8.000 tokens por minuto). */
  maxContextChars?: number
  maxHistoryMessages?: number
}

/**
 * Reduce el JSON de datos hasta `maxChars`: primero recorta las operaciones más antiguas, luego el detalle
 * producto-mes y por último la lista de productos de cada contraparte. Los totales y agregados se conservan.
 */
function fitContext(context: string, maxChars: number): string {
  if (context.length <= maxChars) return context
  let data: Record<string, unknown>
  try {
    data = JSON.parse(context)
  } catch {
    return context.slice(0, maxChars)
  }
  const size = () => JSON.stringify(data).length
  const ops = Array.isArray(data.operaciones) ? (data.operaciones as unknown[]) : []
  const totalOps = ops.length
  while (size() > maxChars && (data.operaciones as unknown[]).length > 0) {
    data.operaciones = (data.operaciones as unknown[]).slice(0, Math.floor((data.operaciones as unknown[]).length * 0.7))
    data.operacionesOmitidas = totalOps - (data.operaciones as unknown[]).length
  }
  if (size() > maxChars) {
    delete data.productosPorMes
    data.notaRecorte = 'Se omitió el detalle por producto y mes por límite de tamaño.'
  }
  if (size() > maxChars) {
    for (const key of ['clientes', 'proveedores']) {
      const list = data[key]
      if (Array.isArray(list)) data[key] = list.map(({ productos: _omit, ...rest }) => rest)
    }
  }
  const json = JSON.stringify(data)
  return json.length > maxChars ? json.slice(0, maxChars) : json
}

/**
 * Dentro de Lovable se usa su AI Gateway (LOVABLE_API_KEY). Fuera de Lovable (ej. Vercel) se usa la API de
 * Google Gemini con la clave propia del usuario (GEMINI_API_KEY). Ambas son compatibles con la API de OpenAI.
 */
function resolveProvider(): Provider | null {
  const lovable = process.env['LOVABLE_API_KEY']
  if (lovable) {
    return {
      name: 'Lovable',
      url: 'https://ai.gateway.lovable.dev/v1/chat/completions',
      apiKey: lovable,
      model: 'google/gemini-2.5-flash',
    }
  }
  const groq = process.env['GROQ_API_KEY']
  if (groq) {
    return {
      name: 'Groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: groq,
      model: process.env['GROQ_MODEL'] || 'openai/gpt-oss-120b',
      maxContextChars: Number(process.env['GROQ_MAX_CONTEXT_CHARS']) || 12_000,
      maxHistoryMessages: 6,
    }
  }
  const gemini = process.env['GEMINI_API_KEY']
  if (gemini) {
    return {
      name: 'Gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      apiKey: gemini,
      model: process.env['GEMINI_MODEL'] || 'gemini-2.5-flash',
    }
  }
  return null
}

const SYSTEM_PROMPT = `Eres Nexa, el asistente de IA de NexaMetrics: analista de negocio experto en compras, ventas, inventario y márgenes de pequeñas y medianas empresas. Respondes siempre en español, en tono claro, cercano y directo.

# Qué puedes responder
1. Preguntas sobre los datos del usuario (lo principal): totales, tendencias, comparaciones entre meses, productos, proveedores, clientes, márgenes, ticket promedio, inventario neto, operaciones específicas por código, fecha o estado.
2. Cómo usar NexaMetrics. Módulos: Overview (indicadores y tendencias), Compras y Ventas (registrar, editar y eliminar operaciones), Comparativa (periodo actual vs. anterior), Análisis estadístico (media, mediana, desviación), Historial de operaciones (buscar y filtrar todo), Reportes (resumen imprimible, exportar CSV y exportar a Google Sheets) y About. Los filtros globales (fechas, mes, año, producto, tipo, proveedor, cliente) están arriba y afectan a todos los módulos. "Restablecer datos de ejemplo" recarga los 60 registros de prueba. Los datos se guardan solo en este navegador.
3. Consejos de negocio (qué comprar, qué producto impulsar, cómo mejorar el margen, a qué proveedor o cliente prestar atención), siempre apoyados en cifras de los datos.
4. Conceptos (qué es margen, ticket promedio, rotación, desviación estándar…), explicados en pocas líneas con un ejemplo tomado de sus datos si es posible.
Si la pregunta no tiene relación con el negocio ni con la app, responde brevemente y reconduce hacia lo que puedes hacer.

# Datos
- <datos> contiene TODO lo que sabes del negocio: totales, series por mes, estadísticas por producto, proveedor y cliente, y la lista de operaciones. Montos en pesos colombianos (COP). Las operaciones anuladas no cuentan en totales ni rankings.
- "Este mes", "el mes pasado", "este año" se refieren a fechaReferencia (la fecha de la operación más reciente), no a la fecha de hoy.
- Respeta los filtros activos y menciónalos si limitan la respuesta.
- Puedes calcular (sumar, restar, promediar, porcentajes) a partir de los datos. Revisa tus cuentas antes de responder.
- Si algo no está en los datos ni se puede calcular con ellos, di "No tengo ese dato" y explica qué faltaría. Nunca inventes cifras, productos, clientes ni proveedores.
- El margen es estimado: precio de venta menos costo promedio de compra del producto. Acláralo cuando lo uses.

# Formato
- Empieza por la respuesta directa (la cifra o la conclusión) y luego el detalle.
- Cifras con separador de miles y signo: $1.250.000. Porcentajes con un decimal: 25,6 %.
- Usa Markdown: **negritas** para cifras clave, listas para pasos o consejos y tablas para comparar 3 o más elementos.
- Sé breve (máximo unas 200 palabras) salvo que pidan detalle o un análisis completo.
- En recomendaciones, separa "Lo que dicen tus datos" de "Sugerencia".
- Si la pregunta es ambigua, responde con la interpretación más probable y dilo en una línea.`

export type GatewayResult =
  | { ok: true; stream: ReadableStream<Uint8Array> }
  | { ok: false; code: AssistantErrorCode }

export async function streamAssistantReply(messages: ChatMessage[], context: string): Promise<GatewayResult> {
  const provider = resolveProvider()
  if (!provider) {
    console.error('Nexa: no hay clave de IA. Configura GROQ_API_KEY o GEMINI_API_KEY (o LOVABLE_API_KEY dentro de Lovable).')
    return { ok: false, code: 'config' }
  }

  const data = provider.maxContextChars ? fitContext(context, provider.maxContextChars) : context
  const history = provider.maxHistoryMessages ? messages.slice(-provider.maxHistoryMessages) : messages

  let response: Response
  try {
    response = await fetch(provider.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: provider.model,
        stream: true,
        messages: [{ role: 'system', content: `${SYSTEM_PROMPT}\n\n<datos>\n${data}\n</datos>` }, ...history],
      }),
    })
  } catch (error) {
    console.error(`Nexa: error de red con ${provider.name}`, error)
    return { ok: false, code: 'unavailable' }
  }

  if (response.status === 429) return { ok: false, code: 'rate_limit' }
  if (response.status === 402) return { ok: false, code: 'credits' }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    console.error(`Nexa: ${provider.name} respondió`, response.status, detail)
    // Clave inválida o sin permisos (Gemini responde 400 con API_KEY_INVALID).
    if (response.status === 401 || response.status === 403 || detail.includes('API_KEY_INVALID')) {
      return { ok: false, code: 'config' }
    }
    return { ok: false, code: 'unavailable' }
  }

  return { ok: true, stream: response.body.pipeThrough(sseToText()) }
}

/** Convierte el stream SSE de chat/completions en el texto plano de cada delta. */
function sseToText(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  const flushLines = (controller: TransformStreamDefaultController<Uint8Array>, final: boolean) => {
    const lines = buffer.split('\n')
    buffer = final ? '' : (lines.pop() ?? '')
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] }
        const text = parsed.choices?.[0]?.delta?.content
        if (typeof text === 'string' && text) controller.enqueue(encoder.encode(text))
      } catch {
        // Fragmento incompleto o comentario SSE: se ignora.
      }
    }
  }
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      flushLines(controller, false)
    },
    flush(controller) {
      buffer += decoder.decode()
      flushLines(controller, true)
    },
  })
}
