/** Примитивы интерфейса. Пока живут в оболочке: второго потребителя нет, а
 *  отдельный пакет ui-kit ради одного — лишний слой. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Панель — область одной плоской поверхности окна, а не карточка: шапка в
 *  40 px с подписью полужирным, под ней волосяная линия, дальше прокрутка.
 *  Карточек со штрихом, которыми панели были, в плоском окне нет: стопка
 *  одинаковых скруглённых плиток — то, чем выглядит любой веб-дашборд, а не
 *  окно Windows. */
export function Panel({
  title,
  note,
  action,
  className = "",
  pad = "",
  children,
}: {
  title: string;
  note?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** Отступ содержимого. Панель не даёт его сама: липкое внутри прокрутки
   *  (`.sub-head` в списке профилей) липнет не к её кромке, а к полю за
   *  вычетом её же отступа, и в полоске между ними видны строки, уезжающие
   *  под заголовок. Список поэтому просит пустой отступ, а панели с обычным
   *  содержимым — `p-3`; сторож — `the_sticky_head_sits_on_the_scroll_edge`. */
  pad?: string;
  children: ReactNode;
}) {
  return (
    <section className={`flex min-h-0 flex-col overflow-hidden ${className}`}>
      {/* Подпись обрезаться не имеет права — по ней и находят панель.
          Ужимается сначала счётчик, потом действия. Высота полосы одна у всех
          панелей (40 px), и кнопки в ней одного размера. */}
      <header className="panel-head flex h-10 shrink-0 items-center justify-between gap-2 ps-4 pe-2">
        <h2 className="flex min-w-0 flex-1 items-baseline gap-2 text-sm font-semibold text-ink">
          <span className="shrink-0">{title}</span>
          {note != null && <span className="min-w-0 truncate text-xs font-normal text-muted">{note}</span>}
        </h2>
        {action && <div className="flex shrink-0 items-center gap-0.5">{action}</div>}
      </header>
      <div className={`scroll min-h-0 flex-1 overflow-y-auto ${pad}`}>{children}</div>
    </section>
  );
}

/** Порог узкого окна — тот же, по которому сжимается раскладка в `index.css`
 *  (`@media (max-width: 470px)`): плашка из трея открывается в 380 px, и
 *  главное окно ужимается до тех же 380 (`minWidth` в `tauri.conf.json`).
 *  Второй порог рядом с первым разъезжался бы с ним молча.
 *
 *  Спрашиваем в JS, а не прячем классом, ровно там, где меняется не вид, а
 *  разметка: свернуть четыре кнопки в одно меню классом нельзя — пришлось бы
 *  держать в дереве оба комплекта, то есть два обработчика на одно действие и
 *  вдвое больше того, что зачитывает экранный диктор.
 *
 *  Ширина, а не `isFlyout()`: главное окно, растянутое на 380 px, — та же
 *  теснота, и разбирать её вторым правилом незачем. */
const NARROW = "(max-width: 470px)";

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW);
    const seen = () => setNarrow(mq.matches);
    // Первый замер сделан в инициализаторе состояния, но между ним и подпиской
    // окно могли успеть потянуть за угол: сверяемся ещё раз.
    seen();
    mq.addEventListener("change", seen);
    return () => mq.removeEventListener("change", seen);
  }, []);
  return narrow;
}

/** Кнопки Fluent. Размер у всех один — 32 px высоты, 13 px текста: пока у
 *  каждой панели были свои (28, 32, 36), соседние ряды не вставали в линию. */
const VARIANTS = {
  /** Главное действие места: «Включить», «Импорт» в пустом списке. */
  primary: "btn-accent",
  /** Обычная кнопка — заливка управления и штрих. */
  ghost: "btn",
  /** Тихая: без заливки, проявляется под указателем. Для действий в
   *  заголовках и строках, где кнопок несколько. */
  quiet: "btn-subtle",
  /** Тихая, но разрушающая: краснеет под указателем. */
  danger: "btn-subtle hover:text-fault",
} as const;

