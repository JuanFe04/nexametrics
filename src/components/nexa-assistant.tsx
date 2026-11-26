'use client'

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SendHorizontal, Sparkles, Square, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { useNexaContext } from '@/hooks/use-nexa-context'
import { askNexa } from '@/lib/assistant.functions'
import type { AssistantErrorCode, ChatMessage } from '@/lib/assistant.types'
import { cn } from '@/lib/utils'

const STORAGE_KEY = 'nexametrics:assistant:v1'
const MAX_HISTORY = 20

const SUGGESTIONS = [
  '¿Cuál fue el producto más vendido este mes?',
  '¿Por qué bajó el margen frente al mes pasado?',
  '¿Qué debería comprar la próxima semana?',
  '¿Quién es mi mejor cliente?',
  '¿Qué proveedor me vende más caro?',
  '¿Cómo exporto mis datos a Google Sheets?',
]

const ERRORS: Record<AssistantErrorCode | 'network', string> = {
  rate_limit: 'Nexa recibió demasiadas preguntas seguidas. Espera un momento y vuelve a intentarlo.',
  credits: 'Se agotaron los créditos de IA del proyecto. Recárgalos para seguir usando a Nexa.',
  config:
    'Nexa aún no está configurado: falta una clave de IA válida en el servidor (GROQ_API_KEY o GEMINI_API_KEY en Vercel). Pídele al administrador que la agregue.',
  unavailable: 'Nexa no está disponible en este momento. Inténtalo de nuevo en unos minutos.',
  network: 'No se pudo conectar con Nexa. Revisa tu conexión e inténtalo de nuevo.',
}

interface UiMessage extends ChatMessage {
  error?: boolean
}

function loadHistory(): UiMessage[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter(
          (m): m is UiMessage =>
            !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
        )
      : []
  } catch {
    return []
  }
}

const markdown: Components = {
  p: (props) => <p className="leading-relaxed [&:not(:first-child)]:mt-2" {...props} />,
  strong: (props) => <strong className="font-semibold text-[#5be3c7]" {...props} />,
  ul: (props) => <ul className="mt-2 list-disc space-y-1 pl-5" {...props} />,
  ol: (props) => <ol className="mt-2 list-decimal space-y-1 pl-5" {...props} />,
  h1: (props) => <h3 className="mt-3 font-semibold" {...props} />,
  h2: (props) => <h3 className="mt-3 font-semibold" {...props} />,
  h3: (props) => <h3 className="mt-3 font-semibold" {...props} />,
  code: (props) => <code className="rounded bg-white/10 px-1 py-0.5 text-[0.85em]" {...props} />,
  a: (props) => <a className="text-[#5be3c7] underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />,
  table: (props) => (
    <div className="mt-2 overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full text-left text-xs" {...props} />
    </div>
  ),
  th: (props) => <th className="border-b border-white/10 bg-white/5 px-2 py-1.5 font-semibold" {...props} />,
  td: (props) => <td className="border-b border-white/5 px-2 py-1.5 tabular-nums" {...props} />,
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1" aria-label="Nexa está escribiendo">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-1.5 rounded-full bg-[#20c6a5] motion-safe:animate-bounce"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  )
}

