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
      className={`smooth flex min-h-0 flex-col overflow-hidden rounded-lg border border-edge bg-surface ${className}`}
    >
      {/* Подпись плиты обрезаться не имеет права — по ней и находят панель.
          Ужимается сначала счётчик, потом действия уезжают на вторую строку;
          shrink-0 держит саму полосу, когда панели тесно по высоте. */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-edge px-4 py-2">
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
      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">{children}</div>
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
}: {
  placeholder: string;
  label: string;
  onSubmit: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  // Подписка выкачивается секундами: без этого второй Enter уходил бы службе
  // вдогонку первому.
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex gap-2"
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

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-[13px] text-muted">{children}</p>;
}