export function Button({
  variant = "ghost",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  return (
    <button
      type="button"
      {...props}
      // Кнопки-значки подписаны только для чтения с экрана, а мышь о них не
      // узнаёт ничего: ту же строку отдаём и всплывающей подсказке. После
      // расстановки props — иначе своя `title` затёрлась бы пустой.
      title={props.title ?? props["aria-label"]}
      className={`smooth inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
    />
  );
}

/** Кнопка-значок: квадрат 32 px, тихая. Подпись обязательна — она и
 *  подсказка, и имя для чтения с экрана. */
export function IconButton({
  icon,
  label,
  variant = "quiet",
  className = "",
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  icon: IconName;
  label: string;
  variant?: keyof typeof VARIANTS;
}) {
  return (
    <Button variant={variant} aria-label={label} className={`w-8 px-0 ${className}`} {...props}>
      <Icon name={icon} />
    </Button>
  );
}

/** Тумблер Fluent — «вкл/выкл» одной настройки. Полоска из двух надписей,
 *  которой он был, в Windows означает выбор из вариантов, а не выключатель.
 *  Крупный (`lg`) стоит выключателем продукта в плашке из трея: жмут его не
 *  глядя, и попасть в него обязано быть легко. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  size = "md",
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  size?: "md" | "lg";
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`switch smooth ${size === "lg" ? "switch-lg" : ""}`}
    />
  );
}

/** Кнопка «скопировать», отвечающая надписью: буфер обмена невидим, и молчаливая
 *  кнопка тут неотличима от несработавшей. Подтверждение снимается само — живёт
 *  ровно столько, сколько на него смотрят.
 *
 *  Отказ буфера, наоборот, молчит: подтверждение просто не появится, а текст
 *  остаётся на экране — его видно и так. Своей ошибки окно тут не выдумывает.
 *
 *  Текст приезжает функцией, а не строкой: журнал за две секунды между
 *  нажатиями успевает смениться, и копировать надо тот, что на экране сейчас. */
export function CopyButton({ text, label, done }: { text: () => string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="quiet"
      onClick={() => {
        void navigator.clipboard
          .writeText(text())
          .then(() => setCopied(true))
          .then(() => setTimeout(() => setCopied(false), 2000))
          .catch(() => {});
      }}
    >
      {copied ? done : label}
    </Button>
  );
}

/** Выбор одного из нескольких: короткие взаимоисключающие надписи, видимые
 *  разом. Выбранное различимо и без цвета (`aria-pressed`) — как у любой другой
 *  развилки в этом окне.
 *
 *  Лежит здесь, а не в настройках, с тех пор как охват уехал на шапку: одна и
 *  та же полоска нужна теперь в двух разных местах окна. */
export function Segmented({
  options,
  value,
  onPick,
  disabled,
  label,
  className = "",
}: {
  /** `[значение, надпись]` либо `[значение, надпись, подсказка]`. */
  options: [string, string, string?][];
  value: string;
  onPick: (value: string) => void;
  disabled?: boolean;
  /** Подпись для чтения с экрана там, где рядом нет своей строки: на шапке
   *  полоска стоит на канале, без слова «Охват» перед ней. */
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`segmented flex shrink-0 gap-0.5 rounded-md p-0.5 ${className}`}
    >
      {options.map(([id, text, hint]) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          title={hint}
          disabled={disabled}
          onClick={() => onPick(id)}
          className={`smooth h-[26px] min-w-0 flex-auto truncate rounded-[3px] px-3 text-sm disabled:opacity-40 ${
            value === id ? "text-ink" : "text-muted hover:text-ink"
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Значки — Lucide (https://lucide.dev, ISC; вписаны путями, пакета в
 *  зависимостях нет). Свои `<svg>`, а не глифы шрифта: `Segoe Fluent Icons`
 *  есть не на всякой системе, а отсутствующий глиф — пустой квадрат вместо
 *  смысла. Эмодзи не годятся тем же: их рисует система, и в тёмной панели они
 *  цветные и чужие, а эти наследуют `currentColor`.
 *
 *  Сетка 24×24 и штрих 1.75 — на 16 px это волосок в 1.17, того же веса, что
 *  у текста рядом. Один набор на всё окно; самодельные значки, которые здесь
 *  стояли, были того же рода, что и самодельная карта: почти как у всех и
 *  чуть хуже каждого. Символы шрифтом (✕ ⋯ + ? ★) вместо значков не ставят.
 *
 *  Глобуса здесь нет и быть не должно: профили — это узлы, а не «интернет»,
 *  и узлом их и рисуем — стойкой сервера. `FILLED` — значки, которые читаются
 *  только залитыми: звезда. */
const ICONS = {
  server: "M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2zM4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-4a2 2 0 0 1 2 -2zM6 6L6.01 6M6 18L6.01 18",
  screen: "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2zM8 21L16 21M12 17L12 21",
  lines: "M3 5h1M3 12h1M3 19h1M8 5h1M8 12h1M8 19h1M13 5h8M13 12h8M13 19h8",
  browser: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2zM10 4v4M2 8h20M6 4v4",
  swap: "M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4",
  tag: "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42zM7 7.5a0.5 0.5 0 1 0 1 0a0.5 0.5 0 1 0 -1 0",
  chip: "M12 20v2M12 2v2M17 20v2M17 2v2M2 12h2M2 17h2M2 7h2M20 12h2M20 17h2M20 7h2M7 20v2M7 2v2M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2zM9 8h6a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1z",
  speech: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
  clock: "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0M12 6v6l4 2",
  dice: "M4 10h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-8a2 2 0 0 1 2 -2zM17.92 14l3.5-3.5a2.24 2.24 0 0 0 0-3l-5-4.92a2.24 2.24 0 0 0-3 0L10 6M6 18h.01M10 14h.01M15 6h.01M18 9h.01",
  warn: "M21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01",
  repeat: "M17 2l4 4-4 4M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v1a4 4 0 0 1-4 4H3",
  plus: "M5 12h14M12 5v14",
  close: "M18 6 6 18M6 6l12 12",
  more: "M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
  help: "M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01",
  search: "M21 21l-4.34-4.34M3 11a8 8 0 1 0 16 0a8 8 0 1 0 -16 0",
  star: "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
  lockOpen: "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-7a2 2 0 0 1 2 -2zM7 11V7a5 5 0 0 1 9.9-1",
  lock: "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-7a2 2 0 0 1 2 -2zM7 11V7a5 5 0 0 1 10 0v4",
  power: "M12 2v10M18.4 6.6a9 9 0 1 1-12.77.04",
  shield: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1zM9 12l2 2 4-4",
  ring: "M21 12a9 9 0 1 1-6.219-8.56",
  sliders: "M10 5H3M12 19H3M14 3v4M16 17v4M21 12h-9M21 19h-5M21 5h-7M8 10v4M8 12H3",
  launch: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  chevron: "M9 18l6-6-6-6",
  check: "M20 6 9 17l-5-5",
  down: "M12 5v14M19 12l-7 7-7-7",
  up: "M5 12l7-7 7 7M12 19V5",
  refresh: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5",
  gauge: "M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0",
  bolt: "M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z",
  copy: "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2zM4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
} as const;

const FILLED: IconName[] = ["star"];

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "", size = 16 }: { name: IconName; className?: string; size?: number }) {
  const filled = FILLED.includes(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/** Вид поля ввода — один на все поля: внутри строки-формы `flex-1` растягивает,
 *  отдельно стоящее поле держит `w-full`. Поле утоплено в плиту: тот же приём,
 *  что и у списков, — вводить в паз, а не поверх. */
export const FIELD =
  "field selectable h-8 w-full min-w-0 flex-1 rounded-md px-3 text-sm outline-none";

/** То же поле, но многострочное: высоту задаёт `rows`, а не `h-8`. */
const FIELD_MULTI = `${FIELD.replace("h-8", "h-auto")} resize-none py-[5px] leading-[22px]`;

/** Поиск — того же размера, что и прочие поля: высота одна на всё окно. */
const FIELD_SEARCH = FIELD;

/** Чем кончилась отправка: приняли ли и что сказали. Служба отвечает не только
 *  «да» и «нет» — из импорта приезжает счёт («заведено 12, пропущено 38»), и
 *  показывать его надо там же, куда вставляли. */
export type Outcome = {
  ok: boolean;
  note?: string;
  bad?: boolean;
  /** Второй шаг: подпись и действие. Так возвращается предпросмотр импорта —
   *  счёт «будет заведено / уйдёт» и кнопка «Применить» под ним; поле при
   *  этом не чистится, пока второй шаг не сбылся. */
  confirm?: { label: string; run: () => Promise<Outcome> };
};

/** Поле «ввести и добавить»: своё состояние держит само — снаружи оно не нужно.
 *
 *  Чистится только на «приняли». Разобрать ссылку служба может отказаться — и
 *  тогда очищенное поле означало бы, что вставленный share-link надо искать
 *  заново, хотя в нём чаще всего опечатка в один символ.
 *
 *  Поле многострочное, и это не про удобство набора: ссылки приходят пачкой из
 *  канала, а `<input>` при вставке склеивает строки в одну — разобрать её потом
 *  нечем, разделителя не осталось. Набирают сюда всё равно одну строку, поэтому
 *  Enter отправляет, а перенос остаётся на Shift+Enter.
 *
 *  Фокус берётся сразу: поле не стоит в панели всегда, его открывают кнопкой —
 *  и второй клик, чтобы начать печатать, здесь лишний. */
export function AddField({
  placeholder,
  label,
  onSubmit,
  hint,
  busyLabel,
  fileLabel,
  className = "",
  initial,
}: {
  placeholder: string;
  label: string;
  onSubmit: (value: string) => Promise<Outcome>;
  /** Чем окажется набранное — подписью под полем. Одно поле принимает три
   *  разные вещи, и до отправки об этом не говорило ничего. */
  hint?: (value: string) => string | undefined;
  /** Надпись на время работы. Подписка выкачивается до двадцати секунд, и всё
   *  это время погасшая кнопка неотличима от «не нажалось» — второе нажатие
   *  человек делает не от нетерпения, а потому что первое ничем себя не
   *  проявило. */
  busyLabel?: string;
  /** Подпись кнопки «взять из файла». Не задана — кнопки нет: список
   *  приложений набирают путём, а не файлом. */
  fileLabel?: string;
  className?: string;
  /** Чем поле заполнено при открытии: Ctrl+V поверх списка открывает его уже
   *  со вставленным. */
  initial?: string;
}) {
  const [value, setValue] = useState(initial ?? "");
  // Итог шага — под поле; на «приняли» поле чистится. Общий для отправки и
  // для второго шага (`confirm`), чтобы они не разошлись в том, когда чистить.
  const finish = (outcome: Outcome) => {
    setSaid(outcome.note ? outcome : null);
    if (outcome.ok) setValue("");
  };
  // Что ответила служба на прошлую отправку. Живёт под этим полем, а не в общей
  // рамке наверху окна: «пропущено 38 строк» — это про то, что вставили сюда, и
  // читать это надо не отводя глаз от вставленного.
  const [said, setSaid] = useState<Outcome | null>(null);
  // Подписка выкачивается секундами: без этого второй Enter уходил бы службе
  // вдогонку первому.
  const [busy, setBusy] = useState(false);
  const sniffed = hint?.(value);
  // Файл читается прямо здесь: конфиг сохраняют файлом, а подписку — блобом в
  // файле, и человек до сих пор открывал их «Блокнотом», чтобы скопировать
  // текст. `<input type="file">` — родной путь и в вебвью, и в браузере.
  const take = (file: File | undefined) => {
    if (!file) return;
    void file.text().then((text) => {
      setSaid(null);
      setValue((was) => (was.trim() ? `${was.trimEnd()}\n${text.trim()}` : text.trim()));
    });
  };
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = value.trim();
          if (!trimmed || busy) return;
          setBusy(true);
          void onSubmit(trimmed)
            .then(finish)
            .finally(() => setBusy(false));
        }}
      >
        <textarea
          autoFocus
          value={value}
          rows={Math.min(6, value.split("\n").length)}
          onChange={(e) => setValue(e.target.value)}
          // Файл, брошенный на поле, — тот же импорт из файла, только без
          // диалога. В окне это работает, только пока оболочка не перехватывает
          // перетаскивание сама (`dragDropEnabled: false` в tauri.conf.json).
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            take(e.dataTransfer.files[0]);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          className={FIELD_MULTI}
        />
        <div className="flex shrink-0 flex-col gap-1">
          <Button type="submit" variant="primary" disabled={busy || !value.trim()}>
            {busy ? busyLabel ?? label : label}
          </Button>
          {fileLabel && (
            // Диалог открывает сам `<input>`, поэтому кнопка — это `<label>`:
            // programmatic click по скрытому полю вебвью не всегда пускает.
            <label className={`${VARIANTS.ghost} smooth inline-flex h-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-3 text-sm`}>
              {fileLabel}
              <input
                type="file"
                className="hidden"
                onChange={(e) => {
                  take(e.target.files?.[0]);
                  // Тот же файл вторым разом иначе не выберется: `change` на
                  // неизменившемся значении не приходит.
                  e.target.value = "";
                }}
              />
            </label>
          )}
        </div>
      </form>
      {said?.note && (
        <div className="flex items-start gap-2">
          <span className={`min-w-0 flex-1 whitespace-pre-line text-xs ${said.bad ? "text-fault" : "text-muted"}`}>
            {said.note}
          </span>
          {said.confirm && (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                const run = said.confirm?.run;
                if (!run) return;
                setBusy(true);
                void run().then(finish).finally(() => setBusy(false));
              }}
            >
              {said.confirm.label}
            </Button>
          )}
        </div>
      )}
      {!said && sniffed && <span className="text-xs text-muted">{sniffed}</span>}
    </div>
  );
}

