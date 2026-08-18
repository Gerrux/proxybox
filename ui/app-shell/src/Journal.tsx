import { Empty, Panel } from "./ui";

/** Журнал службы: что она сделала и почему. Своих сообщений окно не выдумывает,
 *  кроме ошибок, до службы не дошедших. */
export function Journal({ lines, className }: { lines: string[]; className?: string }) {
  return (
    <Panel className={className} title="Журнал">
      {lines.length === 0 ? (
        <Empty>Пока ничего не происходило.</Empty>
      ) : (
        <ol className="flex flex-col gap-1 text-[12.5px] text-muted">
          {lines.map((line, i) => (
            <li key={`${i}-${line}`} className="selectable">
              {line}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
