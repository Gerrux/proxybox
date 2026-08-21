/** Примитивы интерфейса. Пока живут в оболочке: второго потребителя нет, а
 *  отдельный пакет ui-kit ради одного — лишний слой. */
import { useState, type ReactNode } from "react";

/** Панель — плита с гравированной подписью. Содержимое утоплено в неё
 *  (`surface-2` темнее `surface`), а не лежит карточкой сверху. */
export function Panel({
  title,
  note,
  action,
  className = "",
  children,
}: {
  title: string;
  note?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`plate smooth flex min-h-0 flex-col overflow-hidden rounded-lg border border-edge ${className}`}
    >
      {/* Подпись плиты обрезаться не имеет права — по ней и находят панель.
          Ужимается сначала счётчик, потом действия уезжают на вторую строку;
          shrink-0 держит саму полосу, когда панели тесно по высоте. */}
      <header className="plate-head flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-edge px-4 py-2">
        <h2 className="engraved flex min-w-0 flex-1 items-baseline gap-2 text-muted">
          <span className="shrink-0">{title}</span>
          {note != null && (
            <span className="min-w-0 truncate font-sans text-[11px] font-normal normal-case tracking-normal">
              {note}
            </span>
          )}
        </h2>
        {action}
      </header>
      <div className="scroll min-h-0 flex-1 overflow-y-auto p-3.5">{children}</div>
    </section>
  );
}

const VARIANTS = {
  primary: "border-transparent bg-accent text-bg hover:opacity-90",
  ghost: "border-edge bg-surface-2 hover:border-accent",
  quiet: "border-transparent text-muted hover:text-ink",
  danger: "border-transparent text-muted hover:text-fault",
} as const;