/** Разрушающее действие в два клика: первый спрашивает, второй делает.
 *
 *  Системного `confirm()` в вебвью нет, а своё модальное окно ради одного
 *  вопроса — целый слой. Вопрос гаснет сам, стоит увести мышь или уйти с
 *  кнопки клавишей: передумавшему не нужно ничего нажимать.
 *
 *  Ставится не на всё подряд: удаление приложения из списка человек повторит за
 *  секунду, а вот отписка уносит с собой десятки профилей разом, и `✕` у
 *  активного профиля гасит туннель — выбранные приложения при этом остаются без
 *  сети, и по одному клику мимо такое случаться не должно. */
export function ConfirmButton({
  label,
  ask,
  onConfirm,
}: {
  label: string;
  ask: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <IconButton icon="close" variant="danger" label={label} onClick={() => setArmed(true)} />
    );
  }
  return (
    <Button
      variant="danger"
      aria-label={`${label} — ${ask}`}
      className="text-fault"
      autoFocus
      onMouseLeave={() => setArmed(false)}
      onBlur={() => setArmed(false)}
      onClick={() => {
        setArmed(false);
        onConfirm();
      }}
    >
      {ask}
    </Button>
  );
}

/** Пункт меню строки. Действия строки живут в меню, а не кнопками справа: их
 *  у профиля пять, и все пять в строке не помещаются даже в широком окне —
 *  первым обрубается имя, единственное, чем строки различаются. */
