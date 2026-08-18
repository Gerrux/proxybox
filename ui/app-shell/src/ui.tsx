/** Примитивы интерфейса. Пока живут в оболочке: второго потребителя нет, а
 *  отдельный пакет ui-kit ради одного — лишний слой. */
import { useState, type ReactNode } from "react";

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
      className={`smooth flex min-h-0 flex-col overflow-hidden rounded-xl border border-edge bg-surface ${className}`}
    >
      <header className="flex items-center justify-between gap-3 border-b border-edge px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
          {title}
          {note != null && <span className="ml-2 font-normal normal-case tracking-normal">{note}</span>}
        </h2>
        {action}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
    </section>
  );
}

const VARIANTS = {
  primary: "border-transparent bg-accent text-bg hover:opacity-90",
  ghost: "border-edge bg-surface-2 hover:border-accent",
  quiet: "border-transparent text-muted hover:text-ink",
  danger: "border-transparent text-muted hover:text-closed",
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
      className={`inline-flex h-8 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border px-3 text-[13px] font-medium transition duration-200 active:scale-95 disabled:opacity-40 ${VARIANTS[variant]} ${className}`}
    />
  );
}

/** Поле «ввести и добавить»: своё состояние держит само — снаружи оно не нужно. */
export function AddField({
  placeholder,
  label,
  onSubmit,
}: {
  placeholder: string;
  label: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (!trimmed) return;
        onSubmit(trimmed);
        setValue("");
      }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="selectable h-8 min-w-0 flex-1 rounded-lg border border-edge bg-surface-2 px-3 text-[13px] outline-none transition-colors placeholder:text-muted focus:border-accent"
      />
      <Button type="submit" variant="primary" disabled={!value.trim()}>
        {label}
      </Button>
    </form>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-[13px] text-muted">{children}</p>;
}