export function NexaAssistant() {
  const { ready, context } = useNexaContext()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const inputId = useId()

  useEffect(() => setMessages(loadHistory()), [])

  useEffect(() => {
    if (streaming) return
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_HISTORY)))
    } catch {
      // Almacenamiento bloqueado: el historial vive solo en memoria.
    }
  }, [messages, streaming])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [messages, open])

  useEffect(() => () => void readerRef.current?.cancel(), [])

  const send = useCallback(
    async (question: string) => {
      const text = question.trim()
      if (!text || streaming || !ready) return
      const history: UiMessage[] = [...messages, { role: 'user', content: text }]
      setMessages([...history, { role: 'assistant', content: '' }])
      setInput('')
      setStreaming(true)

      const setReply = (update: (current: UiMessage) => UiMessage) =>
        setMessages((current) => [...current.slice(0, -1), update(current[current.length - 1]!)])

      try {
        const result = await askNexa({
          data: {
            messages: history
              .filter((m) => !m.error && m.content)
              .slice(-MAX_HISTORY)
              .map(({ role, content }) => ({ role, content: content.slice(0, 4000) })),
            context,
          },
        })
        if (!result.ok) {
          setReply(() => ({ role: 'assistant', content: ERRORS[result.code], error: true }))
          return
        }
        const reader = result.stream.getReader()
        readerRef.current = reader
        const decoder = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          setReply((current) => ({ ...current, content: current.content + chunk }))
        }
        setReply((current) =>
          current.content ? current : { role: 'assistant', content: ERRORS.unavailable, error: true },
        )
      } catch {
        setReply((current) =>
          current.content ? current : { role: 'assistant', content: ERRORS.network, error: true },
        )
      } finally {
        readerRef.current = null
        setStreaming(false)
        inputRef.current?.focus()
      }
    },
    [context, messages, ready, streaming],
  )

  const stop = () => void readerRef.current?.cancel()

  const clear = () => {
    stop()
    setMessages([])
    inputRef.current?.focus()
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void send(input)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send(input)
    }
  }

  const last = messages[messages.length - 1]

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            size="icon-lg"
            className="fixed right-5 bottom-5 z-40 size-14 rounded-full bg-[#20c6a5] text-[#101b30] shadow-[0_0_28px_rgba(32,198,165,0.45)] hover:bg-[#3dd6b8] motion-safe:transition-transform motion-safe:hover:scale-105 print:hidden"
          />
        }
      >
        <Sparkles className="size-6" aria-hidden="true" />
        <span className="sr-only">Preguntar a Nexa, el asistente de IA</span>
      </SheetTrigger>

      <SheetContent
        side="right"
        initialFocus={inputRef}
        className="w-full gap-0 border-l border-[#20c6a5]/25 bg-[#101b30]/85 p-0 text-slate-100 backdrop-blur-xl data-[side=right]:sm:max-w-md [&>[data-slot=sheet-close]]:text-slate-300"
      >
        <SheetHeader className="border-b border-white/10 pr-24">
          <SheetTitle className="flex items-center gap-2 text-slate-50">
            <span className="grid size-7 place-items-center rounded-lg bg-[#20c6a5]/15 text-[#20c6a5]">
              <Sparkles className="size-4" aria-hidden="true" />
            </span>
            Nexa
          </SheetTitle>
          <SheetDescription className="text-slate-400">
            Pregunta sobre tus compras y ventas. Responde con los datos y filtros actuales.
          </SheetDescription>
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={clear}
              className="absolute top-3 right-12 text-slate-300 hover:bg-white/10 hover:text-white"
            >
              <Trash2 aria-hidden="true" />
              <span className="sr-only">Limpiar conversación</span>
            </Button>
          )}
        </SheetHeader>

        <div
          ref={logRef}
          role="log"
          aria-live="polite"
          aria-busy={streaming}
          aria-label="Conversación con Nexa"
          className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
        >
          {messages.length === 0 ? (
            <div className="my-auto flex flex-col gap-4">
              <p className="text-center text-slate-300">¿Qué quieres saber de tu negocio?</p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    disabled={!ready}
                    onClick={() => void send(suggestion)}
                    className="rounded-full border border-[#20c6a5]/35 bg-[#20c6a5]/10 px-3 py-1.5 text-left text-xs text-slate-100 outline-none transition-colors hover:bg-[#20c6a5]/20 focus-visible:ring-2 focus-visible:ring-[#20c6a5] disabled:opacity-50"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message, index) =>
              message.role === 'user' ? (
                <div
                  key={index}
                  className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-[#20c6a5] px-3.5 py-2 whitespace-pre-wrap text-[#101b30]"
                >
                  <span className="sr-only">Tú: </span>
                  {message.content}
                </div>
              ) : (
                <div
                  key={index}
                  className={cn(
                    'max-w-[92%] rounded-2xl rounded-bl-sm border px-3.5 py-2.5',
                    message.error
                      ? 'border-red-400/30 bg-red-500/10 text-red-100'
                      : 'border-white/10 bg-white/[0.06]',
                  )}
                >
                  <span className="sr-only">Nexa: </span>
                  {message.content ? (
                    message.error ? (
                      message.content
                    ) : (
                      <Markdown remarkPlugins={[remarkGfm]} components={markdown}>
                        {message.content}
                      </Markdown>
                    )
                  ) : (
                    <TypingDots />
                  )}
                </div>
              ),
            )
          )}
        </div>

        <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-white/10 p-3">
          <label htmlFor={inputId} className="sr-only">
            Escribe tu pregunta para Nexa
          </label>
          <textarea
            id={inputId}
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={2000}
            placeholder={ready ? 'Pregunta a Nexa…' : 'Cargando tus datos…'}
            disabled={!ready}
            className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus-visible:border-[#20c6a5] focus-visible:ring-2 focus-visible:ring-[#20c6a5]/40 field-sizing-content disabled:opacity-60"
          />
          {streaming ? (
            <Button
              type="button"
              size="icon-lg"
              onClick={stop}
              disabled={!last?.content}
              className="bg-white/10 text-slate-100 hover:bg-white/20"
            >
              <Square aria-hidden="true" />
              <span className="sr-only">Detener respuesta</span>
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon-lg"
              disabled={!ready || !input.trim()}
              className="bg-[#20c6a5] text-[#101b30] hover:bg-[#3dd6b8]"
            >
              <SendHorizontal aria-hidden="true" />
              <span className="sr-only">Enviar pregunta</span>
            </Button>
          )}
        </form>
      </SheetContent>
    </Sheet>
  )
}
