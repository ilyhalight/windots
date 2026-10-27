# tps — live tokens-per-second for OpenCode

**EN** · [RU](#ru)

A TUI plugin for OpenCode V2 that shows the model's speed in the prompt footer while it streams, and a summary when it finishes.

```
⠼   56 tok/s ▁▅▇███████        TTFT 0.4s · 176 tok · 3.0s     ← streaming
avg 59 tok/s · peak 60 · 180 tok · TTFT 0.4s · 3.0s          ← finished
avg ≈59 tok/s · peak ≈60 · ≈180 tok · TTFT 0.4s · 3.0s       ← finished, token counts estimated
```

- **Live rate** over a ~1.8 s sliding window; the sparkline shows the last ~6 s. Colour: below 20 tok/s warning, below 60 info, 60+ success.
- **Generation time** runs from the first token of a step to the end of its stream. Tool time and gaps are not counted.
- **TTFT** is the time from the request to the first token.
- **Tokens** are estimated while streaming (~4.5 chars/token Latin, ~2.8 Cyrillic, 1 per CJK character, whitespace almost free), then replaced by the provider's exact `output + reasoning` from `session.step.ended`. `≈` marks a summary that still contains estimates.
- Tool-call arguments are not counted while streaming, so a step that only writes a big tool call shows no live rate.
- **Subagents** (children and grandchildren) are reported only while the main model is *not* generating, i.e. waits on tools, and only while they work. Once the main model streams again, or the response is over, the line is back to normal.
  - **One** working subagent: the line shows *its* speed, under its agent name, in the same form as the main line (`⑂ explore ⠹ 80 tok/s` in compact mode).
  - **Two or more**: the main line keeps its summary and the spinner keeps turning, with a count at the end: `⑂ 2 subagents` (`⑂2` in compact mode).
  - Children are found via `session.created` (`parentID`) and `session.execution.*` / `session.status` events, falling back to OpenCode's own session cache; a subagent silent for 10 minutes is no longer counted. Meters of working subagents are never evicted.

```
⑂ explore ⠹   80 tok/s ▁▅▇███   TTFT 0.6s · 1.2k tok · 9.4s      ← one subagent, generating
⑂ explore ⠶ avg ≈72 tok/s · ≈1.2k tok                            ← one subagent, running its own tools
⑂ explore ⠧ waiting 1.2s                                         ← one subagent, no token yet
⠹ avg ≈58 tok/s · peak ≈59 · ≈176 tok · TTFT 0.4s · 3.0s · ⑂ 2 subagents
```

### Commands

| Command | Palette | Does |
| --- | --- | --- |
| `/tps` | TPS: Toggle | show / hide the meter |
| `/tps-mode` | TPS: Cycle mode | full ↔ compact (`⠼  56 tok/s`, then `avg 59 tok/s`) |

Both settings persist across restarts.

### Published API (for other plugins)

tps publishes plain data on `globalThis[Symbol.for("opencode.tps")]` while it is loaded, and removes it on unload (only if it is still its own, so a reload cannot delete its successor's). Nothing is imported across plugins, so they need not share a module or a solid-js instance. The data is not reactive: poll it on your own timer while there is something to show (~150 ms is plenty).

```ts
interface TpsApi {
  readonly version: 1                      // check it; it changes only on breaking changes
  snapshot(sessionID: string): TpsSnapshot | undefined   // undefined: nothing measured for that session
}

interface TpsSnapshot {
  phase: "waiting" | "streaming" | "paused" | "done"   // no token yet · generating · between steps · finished
  agent?: string
  tps: number                  // live rate, 0 unless streaming
  tier: "slow" | "normal" | "fast"   // < 20, < 60, >= 60 tok/s
  avg: number; peak: number    // tok/s over the response (0 while too little data)
  tokens: number
  exact: boolean; approx: "" | "≈"   // "≈" while counts still contain estimates
  ttftMs?: number; waitMs?: number; genMs: number
  samples: number[]            // recent live rates, oldest first
  bars: { glyph: string; tier: "slow" | "normal" | "fast" }[]   // samples as ▁..█ (last 16), each with its own tier
  spark: string                // the glyphs of `bars` as one string
  spinner: string              // braille frame for this moment (still glyph when paused/done)
  text: { rate: string; avg: string; peak: string; tokens: string; ttft?: string; gen: string; wait?: string }
}
```

`text.rate` is padded to 4 characters; everything else is trimmed. Guard your read (`typeof api?.snapshot === "function"`, `api.version === 1`, try/catch) and treat a missing API as "tps not installed".

### Install

Copy the folder contents to the global plugins directory (OpenCode reloads on change):

```powershell
Copy-Item -Recurse -Force .\* "$env:USERPROFILE\.config\opencode\plugins\tps\"
```

Files: `index.ts` (server stub for discovery), `tui.tsx` (the plugin), `src/meter.ts` (measurement), `src/format.ts` (formatting), `src/family.ts` (subagent tracking), `src/focus.ts` (what to show while the main model is idle), `src/api.ts` (published API).

<a id="ru"></a>

## RU

Плагин для TUI OpenCode V2: показывает скорость модели (токены в секунду) в футере промпта, пока идёт стриминг, и итог после ответа.

```
⠼   56 tok/s ▁▅▇███████        TTFT 0.4s · 176 tok · 3.0s     ← идёт ответ
avg 59 tok/s · peak 60 · 180 tok · TTFT 0.4s · 3.0s          ← ответ завершён
avg ≈59 tok/s · peak ≈60 · ≈180 tok · TTFT 0.4s · 3.0s       ← завершён, токены оценочные
```

- **Текущая скорость** — скользящее окно ~1,8 с; спарклайн показывает последние ~6 с. Цвет: ниже 20 tok/s — warning, ниже 60 — info, от 60 — success.
- **Время генерации** считается от первого токена шага до конца его стрима; время работы инструментов и паузы не входят.
- **TTFT** — время от запроса до первого токена.
- **Токены** при стриминге оцениваются (~4,5 символа на токен для латиницы, ~2,8 для кириллицы, 1 на иероглиф, пробелы почти бесплатны), затем заменяются точным `output + reasoning` из `session.step.ended`. Знак `≈` значит, что в итоге остались оценки.
- Аргументы вызовов инструментов при стриминге не учитываются, поэтому шаг, где модель только пишет большой tool call, живой скорости не покажет.
- **Сабагенты** (дочерние сессии, включая вложенные) показываются только пока основная модель *не* генерирует (ждёт инструменты) и пока они работают. Как только основная модель снова стримит или ответ закончен, строка обычная.
  - **Один** работающий сабагент: строка показывает *его* скорость с именем агента в той же форме, что и основная (`⑂ explore ⠹ 80 tok/s` в компактном режиме).
  - **Два и больше**: строка основной модели остаётся, спиннер крутится, в конце счётчик `⑂ 2 subagents` (в компактном режиме `⑂2`).
  - Дочерние сессии определяются по `session.created` (`parentID`) и событиям `session.execution.*` / `session.status`, запасной вариант — кэш сессий самого OpenCode; сабагент, молчащий 10 минут, больше не учитывается. Счётчики работающих сабагентов не вытесняются.

### Команды

| Команда | Палитра | Действие |
| --- | --- | --- |
| `/tps` | TPS: Toggle | показать / скрыть |
| `/tps-mode` | TPS: Cycle mode | полный ↔ компактный (`⠼  56 tok/s`, после ответа `avg 59 tok/s`) |

Настройки сохраняются между запусками.

### Публикуемый API (для других плагинов)

Пока tps загружен, он кладёт простые данные в `globalThis[Symbol.for("opencode.tps")]` и убирает их при выгрузке (только если они всё ещё его — перезагрузка не удалит API преемника). Между плагинами ничего не импортируется, общий модуль и общий solid-js не нужны. Данные не реактивные: опрашивайте их своим таймером, пока есть что показывать (~150 мс достаточно).

Форма — как в английском разделе выше: `{ version: 1, snapshot(sessionID) }` возвращает `TpsSnapshot | undefined` (поля `phase`, `agent`, `tps`, `tier`, `avg`, `peak`, `tokens`, `exact`, `approx`, `ttftMs`, `waitMs`, `genMs`, `samples`, `bars`, `spark`, `spinner`, `text`). `text.rate` дополнен пробелами до 4 символов, остальные строки без пробелов по краям. Проверяйте `api.version === 1`, оборачивайте чтение в try/catch; отсутствие API значит «tps не установлен».

### Установка

Скопируйте содержимое папки в глобальную папку плагинов (OpenCode перезагрузит плагин сам):

```powershell
Copy-Item -Recurse -Force .\* "$env:USERPROFILE\.config\opencode\plugins\tps\"
```

Файлы: `index.ts` (серверная заглушка для автообнаружения), `tui.tsx` (плагин), `src/meter.ts` (измерения), `src/format.ts` (форматирование), `src/family.ts` (учёт сабагентов), `src/focus.ts` (что показывать, пока основная модель простаивает), `src/api.ts` (публикуемый API).