export type MenuItem = {
  label: string;
  onPick: () => void;
  /** Разрушающее — в два клика, как у `ConfirmButton`: первый подменяет
   *  надпись вопросом, второй делает. В меню промахнуться легче, чем по
   *  отдельной кнопке: пункты стоят вплотную. */
  ask?: string;
  hint?: string;
  danger?: boolean;
  /** Пункт-переключатель во включённом положении. Галочкой слева, а не цветом:
   *  меню читают глазами, а не наводят на него курсор. */
  mark?: boolean;
  disabled?: boolean;
};

/** Меню по правой кнопке (и по «⋯» — с клавиатуры и на сенсоре правой кнопки
 *  нет). Своё, а не системное: системное окно рисует Windows по `contextmenu`,
 *  которого в вебвью нет вовсе.
 *
 *  Координаты физические (`clientX`), и логическими они быть не могут: это
 *  место курсора, а не отступ в раскладке. Упирается в край экрана — сдвигаем;
 *  до первого замера меню спрятано, иначе оно мигало бы на прежнем месте. */
/** Где открыть меню. Точка курсора, а если нажали с клавиатуры (координат нет)
 *  — под самой кнопкой. Живёт рядом с `Menu`, а не у вызывающего: панелей с
 *  меню две, и разъехавшийся выбор точки читался бы как разное поведение
 *  одного и того же меню. */
