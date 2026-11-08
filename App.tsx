import { useEffect, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  Textarea,
  cn,
} from './ui'

/* ---------- Настройки ---------- */
const PROXY = 'https://dvachpoezd.app.n8n.cloud/webhook/imggen-proxy'
const DEFAULT_ENDPOINT = 'https://api.fastrouter.ai/v1/interactions'

const MODELS = [
  { id: 'google/gemini-nano-banana-2.1', label: 'Nano Banana 2.1', maxTokens: 65536, pro: false },
  { id: 'google/gemini-3-pro-image-preview', label: 'Gemini 3 Pro Image', maxTokens: 32768, pro: true },
]
const RATIOS = ['1:1', '5:4', '4:5', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '4:1', '1:4', '8:1', '1:8']
const SIZES = ['1K', '2K', '4K']
const SAFETY = ['hate_speech', 'dangerous_content', 'harassment', 'sexually_explicit', 'jailbreak'].map((type) => ({
  type,
  threshold: 'off',
  method: 'probability',
}))

/* ---------- Типы ---------- */
type Ref =
  | { id: string; kind: 'url'; url: string }
  | { id: string; kind: 'file'; name: string; mime: string; data: string }

type Result = { imgs: string[]; texts: string[] }

/* ---------- Вспомогательные функции ---------- */
function load(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* хранилище недоступно */
  }
}
function sniff(b64: string) {
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('iVBOR')) return 'image/png'
  if (b64.startsWith('UklGR')) return 'image/webp'
  return 'image/png'
}
function uid() {
  return Math.random().toString(36).slice(2, 10)
}
function readFile(file: File): Promise<Ref> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      resolve({ id: uid(), kind: 'file', name: file.name, mime: file.type || 'image/png', data: s.slice(s.indexOf(',') + 1) })
    }
    r.onerror = () => reject(new Error('Не удалось прочитать файл ' + file.name))
    r.readAsDataURL(file)
  })
}
function parseResult(j: any): Result {
  const imgs: string[] = []
  const texts: string[] = []
  const take = (c: any) => {
    if (!c || typeof c !== 'object') return
    if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text)
    if (c.type === 'image') {
      if (typeof c.data === 'string' && c.data) imgs.push(`data:${sniff(c.data)};base64,${c.data}`)
      else if (typeof c.uri === 'string' && c.uri) imgs.push(c.uri)
    }
  }
  if (Array.isArray(j?.steps)) {
    j.steps.forEach((s: any) => {
      if (s?.type === 'model_output' && Array.isArray(s.content)) s.content.forEach(take)
    })
  }
  if (!imgs.length && Array.isArray(j?.outputs)) j.outputs.forEach(take)
  return { imgs, texts }
}

