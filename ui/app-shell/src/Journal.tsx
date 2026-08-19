import type { Lang, LogLine } from "./platform";
import { loggedAgo, strings } from "./i18n";
import { Empty, Panel } from "./ui";

/** Журнал службы: что она сделала и почему. Своих сообщений окно не выдумывает,
 *  кроме ошибок, до службы не дошедших.
 *
 *  Лента моноширинная и верхняя строка ярче остальных: это запись прибора, а
 *  новость в ней всегда одна — последняя. */
export function Journal({ lines, lang, className }: { lines: LogLine[]; lang?: Lang; className?: string }) {
  const s = strings(lang);
  return (
    <Panel className={className} title={s.journal}>
      {lines.length === 0 ? (
        <Empty>{s.emptyJournal}</Empty>
      ) : (
        <ol className="flex flex-col gap-1.5 font-mono text-[11.5px] leading-snug">
          {lines.map((line, i) => (
            // Ключи в журнале сдвигаются при каждой новой строке, поэтому
            // React пересоздаёт весь список; вплывает только верхняя — она и
            // есть новость, остальные просто переехали.
            //
            // Возраст — в подсказке, а не в строке: лента узкая, а «час назад»
            // и «только что» различать всё равно нужно — без этого повтор
            // недельной давности читается как то, что происходит сейчас.
            <li
              key={`${i}-${line.text}`}
              title={loggedAgo(s, line.at)}
              // Поломку красим, а не помечаем значком: лента моноширинная и
              // узкая, и лишний символ в начале строки сдвинул бы весь текст
              // ради того, что цвет говорит и так.
              className={`selectable ${line.bad ? "text-fault" : i === 0 ? "text-ink" : "text-muted"} ${
                i === 0 ? "enter" : ""
              }`}
            >
              {line.text}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