export function spot(e: React.MouseEvent<HTMLElement>): [number, number] {
  if (e.clientX || e.clientY) return [e.clientX, e.clientY];
  const rect = e.currentTarget.getBoundingClientRect();
  return [rect.left, rect.bottom];
}

export function Menu({
  at,
  items,
  onClose,
}: {
  at: [number, number];
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setBox({
      left: Math.max(8, Math.min(at[0], window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(at[1], window.innerHeight - rect.height - 8)),
    });
  }, [at]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Прокрутка списка уводит строку из-под меню, а меню остаётся висеть на
    // месте: ловим её на всплытии из любого контейнера (`true`).
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: box?.left ?? at[0], top: box?.top ?? at[1], visibility: box ? undefined : "hidden" }}
      className="enter fixed z-20 min-w-44 rounded-lg border border-edge bg-surface p-1 shadow-[var(--pg-flyout-shadow)]"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          title={item.hint}
          onClick={() => {
            if (item.ask && armed !== item.label) return setArmed(item.label);
            onClose();
            item.onPick();
          }}
          className={`smooth flex h-8 w-full items-center gap-2 rounded-md px-2 text-start text-sm disabled:opacity-40 hover:bg-hover ${
            item.danger ? "hover:text-fault" : ""
          } ${armed === item.label ? "text-fault" : ""}`}
        >
          <span className="grid w-4 shrink-0 place-items-center text-accent">
            {item.mark && <Icon name="check" size={14} />}
          </span>
          <span className="min-w-0 flex-1 truncate">{armed === item.label ? item.ask : item.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Форма поверх окна. Родной `<dialog>`, а не свой слой: он сам держит фокус
 *  внутри, сам закрывается по Esc и сам лежит выше всего остального — своего
 *  кода на это ушло бы втрое больше, чем на разметку.
 *
 *  Заведена ради того, чтобы поле ввода перестало раздвигать список: поле
 *  импорта открывалось прямо в панели, и всё под ним съезжало вниз — вместе с
 *  той строкой, ради которой панель и открывали. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Закрывать в уборке эффекта нельзя: `close()` шлёт событие `close`, а оно
  // зовёт `onClose` — и StrictMode при разработке, прогоняя эффект дважды,
  // закрывал каждое окно сразу после открытия. Снятый из DOM `<dialog>`
  // перестаёт быть модальным сам, закрывать его руками незачем.
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      // Клик мимо содержимого — это клик по самому <dialog>: его поле целиком
      // занимает вложенный блок.
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-lg border border-edge bg-surface p-0 text-ink shadow-[var(--pg-flyout-shadow)] backdrop:bg-black/30"
    >
      <div className="flex max-h-[85vh] flex-col gap-3 overflow-y-auto p-5 pt-4">
        <header className="-me-2 flex items-center gap-3">
          <h2 className="min-w-0 flex-1 truncate text-xl font-semibold">{title}</h2>
          <IconButton icon="close" label={title} onClick={onClose} />
        </header>
        {children}
      </div>
    </dialog>
  );
}

