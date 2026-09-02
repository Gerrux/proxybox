import { useState } from "react";
import type { Lang, LogLine } from "./platform";
import { dayLabel, loggedAgo, strings } from "./i18n";
import { Button, Empty, Panel } from "./ui";

/** Журнал службы: что она сделала и почему. Своих сообщений окно не выдумывает,
 *  кроме ошибок, до службы не дошедших. Своей важности — тоже: поломку красит
 *  признак `bad` из службы, а не поиск слов в тексте. Раскраска по словам
 *  объявила бы «правила не поставлены» неважным, потому что нужного слова в
 *  строке не нашлось.
 *
 *  Лента — бумажная лента самописца: слева время, вдоль него сплошной рельс,
 *  сверху насечка на свежей записи. Новость в журнале всегда одна — верхняя.
 *
 *  Время вынесено из подсказки в саму ленту: журнал читают, когда уже что-то
 *  сломалось, и «когда именно» там половина ответа. Час и минуты повторно не
 *  печатаются — вместо них точка: так видно, что три строки пришли одной
 *  вспышкой, а не растянулись на четверть часа. Подсказка осталась ради
 *  возраста: «5 мин назад» глаз не считает из «14:32».
 *
 *  День подписан отдельной чертой, и сегодняшний — не подписан вовсе. Тридцать
 *  строк переживают перезапуск службы и легко перешагивают полночь, а «14:32»
 *  недельной давности читается ровно как то, что происходит сейчас. */
export function Journal({ lines, lang, className }: { lines: LogLine[]; lang?: Lang; className?: string }) {
  const s = strings(lang);
  const at = (line: LogLine) => new Date(line.at * 1000);
  const clock = (line: LogLine) =>
    at(line).toLocaleTimeString(lang ?? "ru", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  // Скопированное показывается ответом на нажатие: буфер обмена невидим, и
  // молчаливая кнопка тут неотличима от несработавшей. Флаг снимается сам —
  // подтверждение живёт ровно столько, сколько на него смотрят.
  const [copied, setCopied] = useState(false);
  // Лента идёт от новых к старым, а показывают её в переписке, где читают
  // сверху вниз: наружу отдаём по порядку событий. Дата целиком, а не одно
  // время: тридцать строк легко перешагивают полночь.
  const text = () =>
    [...lines]
      .reverse()
      .map((line) => `${at(line).toLocaleString(lang ?? "ru")}  ${line.text}`)
      .join("\n");
  return (
    <Panel
      className={className}
      title={s.journal}
      action={
        lines.length > 0 && (
          <Button
            variant="quiet"
            onClick={() => {
              // Отказ буфера ничем не показываем: подтверждение не появится, а
              // это и есть весь ответ. Своей ошибки окно тут выдумывать не
              // станет — журнал остаётся на экране, его видно и так.
              void navigator.clipboard
                .writeText(text())
                .then(() => setCopied(true))
                .then(() => setTimeout(() => setCopied(false), 2000))
                .catch(() => {});
            }}
          >
            {copied ? s.copied : s.copyLog}
          </Button>
        )
      }
    >
      {lines.length === 0 ? (
        <Empty>{s.emptyJournal}</Empty>
      ) : (
        <ol className="flex flex-col font-mono text-[11.5px] leading-snug">
          {lines.map((line, i) => {
            const prev = lines[i - 1];
            // Группа — не «сутки», а «другие сутки, чем у строки выше»: список
            // идёт от новых к старым, и подпись возглавляет свою группу.
            const opens = !prev || at(prev).toDateString() !== at(line).toDateString();
            const day = opens ? dayLabel(s, lang ?? "ru", line.at) : undefined;
            return (
              // Ключи в журнале сдвигаются при каждой новой строке, поэтому
              // React пересоздаёт весь список; вплывает только верхняя — она и
              // есть новость, остальные просто переехали.
              <li key={`${i}-${line.text}`} title={loggedAgo(s, line.at)} className={i === 0 ? "enter" : ""}>
                {day && (
                  <div className={`mb-1.5 flex items-center gap-2 ${i ? "mt-3.5" : ""}`}>
                    <span className="engraved shrink-0 text-muted">{day}</span>
                    <span className="h-px flex-1 bg-edge" />
                  </div>
                )}
                {/* Поломку красим, а не помечаем значком: лента моноширинная и
                    узкая, и лишний символ в начале строки сдвинул бы весь текст
                    ради того, что цвет говорит и так. */}
                <div className={`relative flex ${line.bad ? "text-fault" : i === 0 ? "text-ink" : "text-muted"}`}>
                  {/* Час и минуты повторно не печатаются — но не пропадают:
                      точка на экране и время в aria-label читаются одинаково. */}
                  <time
                    dateTime={at(line).toISOString()}
                    aria-label={clock(line)}
                    className="w-11 shrink-0 py-1 pr-2 text-right text-[10.5px] tabular-nums text-muted"
                  >
                    {opens || clock(prev) !== clock(line) ? clock(line) : <span className="opacity-40">·</span>}
                  </time>
                  {/* Рельс — левая граница текста, а не отдельная линия: строки
                      стоят вплотную, и границы смыкаются в одну сплошную. */}
                  <span className="selectable border-l border-edge py-1 pl-3">{line.text}</span>
                  {/* Насечка на голове ленты. Единственное яркое пятно в панели:
                      всё остальное здесь — приглушённая запись прибора. */}
                  {i === 0 && (
                    <span className="absolute top-[9px] left-11 size-[5px] -translate-x-1/2 rotate-45 bg-ink" />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
