/** Обновления: список релизов проекта с GitHub.
 *
 *  Запрос ручной и никогда не уходит сам — принцип «наружу ничего» тут тот же,
 *  что и у остального окна: пока не нажали, приложение с api.github.com не
 *  разговаривает. Отправляется при этом только сам GET, ничего о машине.
 *
 *  Ставит обновление человек: приложение живёт в Program Files и переустанавливает
 *  службу под LocalSystem, а сертификата у проекта пока нет — тихо подменять
 *  собственную привилегированную часть скачанным файлом без подписи нельзя.
 *  Поэтому окно доводит до установщика и останавливается. */
import { useState } from "react";
import { openUrl, VERSION, type Lang } from "./platform";
import { strings } from "./i18n";
import { Button } from "./ui";

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

export function Updates({ lang }: { lang?: Lang }) {
  const s = strings(lang);
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

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
  const latest = releases?.[0];
  const fresh = latest != null && latest.tag_name.replace(/^v/, "") !== VERSION;

  return (
    <section className="enter shrink-0 rounded-xl border border-edge bg-surface px-4 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-muted">
          {s.version} <span className="font-medium text-ink">{VERSION}</span>
        </span>

        {fresh && <span className="swap font-medium text-accent">{s.updateAvailable(latest.tag_name)}</span>}
        {releases != null && !fresh && <span className="swap text-muted">{s.upToDate}</span>}
        {error != null && <span className="selectable text-closed">{error}</span>}

        <span className="flex-1" />

        {fresh && (
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
      </div>

      {expanded && releases != null && (
        <ul className="enter mt-2.5 max-h-40 overflow-y-auto border-t border-edge pt-2">
          {releases.map((r) => (
            <li key={r.tag_name} className="flex items-center gap-3 py-1">
              <span className={`font-medium ${r.tag_name.replace(/^v/, "") === VERSION ? "text-accent" : ""}`}>
                {r.tag_name}
              </span>
              <span className="text-muted">
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
    </section>
  );
}