export function Button({
  variant = "ghost",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS }) {
  // active:scale-95 — команда уходит в службу и может там задержаться на
  // секунды, но само нажатие обязано подтвердиться в тот же кадр.
  return (
    <button
      type="button"
      {...props}
      // Кнопки-символы (✕, ⟳, ⧉) подписаны только для чтения с экрана, а мышь
      // о них не узнаёт ничего: ту же строку отдаём и всплывающей подсказке.
      // После расстановки props — иначе своя `title` затёрлась бы пустой.
      title={props.title ?? props["aria-label"]}
      className={`inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-md border px-3 text-[13px] font-medium transition duration-200 active:scale-95 disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
    />
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
      className={`flex shrink-0 gap-0.5 rounded-md border border-edge bg-surface-2 p-0.5 ${className}`}
    >
      {options.map(([id, text, hint]) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          title={hint}
          disabled={disabled}
          onClick={() => onPick(id)}
          className={`seg-btn smooth engraved rounded-[3px] px-3.5 py-1.5 disabled:opacity-40 ${
            value === id ? "bg-surface text-ink" : "text-muted hover:text-ink"
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Значки полей. Свои `<svg>`, а не глифы шрифта, по той же причине, что и у
 *  кнопок окна: `Segoe MDL2 Assets` есть не на всякой системе, а отсутствующий
 *  глиф — пустой квадрат вместо смысла. Эмодзи не годятся тем же: их рисует
 *  система, и в тёмной панели они цветные и чужие, а эти наследуют `currentColor`.
 *
 *  Сетка 12×12 и толщина 1.3 — те же, что у стрелок приборной линейки: два
 *  разных штриха в одном окне видно сразу. */
const ICONS = {
  tag: "M6.5 1.5H1.5V6.5L6.5 11.5 11.5 6.5ZM3.8 3.8h.01",
  node: "M6 1a5 5 0 100 10A5 5 0 006 1ZM1 6h10M6 1c2.4 2.7 2.4 7.3 0 10M6 1C3.6 3.7 3.6 8.3 6 11",
  screen: "M1.5 2.5h9v6h-9zM4.5 10.5h3M6 8.5v2",
  chip: "M3.5 3.5h5v5h-5zM5 1.5v2M7 1.5v2M5 8.5v2M7 8.5v2M1.5 5h2M1.5 7h2M8.5 5h2M8.5 7h2",
  speech: "M1.5 2.5h9v5.5h-5L2.5 10.5V8H1.5z",
  dice: "M2 2h8v8H2zM4.2 4.2h.01M7.8 7.8h.01M6 6h.01",
  warn: "M6 1.5 11 10.5H1zM6 4.5v2.5M6 9h.01",
  lines: "M1.5 2.5h9M1.5 5h9M1.5 7.5h6",
  browser: "M1.5 2.5h9v7h-9zM1.5 4.5h9M3.2 3.5h.01M4.9 3.5h.01",
  swap: "M1.5 3.5h7L6.5 1.5M10.5 8.5h-7L5.5 10.5",
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
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
  "selectable h-8 w-full min-w-0 flex-1 rounded-md border border-edge bg-surface-2 px-3 text-[13px] outline-none transition-colors placeholder:text-muted focus:border-accent";

/** Поле «ввести и добавить»: своё состояние держит само — снаружи оно не нужно.
 *
 *  Чистится только на «приняли». Разобрать ссылку служба может отказаться — и
 *  тогда очищенное поле означало бы, что вставленный share-link надо искать
 *  заново, хотя в нём чаще всего опечатка в один символ. */
export function AddField({
  placeholder,
  label,
  onSubmit,
  className = "",
}: {
  placeholder: string;
  label: string;
  onSubmit: (value: string) => Promise<boolean>;
  className?: string;
}) {
  const [value, setValue] = useState("");
  // Подписка выкачивается секундами: без этого второй Enter уходил бы службе
  // вдогонку первому.
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={`flex gap-2 ${className}`}
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        void onSubmit(trimmed)
          .then((accepted) => accepted && setValue(""))
          .finally(() => setBusy(false));
      }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={FIELD}
      />
      <Button type="submit" variant="primary" disabled={busy || !value.trim()}>
        {label}
      </Button>
    </form>
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
      <Button variant="danger" aria-label={label} onClick={() => setArmed(true)}>
        ✕
      </Button>
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

/** Поиск по списку. `type="search"` — не украшение: WebView2 сам рисует крестик
 *  очистки и чистит поле по Esc, своего кода на это не нужно. Значение живёт
 *  снаружи: фильтрует тот, кто владеет списком. */
export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className={FIELD}
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

/** Цвет браузерного профиля: он же становится значком окна в панели задач
 *  (`icon_bytes` в оболочке) и точкой в списке. Считается здесь, а не в Rust, и
 *  оттуда передаётся строкой: посчитанный дважды, он разъехался бы на первой же
 *  правке палитры — и стал бы врать про то, какое окно чьё.
 *
 *  Двенадцать цветов — столько, сколько человек различит взглядом на панель
 *  задач. Тринадцатый профиль повторит цвет первого, и это лучше, чем два почти
 *  одинаковых оттенка. Хеш тот же FNV-1a, что и у имён каталогов: цвет обязан
 *  держаться за имя, а не за порядок в списке.
 *
 *  Цвета заданы числами, а не токенами темы: значок в панели задач рисуется
 *  один раз при запуске окна и темы приложения не знает вовсе. */
const PROFILE_COLORS = [
  "#4c8dff",
  "#2eb872",
  "#e87d2e",
  "#d64b6a",
  "#8b6fe8",
  "#1fa8a8",
  "#c4a42e",
  "#6b8e3a",
  "#d05cc0",
  "#3a6ec4",
  "#a85a2e",
  "#5f7a8c",
];

export function profileColor(name: string): string {
  let hash = 0x811c9dc5;
  for (const char of name) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0;
  }
  return PROFILE_COLORS[hash % PROFILE_COLORS.length] ?? PROFILE_COLORS[0];
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-[13px] text-muted">{children}</p>;
}
