import { useState } from "react";
import type { Lang, LogLine } from "./platform";
import { dayLabel, loggedAgo, strings } from "./i18n";
import { CopyButton, Empty, Panel, Segmented } from "./ui";

/** Журнал службы: что она сделала и почему. Своих сообщений окно не выдумывает,
 *  кроме ошибок, до службы не дошедших. Своей важности — тоже: поломку красит
 *  признак `bad` из службы, а не поиск слов в тексте. Раскраска по словам
 *  объявила бы «правила не поставлены» неважным, потому что нужного слова в
 *  строке не нашлось.
 *
 *  Лента: слева время, вдоль него сплошной рельс, на свежей записи — точка
 *  акцентом. Новость в журнале всегда одна — верхняя.
 *
 *  Время вынесено из подсказки в саму ленту: журнал читают, когда уже что-то
 *  сломалось, и «когда именно» там половина ответа. Колонка времени одной
 *  ширины у всех строк, а час и минуты повторно не печатаются — вместо них
 *  точка: так видно, что три строки пришли одной вспышкой, а не растянулись на
 *  четверть часа. Подсказка осталась ради возраста: «5 мин назад» глаз не
 *  считает из «14:32».
 *
 *  День подписан отдельной липкой чертой, и сегодняшний — не подписан вовсе.
 *  Тридцать строк переживают перезапуск службы и легко перешагивают полночь, а
 *  «14:32» недельной давности читается ровно как то, что происходит сейчас.
 *  Липкая она потому, что группа дня бывает длиннее окна: посреди прокрутки
 *  ответить «какой это день» иначе нечем.
 *
 *  «Все | Сбои» — способ смотреть, а не настройка: живёт в окне и умирает с
 *  ним, службе о нём знать незачем. Сбойная строка в ленте занимает две строки
 *  и разворачивается нажатием: причина отказа бывает длинной, и три таких
 *  подряд вытесняли бы всё остальное. */