/** Поиск по списку. `type="search"` — не украшение: WebView2 сам рисует крестик
 *  очистки и чистит поле по Esc, своего кода на это не нужно. Значение живёт
 *  снаружи: фильтрует тот, кто владеет списком. */
export function SearchField({
  value,
  onChange,
  placeholder,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Кому отдать фокус по Ctrl+F. */
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <input
      ref={inputRef}
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className={FIELD_SEARCH}
    />
  );
}

/** Код страны → флаг. Две буквы кода становятся региональными индикаторами —
 *  других способов записать флаг в юникоде нет. Глифы даёт свой шрифт
 *  (см. index.css): системных в Windows не существует. Кода нет или он не
 *  двухбуквенный — флага не будет, и вызывающий покажет название словами. */
export function flag(code: string | null | undefined): string | null {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return null;
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** Флаг в начале имени: панели подписок так и называют узлы — «🇳🇱 Amsterdam».
 *  Отдаём флаг и остаток порознь, чтобы флаг встал в свою колонку, а не
 *  повторился рядом с флагом страны выхода. */
export function leadingFlag(name: string): [string | null, string] {
  const m = /^([\u{1F1E6}-\u{1F1FF}]{2})\s*/u.exec(name);
  return m ? [m[1], name.slice(m[0].length)] : [null, name];
}

/** Флаг узла для колонки списка и имя без него. Флаг страны выхода по замеру
 *  сильнее флага из имени: имя пишет чужая панель, а замер — правда. Когда они
 *  расходятся, имя остаётся целым: «🇳🇱 Amsterdam» под флагом Германии — это
 *  ровно то, что человеку стоит увидеть. */
export function nodeFlag(name: string, code: string | null | undefined): [string | null, string] {
  const [own, rest] = leadingFlag(name);
  const measured = flag(code);
  if (measured && own && own !== measured) return [measured, name];
  return [measured ?? own, own ? rest : name];
}

/** Аватарка браузерного профиля: три цветных пятна и первая буква имени.
 *
 *  Алгоритм подсмотрен в arboweb — два 32-битных хеша зерна дают тон, положение
 *  пятен и шрифт, пятна складываются осветлением (`screen`). Там это рисовал
 *  шейдер, потому что аватарка дышала под курсором; у нас она стоит на месте, а
 *  неподвижную картинку из трёх радиальных градиентов CSS собирает сам. Канвы и
 *  WebGL тут нет вовсе — и не заводите: ради статичной картинки это контекст
 *  рисования на каждый профиль в списке.
 *
 *  Двенадцати цветов палитры больше нет. Тон теперь непрерывный, и различают
 *  профили не оттенок в одиночку, а рисунок пятен и буква — их хватает и на
 *  тринадцатый профиль, на котором палитра начинала повторяться.
 */
type Rgb = [number, number, number];

/** Хеш зерна — тот же, что в arboweb: два потока, чтобы одного мало
 *  различающегося числа не хватило и на тон, и на положение пятен. */
function hash2(seed: string): [number, number] {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (const char of seed) {
    const code = char.codePointAt(0) ?? 0;
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return [h1 >>> 0, h2 >>> 0];
}

/** mulberry32 — генератор на одно число состояния. Нужен ровно затем, чтобы из
 *  одного хеша вышло семь независимых величин, а не семь сдвигов одной. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** OKLCH → sRGB. Тон берётся непрерывным, а светлота и насыщенность заданы
 *  числами: в OKLCH равная светлота выглядит равной на любом тоне, и жёлтый не
 *  выбивается ярче синего, как выбивался бы в HSL. */
function oklch(l: number, c: number, h: number): Rgb {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.291485548 * b;
  const [L, M, S] = [lp * lp * lp, mp * mp * mp, sp * sp * sp];
  const linear = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  return linear.map((v) => {
    const gamma = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, gamma));
  }) as Rgb;
}

