/** Настройки: язык и обновления. Всё, что читают раз в месяц, а не раз в
 *  минуту, — и потому лежит за кнопкой в титульной полосе, а не занимает
 *  постоянную полку в окне. Пока настройки открыты, списки не показываются:
 *  окно маленькое, и две вещи разом в нём всё равно не прочитать.
 *
 *  Запрос к GitHub ручной и никогда не уходит сам — принцип «наружу ничего» тут
 *  тот же, что и у остального окна: пока не нажали, приложение с api.github.com
 *  не разговаривает. Отправляется при этом только сам GET, ничего о машине.
 *
 *  Ставит обновление человек: приложение живёт в Program Files и переустанавливает
 *  службу под LocalSystem, а сертификата у проекта пока нет — тихо подменять
 *  собственную привилегированную часть скачанным файлом без подписи нельзя.
 *  Поэтому окно доводит до установщика и останавливается. */
import { useState } from "react";
import { openUrl, VERSION, type Lang } from "./platform";
import { strings } from "./i18n";
import { Button, Panel } from "./ui";

const REPO = "Gerrux/proxybox";

type Release = {
  tag_name: string;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  assets: { name: string; browser_download_url: string }[];
};

/** Установщик из релиза, а если его не приложили — страница релиза: там
 *  разберётся человек, а окно не должно врать ссылкой в никуда. */
function target(r: Release): string {
  return r.assets.find((a) => a.name.toLowerCase().endsWith(".exe"))?.browser_download_url ?? r.html_url;
}

/** Состояние проверки живёт выше настроек: про вышедшую версию говорит кнопка в
 *  титульной полосе, а она видна и с закрытыми настройками. Закрыли и открыли
 *  снова — окно не ходит в GitHub второй раз. */
export function useReleases() {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      // Все релизы, а не /latest: список нужен целиком — и чтобы показать, что
      // вообще выходило, и чтобы можно было вернуться на прежнюю версию.
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
        headers: { accept: "application/vnd.github+json" },
      });
      if (!r.ok) throw new Error(`GitHub: ${r.status}`);
      const all = (await r.json()) as Release[];
      setReleases(all.filter((x) => !x.draft));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReleases(null);
    } finally {
      setBusy(false);
    }
  };

  // ponytail: «новее» = верхний релиз в списке отличается от нашей версии,
  // semver не разбираем. Потолок — патч к старой ветке, выпущенный после новой
  // минорной: он окажется сверху, и окно предложит уйти назад. Понадобится —
  // сравнивать разобранным semver, это единственное место.
  const latest = releases?.[0] ?? null;
  const fresh = latest != null && latest.tag_name.replace(/^v/, "") !== VERSION;

  return { releases, error, busy, check, latest, fresh };
}

export type Releases = ReturnType<typeof useReleases>;

export function Settings({
  lang,
  onLang,
  onClose,
  rel,
  className,
}: {
  lang: Lang | undefined;
  onLang: (lang: Lang) => void;
  onClose: () => void;
  rel: Releases;
  className?: string;
}) {
  const s = strings(lang);
  const [expanded, setExpanded] = useState(false);
  const { releases, error, busy, check, latest, fresh } = rel;

  return (
    <Panel
      className={className}
      title={s.settings}
      action={
        <Button variant="quiet" onClick={onClose}>
          {s.done}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <Row title={s.language} note={s.languageHint}>
          <div className="flex gap-0.5 rounded-md border border-edge bg-surface-2 p-0.5">
            {(["ru", "en"] as const).map((code) => (
              // aria-pressed, а не только цвет: выбранный язык обязан быть
              // различим и без цвета, и на слух — как у переключателя охвата.
              <button
                key={code}
                type="button"
                aria-pressed={(lang ?? "ru") === code}
                aria-label={code === "ru" ? s.langRu : s.langEn}
                title={code === "ru" ? s.langRu : s.langEn}
                onClick={() => onLang(code)}
                className={`smooth engraved rounded-[3px] px-3.5 py-1.5 ${
                  (lang ?? "ru") === code ? "bg-surface text-ink" : "text-muted hover:text-ink"
                }`}
              >
                {code}
              </button>
            ))}
          </div>
        </Row>

        <div className="h-px bg-edge" />

        <Row
          title={s.versionAndUpdates}
          note={
            <>
              {s.version} <span className="font-mono text-[12px] text-ink">{VERSION}</span>
              {latest && fresh && <span className="text-accent"> · {s.updateAvailable(latest.tag_name)}</span>}
              {releases != null && !fresh && <span> · {s.upToDate}</span>}
              {/* Не дозвонились до GitHub — это поломка, а не запертый канал:
                  янтарь тут значил бы сработавшую защиту, которой здесь нет. */}
              {error != null && <span className="selectable text-fault"> · {error}</span>}
              <br />
              {s.updatesHint}
            </>
          }
        >
          {latest && fresh && (
            <Button variant="primary" onClick={() => void openUrl(target(latest))}>
              {s.download}
            </Button>
          )}
          {releases != null && releases.length > 0 && (
            <Button variant="quiet" onClick={() => setExpanded((v) => !v)}>
              {s.allReleases(releases.length)}
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => void check()}>
            {busy ? s.checking : s.checkUpdates}
          </Button>
        </Row>

        {expanded && releases != null && (
          <ul className="enter max-h-40 overflow-y-auto border-t border-edge pt-2 text-[13px]">
            {releases.map((r) => (
              <li key={r.tag_name} className="flex items-center gap-3 py-1">
                <span
                  className={`font-mono text-[12px] tabular-nums ${r.tag_name.replace(/^v/, "") === VERSION ? "text-accent" : ""}`}
                >
                  {r.tag_name}
                </span>
                <span className="font-mono text-[11px] text-muted">
                  {r.published_at ? new Date(r.published_at).toLocaleDateString(lang ?? "ru") : ""}
                </span>
                <span className="flex-1" />
                <Button variant="quiet" onClick={() => void openUrl(target(r))}>
                  {s.download}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/** Строка настройки: слева — что это и почему, справа — чем этим управляют.
 *  В узком окне управление уезжает под подпись, а не сплющивает её. */
function Row({ title, note, children }: { title: string; note: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="min-w-[180px] flex-1">
        <h3 className="engraved text-muted">{title}</h3>
        <p className="mt-1 text-[12.5px] text-muted">{note}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">{children}</div>
    </div>
  );
}
