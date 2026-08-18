import type { Lang } from "./platform";
import { strings } from "./i18n";
import { Empty, Panel } from "./ui";

/** Журнал службы: что она сделала и почему. Своих сообщений окно не выдумывает,
 *  кроме ошибок, до службы не дошедших. */
export function Journal({ lines, lang, className }: { lines: string[]; lang?: Lang; className?: string }) {
  const s = strings(lang);
  return (
    <Panel className={className} title={s.journal}>
      {lines.length === 0 ? (
        <Empty>{s.emptyJournal}</Empty>
      ) : (
        <ol className="flex flex-col gap-1 text-[12.5px] text-muted">
          {lines.map((line, i) => (
            // Ключи в журнале сдвигаются при каждой новой строке, поэтому
            // React пересоздаёт весь список; вплывает только верхняя — она и
            // есть новость, остальные просто переехали.
            <li key={`${i}-${line}`} className={i === 0 ? "enter selectable" : "selectable"}>
              {line}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
