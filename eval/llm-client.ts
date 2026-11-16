/**
 * The model side of the eval: an OpenAI-compatible chat/completions client,
 * provider-neutral (PET_EVAL_BASE_URL / PET_EVAL_API_KEY / PET_EVAL_MODEL),
 * plus the ToolDefinition → JSON-Schema tools conversion the wire needs.
 * @module dsh-agentic-pet/eval/llm-client
 */

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
}

export const evalConfigFromEnv = (): LlmConfig | null => {
  const baseUrl = process.env.PET_EVAL_BASE_URL
  const apiKey = process.env.PET_EVAL_API_KEY
  const model = process.env.PET_EVAL_MODEL
  if (baseUrl === undefined || apiKey === undefined || model === undefined || baseUrl === '' || apiKey === '' || model === '') return null
  const temperature = Number(process.env.PET_EVAL_TEMPERATURE ?? '0.2')
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
    temperature: Number.isFinite(temperature) ? temperature : 0.2,
  }
}

export interface ToolDescriptor {
  name: string
  description: string
  parameters: Record<string, { type?: unknown; required?: unknown; description?: unknown }>
}

interface RawParameter {
  type?: unknown
  required?: unknown
  description?: unknown
}

/** ToolDefinition.parameters is the plugin's flat shape
 * ({ key: { type, required, description } }); the wire wants JSON Schema. */
export const parametersToSchema = (parameters: Record<string, RawParameter>): Record<string, unknown> => {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, item] of Object.entries(parameters)) {
    properties[key] = {
      type: typeof item.type === 'string' ? item.type : 'string',
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
    }
    if (item.required === true) required.push(key)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>
    }
  }>
  error?: { message?: unknown }
}

export interface TurnResult {
  text?: string
  toolCalls?: Array<{ id: string; name: string; argsJson: string }>
  rawError?: string
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** One chat turn with backoff retries on 429/5xx/network/timeout. */
export const chatCompletion = async (
  config: LlmConfig,
  messages: OpenAiMessage[],
  tools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
  timeoutMs = 180_000,
): Promise<TurnResult> => {
  const body = JSON.stringify({
    model: config.model,
    messages,
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    temperature: config.temperature,
  })
  let lastError = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1_000 * 3 ** (attempt - 1))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body,
        signal: controller.signal,
      })
      if (response.status === 429 || response.status >= 500) {
        lastError = `HTTP ${String(response.status)}: ${(await response.text()).slice(0, 300)}`
        continue
      }
      if (!response.ok) {
        return { rawError: `HTTP ${String(response.status)}: ${(await response.text()).slice(0, 500)}` }
      }
      const payload = await response.json() as ChatResponse
      if (payload.error !== undefined) {
        return { rawError: `provider error: ${String(payload.error.message ?? 'unknown')}` }
      }
      const message = payload.choices?.[0]?.message
      if (message === undefined) return { rawError: 'empty response choices' }
      const toolCalls = (message.tool_calls ?? []).map((call, index) => ({
        id: typeof call.id === 'string' ? call.id : `call_${String(index)}`,
        name: typeof call.function?.name === 'string' ? call.function.name : '',
        argsJson: typeof call.function?.arguments === 'string' ? call.function.arguments : '{}',
      })).filter(call => call.name !== '')
      return {
        ...(typeof message.content === 'string' && message.content !== '' ? { text: message.content } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      }
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
    }
  }
  return { rawError: `retries exhausted: ${lastError}` }
}

export const buildToolsForWire = (tools: ToolDescriptor[]): Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> =>
  tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: parametersToSchema(tool.parameters),
    },
  }))