export function Journal({ lines, lang, className }: { lines: LogLine[]; lang?: Lang; className?: string }) {
  const s = strings(lang);
  const [only, setOnly] = useState<"all" | "bad">("all");
  // Развёрнутые строки помнятся по содержимому, а не по номеру: номера
  // сдвигаются с каждой новой записью, и развёрнутая строка уезжала бы вместе
  // с ними на соседнюю.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const at = (line: LogLine) => new Date(line.at * 1000);
  const clock = (line: LogLine) =>
    at(line).toLocaleTimeString(lang ?? "ru", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const keyOf = (line: LogLine) => `${line.at}\u0000${line.text}`;
  const hasBad = lines.some((line) => line.bad);
  // Отбор по сбоям не держим, когда сбоев не осталось: пустая лента без
  // единой кнопки, которая это объясняет, — тот же тихий промах, что у метки
  // браузерного профиля, ушедшей из списка.
  const shown = only === "bad" && hasBad ? lines.filter((line) => line.bad) : lines;
  // Лента идёт от новых к старым, а показывают её в переписке, где читают
  // сверху вниз: наружу отдаём по порядку событий. Дата целиком, а не одно
  // время: тридцать строк легко перешагивают полночь. Копируется то, что на
  // экране: отобранное «Сбои» не должно уезжать вместе со всем остальным.
  const text = () =>
    [...shown]
      .reverse()
      .map((line) => `${at(line).toLocaleString(lang ?? "ru")}  ${line.text}`)
      .join("\n");
  // Дни — группами, чтобы липкой подписи было к чему липнуть: липкое живёт
  // только внутри своего родителя, и подпись дня в общем списке уезжала бы
  // вместе с первой же строкой.
  const days: { key: string; day?: string; items: LogLine[] }[] = [];
  shown.forEach((line, i) => {
    const prev = shown[i - 1];
    // Группа — не «сутки», а «другие сутки, чем у строки выше»: список идёт от
    // новых к старым, и подпись возглавляет свою группу.
    if (!prev || at(prev).toDateString() !== at(line).toDateString()) {
      days.push({ key: at(line).toDateString(), day: dayLabel(s, lang ?? "ru", line.at), items: [] });
    }
    days[days.length - 1].items.push(line);
  });
  return (
    <Panel
      // Отступа у прокрутки нет — по той же причине, что у списка профилей:
      // липкая подпись дня липнет к полю прокрутки за вычетом её отступа, а не
      // к кромке. Поля раздают сам список и пустые состояния.
      className={className}
      title={s.journal}
      action={
        lines.length > 0 && (
          <>
            {hasBad && (
              <Segmented
                label={s.journalFilter}
                value={only}
                onPick={(v) => setOnly(v === "bad" ? "bad" : "all")}
                options={[
                  ["all", s.journalAll],
                  ["bad", s.journalBad],
                ]}
              />
            )}
            <CopyButton text={text} label={s.copyLog} done={s.copied} />
          </>
        )
      }
    >
      {lines.length === 0 ? (
        <div className="p-3">
          <Empty>{s.emptyJournal}</Empty>
        </div>
      ) : shown.length === 0 ? (
        <div className="p-3">
          <Empty>{s.journalNoBad}</Empty>
        </div>
      ) : (
        <ol className="flex flex-col px-4 pb-3 text-sm">
          {days.map((group) => (
            <li key={group.key} className="flex flex-col">
              {group.day && (
                // Подпись и черта липнут к кромке прокрутки (`top-0`): у
                // панели отступа на самой прокрутке нет — он стоит на списке.
                <div className="sticky top-0 z-[1] -mx-4 mt-2 flex items-center gap-2 bg-bg px-4 py-1.5">
                  <span className="shrink-0 text-xs font-semibold text-muted">{group.day}</span>
                  <span className="h-px flex-1 bg-edge" />
                </div>
              )}
              <ol className="flex flex-col">
                {group.items.map((line, i) => {
                  const prev = group.items[i - 1];
                  const newest = line === lines[0];
                  const expanded = open.has(keyOf(line));
                  return (
                    // Ключ — само содержимое: строки не пересоздаются, когда
                    // сверху приходит новая, и вплывает только она — она и есть
                    // новость, остальные просто переехали.
                    <li key={keyOf(line)} title={loggedAgo(s, line.at)} className={newest ? "enter" : ""}>
                      {/* Поломку красим, а не помечаем значком: лента моноширинная и
                          узкая, и лишний символ в начале строки сдвинул бы весь текст
                          ради того, что цвет говорит и так. */}
                      <div className={`relative flex ${line.bad ? "text-fault" : newest ? "text-ink" : "text-muted"}`}>
                        {/* Час и минуты повторно не печатаются — но не пропадают:
                            точка на экране и время в aria-label читаются одинаково. */}
                        <time
                          dateTime={at(line).toISOString()}
                          aria-label={clock(line)}
                          className="w-12 shrink-0 py-1 pe-2.5 text-end text-xs tabular-nums text-muted"
                        >
                          {!prev || clock(prev) !== clock(line) ? clock(line) : <span className="opacity-40">·</span>}
                        </time>
                        {/* Рельс — левая граница текста, а не отдельная линия: строки
                            стоят вплотную, и границы смыкаются в одну сплошную. */}
                        <span
                          className={`selectable min-w-0 flex-1 border-s border-edge py-1 ps-3 leading-[18px] ${
                            line.bad ? `cursor-pointer ${expanded ? "" : "line-clamp-2"}` : ""
                          }`}
                          {...(line.bad
                            ? {
                                role: "button",
                                tabIndex: 0,
                                "aria-expanded": expanded,
                                title: s.journalMore,
                                onClick: () => {
                                  // Выделяют текст, чтобы скопировать причину, —
                                  // нажатие, которым выделение кончилось, не
                                  // должно сворачивать строку из-под руки.
                                  if (window.getSelection()?.toString()) return;
                                  toggle(keyOf(line));
                                },
                                onKeyDown: (e: React.KeyboardEvent) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    toggle(keyOf(line));
                                  }
                                },
                              }
                            : {})}
                        >
                          {line.text}
                        </span>
                        {/* Точка на голове ленты. Единственное яркое пятно в панели:
                            всё остальное здесь — приглушённая запись.

                            Сдвиг на полразмера логическим не бывает: `start-12`
                            зеркалится сам, а `-translate-x` — нет, и в фарси точка
                            уезжала бы с рельса на свою же ширину. */}
                        {newest && (
                          <span className="absolute top-[11px] start-12 size-[7px] -translate-x-1/2 rounded-full bg-accent rtl:translate-x-1/2" />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );

  function toggle(key: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }
}
