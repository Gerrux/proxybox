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
  repeat: "M6 1.5A4.5 4.5 0 111.5 6M.8 6.9 1.5 6 2.2 6.9",
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

/** То же поле, но многострочное: высоту задаёт `rows`, а не `h-8`. */
const FIELD_MULTI = `${FIELD.replace("h-8", "h-auto")} resize-none py-[5px] leading-[22px]`;

/** Чем кончилась отправка: приняли ли и что сказали. Служба отвечает не только
 *  «да» и «нет» — из импорта приезжает счёт («заведено 12, пропущено 38»), и
 *  показывать его надо там же, куда вставляли. */
export type Outcome = { ok: boolean; note?: string; bad?: boolean };

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
}) {
  const [value, setValue] = useState("");
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
            .then((outcome) => {
              setSaid(outcome.note ? outcome : null);
              if (outcome.ok) setValue("");
            })
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
            <label className={`${VARIANTS.ghost} inline-flex h-8 cursor-pointer items-center justify-center whitespace-nowrap rounded-md border px-3 text-[13px] font-medium transition duration-200`}>
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
        <span className={`text-[11px] ${said.bad ? "text-fault" : "text-muted"}`}>{said.note}</span>
      )}
      {!said && sniffed && <span className="text-[11px] text-muted">{sniffed}</span>}
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
 *  Антиква названа прямо, а не токеном темы: своего серифного стека у окна нет,
 *  и заводить его ради одной буквы незачем. Georgia стоит на Windows со времён
 *  2000, Times New Roman — подстраховка на случай, если кириллицы в ней не
 *  окажется: пустой квадрат вместо буквы хуже скучной антиквы. */
const FONTS = ['Georgia, "Times New Roman", serif', "var(--font-display)", "var(--font-mono)"];

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
  return <p className="py-6 text-center text-[13px] text-muted">{children}</p>;
}