function hex(rgb: Rgb): string {
  return `#${rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Три шрифта на выбор, и все три системные: наружу окно не ходит ни за чем,
 *  включая гарнитуры.
 *
 *  Взяты три разных рода, а не три гротеска: на одной букве Segoe UI и
 *  Bahnschrift различаются шириной, и только — а антиква, узкий DIN и
 *  моноширинный видны как разные с первого взгляда. Текстовый Segoe поэтому и
 *  выпал из тройки: он тут самый безликий, а место у нас всего три.
 *
 *  Антиква и DIN названы прямо, а не токеном темы: своего серифного стека у окна
 *  нет, а заголовочный стек окна ушёл с Bahnschrift на Segoe UI Variable, и
 *  аватарка, взявшая бы его, сменила бы картинку у всех заведённых профилей. Georgia стоит на Windows со времён
 *  2000, Times New Roman — подстраховка на случай, если кириллицы в ней не
 *  окажется: пустой квадрат вместо буквы хуже скучной антиквы. */
const FONTS = ['Georgia, "Times New Roman", serif', 'Bahnschrift, "Segoe UI Variable Display", "Segoe UI Semibold", "Segoe UI", system-ui, sans-serif', "var(--font-mono)"];

/** Начертание — тоже по зерну, и ровно два: обычное и жирное. Промежуточных
 *  нет не из лени — у Georgia всего два реза, и запрошенное 600 браузер отдаст
 *  либо тем же 700, либо подделает наклоном штриха. Тогда две трети антиквенных
 *  аватарок вышли бы жирными, а разнообразия не прибавилось бы вовсе. 400 и 700
 *  честны у всех трёх: у переменных Bahnschrift и Cascadia это точки на оси, у
 *  Georgia — два настоящих начертания. */
const WEIGHTS = [400, 700];

export type Look = {
  /** Готовое значение `background`: три пятна и чёрная подложка под ними. */
  background: string;
  /** Цвет буквы — тот же тон, что и у пятен, только тёмный. */
  ink: string;
  font: string;
  weight: number;
  /** Плоский цвет для значка окна в панели задач. */
  color: string;
};

export function look(seed: string): Look {
  const h = hash2(seed);
  const random = mulberry32(h[0]);
  // Тон — сумма всех восьми байтов хеша: соседние имена расходятся по кругу
  // целиком, а не на пару градусов.
  const bytes = [0, 1, 2, 3].flatMap((i) => [(h[0] >> (i * 8)) & 0xff, (h[1] >> (i * 8)) & 0xff]);
  const hue = bytes.reduce((a, b) => a + b, 0) % 360;
  const light = oklch(0.88, 0.16, hue);
  const vivid = oklch(0.7, 0.2, (hue + 40) % 360);
  // Пятна не расходятся по самым углам: в arboweb они ложились куда угодно на
  // квадрат, а у нас картинка обрезана в круг на тёмном окне — пятно из угла
  // почти целиком остаётся снаружи, и половина кружка сливается с фоном.
  const spot = () => 0.2 + random() * 0.6;
  const blobs: [Rgb, number, number][] = [
    [light, spot(), spot()],
    [vivid, spot(), spot()],
    // Третье пятно — среднее двух: отдельный тон превратил бы аватарку в
    // радугу, а по тону её и узнают среди дюжины таких же.
    [light.map((v, i) => (v + vivid[i]) / 2) as Rgb, spot(), spot()],
  ];
  return {
    background: [
      ...blobs.map(
        ([rgb, x, y]) =>
          `radial-gradient(ellipse 67% 67% at ${(x * 100).toFixed(1)}% ${(y * 100).toFixed(1)}%, ${hex(rgb)}, #000)`,
      ),
      "#000",
    ].join(", "),
    // Буква — тот же тон, но тёмный: пятна светлые (0.88 и 0.7) и из середины
    // не уходят, так что светлее буквы фон под ней будет всегда. Выбирать между
    // чёрной и белой не из чего — прогон по двадцати тысячам зёрен дал яркость
    // центра от 0.35 до 0.89, то есть белая не выпала ни разу; ветка на этот
    // случай была бы кодом, который не исполняется.
    //
    // `b3` — прозрачность 0.7, и она не косметика: непрозрачная буква давала
    // контраст от 6.6:1 до 15.6:1, то есть на светлых аватарках выжигала дыру.
    // С прозрачностью тот же прогон даёт 3.9:1..6.3:1 — верх притушен вчетверо,
    // а низ остался выше 3:1, которых требует крупный жирный знак. Опускать
    // ниже нельзя: 0.6 уже даёт 3.1:1, 0.5 — 2.5:1, то есть буква начинает
    // теряться на самых тёмных пятнах.
    ink: `${hex(oklch(0.22, 0.08, hue))}b3`,
    font: FONTS[Math.floor(random() * FONTS.length)] ?? FONTS[0],
    // Вес тянется последним, и это не случайность: генератор отдаёт числа по
    // одному, и вставленный выше сдвинул бы весь хвост — у всех заведённых
    // профилей разъехались бы и пятна, и шрифт. Новое поле в конец — и картинки
    // остаются теми же, только обзаводятся начертанием.
    weight: WEIGHTS[Math.floor(random() * WEIGHTS.length)] ?? WEIGHTS[0],
    // Значок в панели задач — плоский кружок: буква там требовала бы шрифта и
    // растеризации в Rust. Берём насыщенное пятно, а не то, что вышло в
    // середине: на ноготь размером узнают цвет, а середина у трёх сложенных
    // пятен всегда бледнее любого из них.
    color: hex(vivid),
  };
}