/* ---------- Приложение ---------- */
export default function App() {
  const [endpoint, setEndpoint] = useState(() => load('endpoint', DEFAULT_ENDPOINT))
  const [apiKey, setApiKey] = useState(() => load('k', ''))
  const [model, setModel] = useState(() => load('model', MODELS[0].id))
  const [provider, setProvider] = useState('googleaistudio')
  const [prompt, setPrompt] = useState(() => load('prompt', ''))
  const [system, setSystem] = useState(() => load('system', ''))
  const [refs, setRefs] = useState<Ref[]>([])
  const [refUrl, setRefUrl] = useState('')
  const [size, setSize] = useState('2K')
  const [ratio, setRatio] = useState('3:4')
  const [thinking, setThinking] = useState('high')
  const [search, setSearch] = useState(true)
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const current = MODELS.find((m) => m.id === model) ?? MODELS[0]
  const levels = current.pro ? ['minimal', 'low', 'medium', 'high'] : ['minimal', 'medium', 'high']
  const level = levels.includes(thinking) ? thinking : 'high'

  useEffect(() => save('endpoint', endpoint), [endpoint])
  useEffect(() => save('k', apiKey), [apiKey])
  useEffect(() => save('model', model), [model])
  useEffect(() => save('prompt', prompt), [prompt])
  useEffect(() => save('system', system), [system])

  useEffect(() => {
    if (!loading) return
    const t0 = Date.now()
    setElapsed(0)
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [loading])

  function addUrl() {
    const u = refUrl.trim()
    if (!/^https?:\/\//i.test(u)) {
      setError('Ссылка на изображение должна начинаться с http:// или https://')
      return
    }
    setError('')
    setRefs((r) => [...r, { id: uid(), kind: 'url', url: u }])
    setRefUrl('')
  }

  async function addFiles(list: FileList | null) {
    if (!list || !list.length) return
    try {
      const items = await Promise.all(Array.from(list).map(readFile))
      setRefs((r) => [...r, ...items])
      setError('')
    } catch (e: any) {
      setError(e.message)
    }
  }

  async function generate() {
    if (!apiKey.trim()) return setError('Вставьте API-ключ в блоке «Подключение».')
    if (!prompt.trim()) return setError('Опишите, что нужно сгенерировать.')
    setError('')
    setResult(null)
    setLoading(true)
    try {
      const payload: Record<string, unknown> = {
        model,
        input: [
          { type: 'text', text: prompt },
          ...refs.map((r) =>
            r.kind === 'url' ? { type: 'image', uri: r.url } : { type: 'image', mime_type: r.mime, data: r.data },
          ),
        ],
        service_tier: 'standard',
        response_modalities: ['image', 'text'],
        response_format: { type: 'image', aspect_ratio: ratio, image_size: size, mime_type: 'image/jpeg' },
        generation_config: {
          thinking_level: level,
          thinking_summaries: 'auto',
          max_output_tokens: current.maxTokens,
          stop_sequences: ['<|end_of_turn|>', '<|user|>'],
        },
        safety_settings: SAFETY,
      }
      if (provider !== 'auto') payload.provider = { only: [provider] }
      if (system.trim()) payload.system_instruction = system
      if (search) payload.tools = [{ type: 'google_search', search_types: ['web_search', 'image_search'] }]

      const res = await fetch(PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: endpoint.trim(), key: apiKey.trim(), payload }),
      })
      const txt = await res.text()
      let j: any
      try {
        j = JSON.parse(txt)
      } catch {
        throw new Error(`Ответ не в формате JSON (HTTP ${res.status}): ${txt.slice(0, 500)}`)
      }
      if (j?.error) {
        throw new Error(typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error).slice(0, 600))
      }
      const out = parseResult(j)
      if (!out.imgs.length) {
        throw new Error('В ответе нет изображения. ' + (out.texts.join(' ') || txt.slice(0, 500)))
      }
      setResult(out)
    } catch (e: any) {
      setError(e?.message || 'Не удалось выполнить запрос')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Gemini · FastRouter</Badge>
          <Badge variant="secondary">до 4K</Badge>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Генерация изображений</h1>
        <p className="text-muted-foreground text-sm">
          Опишите картинку, при необходимости добавьте референсы и выберите формат. Запрос уходит через ваш воркфлоу n8n.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Подключение</CardTitle>
          <CardDescription>Адрес API и ключ. Ключ хранится только в этом браузере.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="endpoint">Endpoint</Label>
            <Input id="endpoint" className="font-mono text-xs" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} spellCheck={false} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="key">API-ключ</Label>
            <Input id="key" type="password" autoComplete="off" placeholder="Ключ FastRouter" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Промпт и референсы</CardTitle>
          <CardDescription>Что нарисовать и на какие изображения опираться.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="prompt">Промпт</Label>
            <Textarea id="prompt" rows={5} placeholder="Например: рыжий кот в скафандре на фоне Земли, акварель" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </div>

          <div className="grid gap-2">
            <Label>Референсные изображения</Label>
            <div className="flex gap-2">
              <Input placeholder="https://… ссылка на изображение" value={refUrl} onChange={(e) => setRefUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addUrl()} />
              <Button type="button" variant="secondary" onClick={addUrl}>
                Добавить
              </Button>
            </div>
            <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
            <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
              Выбрать файлы с телефона
            </Button>
            {refs.length > 0 && (
              <ul className="grid gap-2">
                {refs.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 rounded-md border p-2">
                    <img
                      className="size-12 rounded object-cover"
                      src={r.kind === 'url' ? r.url : `data:${r.mime};base64,${r.data}`}
                      alt=""
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">{r.kind === 'url' ? r.url : r.name}</span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setRefs((x) => x.filter((i) => i.id !== r.id))}>
                      Убрать
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">Системная инструкция (необязательно)</summary>
            <Textarea className="mt-3" rows={3} value={system} onChange={(e) => setSystem(e.target.value)} />
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Параметры</CardTitle>
          <CardDescription>Модель, размер, пропорции и размышления.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="model">Модель</Label>
            <Select id="model" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="provider">Провайдер</Label>
            <Select id="provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="googleaistudio">googleaistudio</option>
              <option value="auto">auto</option>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="size">Размер</Label>
            <Select id="size" value={size} onChange={(e) => setSize(e.target.value)}>
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ratio">Пропорции</Label>
            <Select id="ratio" value={ratio} onChange={(e) => setRatio(e.target.value)}>
              {RATIOS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="thinking">Уровень размышлений</Label>
            <Select id="thinking" value={level} onChange={(e) => setThinking(e.target.value)}>
              {levels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-end pb-2">
            <Label>
              <input type="checkbox" className="size-4 accent-primary" checked={search} onChange={(e) => setSearch(e.target.checked)} />
              Поиск Google (текст и картинки)
            </Label>
          </div>
        </CardContent>
        <CardFooter className="flex-wrap">
          <Button size="lg" onClick={generate} disabled={loading}>
            {loading ? `Генерируем… ${elapsed} с` : 'Сгенерировать'}
          </Button>
          {loading && <span className="text-muted-foreground text-sm">Обычно это занимает до минуты.</span>}
        </CardFooter>
      </Card>

      {error && (
        <div role="alert" className="border-destructive text-destructive rounded-md border p-4 text-sm break-words">
          {error}
        </div>
      )}

      {(loading || result) && (
        <Card>
          <CardHeader>
            <CardTitle>Результат</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {loading && !result && <div className={cn('bg-muted aspect-[3/4] w-full animate-pulse rounded-md')} />}
            {result?.imgs.map((src, i) => (
              <div key={i} className="grid gap-2">
                <img className="w-full rounded-md border" src={src} alt={prompt} />
                <a
                  className="text-sm underline underline-offset-4"
                  href={src}
                  download={`image-${i + 1}.jpg`}
                >
                  Скачать
                </a>
              </div>
            ))}
            {result?.texts.map((t, i) => (
              <p key={i} className="text-muted-foreground text-sm whitespace-pre-wrap">
                {t}
              </p>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