/** Цвет браузерного профиля: им рисуется значок окна в панели задач
 *  (`icon_bytes` в оболочке). Считается здесь, а не в Rust, и оттуда передаётся
 *  строкой: посчитанный дважды, он разъехался бы на первой же правке — и стал
 *  бы врать про то, какое окно чьё. Зерно то же, что у аватарки, иначе кружок
 *  в панели задач перестанет быть её цветом. */
export function profileColor(seed: string): string {
  return look(seed).color;
}

/** Сама картинка. Размер приходит числом, а не классом: от него же считается
 *  кегль буквы, и вторым источником правды тут была бы пара «класс и число». */
export function Avatar({
  seed,
  name,
  size,
  className = "",
}: {
  seed: string;
  name: string;
  size: number;
  className?: string;
}) {
  const l = look(seed);
  // Первая буква — по кодовым точкам: имя начинают и с эмодзи, а `name[0]` дал
  // бы от него половину суррогатной пары, то есть пустой квадрат.
  const letter = [...name.trim()][0]?.toUpperCase() ?? "";
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full leading-none ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.46),
        fontFamily: l.font,
        fontWeight: l.weight,
        color: l.ink,
        background: l.background,
        // Осветление — то же, чем шейдер складывал пятна: перекрытие двух ярких
        // не темнеет, а светлеет, и в середине получается третий цвет.
        backgroundBlendMode: "screen",
      }}
    >
      {letter}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-6 text-center text-sm text-muted">{children}</p>;
}

/** Знак: корпус со сквозным лазом, смещённым влево и вниз. Смещение и есть
 *  марка — соосное отверстие превращает её в объектив. Разбор форм и заливок
 *  в `docs/brand.md`.
 *
 *  Форма здесь одна, мелкая (углы 18, лаз 26 в точке 36/62), потому что
 *  потребитель один — титульная полоса, 16 px. Крупная форма со свечением
 *  живёт там, где её видит операционная система: `scripts/icons.py`. Сторож —
 *  `the_mark_is_one_shape` в `core-ipc`.
 *
 *  Цвет берётся от текста (`currentColor`), а не фирменный #2E4BD8: плоский
 *  синий стиля рассчитан на светлую плитку, а полоса окна бывает и тёмной.
 *  Ставит цвет вызывающий — токеном темы, чтобы знак не тонул ни в одной.
 *
 *  Лаз вычитается (`fill-rule="evenodd"`), а не закрашивается фоном: заглушка
 *  своим цветом — прямо запрещённый вариант знака. */
export function Mark({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M18 0h64a18 18 0 0 1 18 18v64a18 18 0 0 1-18 18H18A18 18 0 0 1 0 82V18A18 18 0 0 1 18 0zm18 36a26 26 0 1 0 0 52 26 26 0 0 0 0-52z"
      />
    </svg>
  );
}
