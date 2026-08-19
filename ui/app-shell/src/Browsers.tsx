import { useState } from "react";
import { forgetBrowser, type Act, type BrowserProfile, type Status } from "./platform";
import { strings } from "./i18n";
import { Button, ConfirmButton, Empty, FIELD, flag, Panel } from "./ui";

/** `Accept-Language` по коду страны узла — это и есть «Авто». Список короткий
 *  намеренно: тут самые частые точки выхода, всем остальным достаётся
 *  английский. Он не врёт про страну и никого не удивляет, а выдуманный язык
 *  редкой страны — наоборот, приметный. */
const LANGS: Record<string, string> = {
  NL: "nl-NL,nl,en-US,en",
  DE: "de-DE,de,en-US,en",
  FR: "fr-FR,fr,en-US,en",
  ES: "es-ES,es,en-US,en",
  IT: "it-IT,it,en-US,en",
  PL: "pl-PL,pl,en-US,en",
  SE: "sv-SE,sv,en-US,en",
  FI: "fi-FI,fi,en-US,en",
  TR: "tr-TR,tr,en-US,en",
  RU: "ru-RU,ru,en-US,en",
  UA: "uk-UA,uk,en-US,en",
  JP: "ja-JP,ja,en-US,en",
  US: "en-US,en",
  GB: "en-GB,en",
  CA: "en-CA,en",
  CH: "de-CH,de,en-US,en",
};

/** Язык «по стране узла». Хранится словом `auto`, а не готовой строкой: узел у
 *  профиля меняют, и записанный однажды голландский пережил бы переезд в
 *  Японию. */
export const AUTO = "auto";

function acceptLanguage(lang: string, code: string | null | undefined): string {
  if (lang !== AUTO) return lang;
  return (code && LANGS[code.toUpperCase()]) ?? "en-US,en";
}

/** Правдоподобный user-agent, а не выдуманный.
 *
 *  Мажорная версия берётся из самого окна: вебвью — это тот же Chromium, что
 *  стоит рядом, и угадывать её незачем. Хвост версии остаётся `0.0.0` не по
 *  лени: с версии 110 Chrome обнуляет его сам (UA reduction), и настоящий номер
 *  сборки в строке был бы аномалией, которую видно с первого запроса.
 *
 *  Отсюда и смысл слова «уникальный»: профили различаются между собой мажорной
 *  версией, но каждая такая строка — общая для миллионов настоящих браузеров.
 *  Уникальность в смысле «единственный такой в интернете» здесь ровно то,
 *  чего надо избежать. */
function makeUa(): string {
  const real = Number(navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? 0);
  const base = real > 0 ? real : 131;
  // Не все обновляются в тот же день: версия на пару-тройку младше настоящей
  // так же обычна, как сама настоящая.
  const major = base - Math.floor(Math.random() * 4);
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const EMPTY: BrowserProfile = { name: "", node: "", ua: "", lang: AUTO };

/** Браузерные профили: имя, узел, личность. Отдельным списком, а не строкой у
 *  узла, именно потому, что их бывает несколько на один узел — иначе два
 *  аккаунта через одну страну не развести. */
export function Browsers({
  status,
  act,
  browse,
  className,
}: {
  status: Status | null;
  act: Act;
  browse: (profile: BrowserProfile) => void;
  className?: string;
}) {
  const s = strings(status?.lang);
  const items = status?.browser_profiles ?? [];
  const nodes = status?.profiles ?? [];
  const [draft, setDraft] = useState<BrowserProfile>(EMPTY);
  const ready = draft.name.trim() !== "" && draft.node !== "";
  return (
    <Panel
      className={className}
      title={s.browsers}
      note={items.length > 0 && <span className="text-muted">{items.length}</span>}
    >
      <div className="flex flex-col gap-4">
        {nodes.length === 0 ? (
          <Empty>{s.browserNeedsNode}</Empty>
        ) : (
          <form
            className="flex flex-col gap-2 rounded-md border border-edge bg-surface-2 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!ready) return;
              void act({ cmd: "set-browser-profile", arg: { profile: { ...draft, name: draft.name.trim() } } }).then(
                (ok) => ok && setDraft(EMPTY),
              );
            }}
          >
            <div className="flex gap-2">
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={s.browserName}
                spellCheck={false}
                className={FIELD}
              />
              {/* Родной select, а не свой список: узлов бывает под сотню, и
                  системный уже умеет и поиск с клавиатуры, и прокрутку. */}
              <select
                value={draft.node}
                onChange={(e) => setDraft({ ...draft, node: e.target.value })}
                className={FIELD}
              >
                <option value="">{s.browserNode}</option>
                {nodes.map((node) => (
                  <option key={node} value={node}>
                    {node}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <input
                value={draft.ua}
                onChange={(e) => setDraft({ ...draft, ua: e.target.value })}
                placeholder={s.browserUa}
                title={s.browserUaHint}
                spellCheck={false}
                className={`${FIELD} font-mono text-[11px]`}
              />
              <Button variant="ghost" title={s.browserUaHint} onClick={() => setDraft({ ...draft, ua: makeUa() })}>
                {s.browserUaMake}
              </Button>
            </div>
            <div className="flex gap-2">
              <input
                value={draft.lang}
                onChange={(e) => setDraft({ ...draft, lang: e.target.value })}
                placeholder={s.browserLang}
                title={s.browserLangHint}
                spellCheck={false}
                className={`${FIELD} font-mono text-[11px]`}
              />
              <Button type="submit" variant="primary" disabled={!ready}>
                {s.browserCreate}
              </Button>
            </div>
          </form>
        )}
        {items.length === 0 ? (
          <Empty>{s.browserEmpty}</Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((item) => {
              const open = status?.browsers.includes(item.name) ?? false;
              // Узел могли удалить или он мог пропасть из подписки: профиль это
              // переживает — в его каталоге входы, — но открыть его нечем, и
              // молчать об этом нельзя.
              const gone = !nodes.includes(item.node);
              const code = status?.probes.find((p) => p.name === item.node)?.code;
              return (
                <li
                  key={item.name}
                  className="enter smooth flex items-center gap-2 rounded-md py-1.5 pl-3 pr-1 hover:bg-surface-2"
                >
                  <div className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[13px]" title={item.name}>
                      {item.name}
                    </span>
                    <span className="flex items-baseline gap-2 overflow-hidden text-[11px] text-muted">
                      {open && <span className="engraved shrink-0 text-open">{s.browserOpenState}</span>}
                      <span className={`shrink-0 ${gone ? "text-fault" : ""}`} title={gone ? s.browserNodeGone : item.node}>
                        {item.node}
                      </span>
                      {flag(code) && (
                        <span className="shrink-0 text-[13px] leading-none" aria-hidden>
                          {flag(code)}
                        </span>
                      )}
                      {/* Личность целиком в строку не влезает никогда, а знать
                          про неё надо ровно одно: подменена она или настоящая. */}
                      <span className="min-w-0 truncate font-mono" title={item.ua || s.browserUaReal}>
                        {item.ua ? item.ua.replace(/^.*Chrome\//, "Chrome/").replace(/ Safari.*$/, "") : s.browserUaReal}
                      </span>
                    </span>
                  </div>
                  <Button
                    variant="quiet"
                    disabled={gone}
                    title={gone ? s.browserNodeGone : s.browserOpenHint(item.node)}
                    onClick={() => browse({ ...item, lang: acceptLanguage(item.lang, code) })}
                  >
                    {s.browserOpen}
                  </Button>
                  <Button variant="quiet" aria-label={s.browserEdit(item.name)} onClick={() => setDraft(item)}>
                    ✎
                  </Button>
                  {/* В два клика: с профилем уходят его куки и входы, а это
                      единственное, чего здесь не восстановить. */}
                  <ConfirmButton
                    label={s.browserRemove(item.name)}
                    ask={s.confirmRemove}
                    onConfirm={() => {
                      // Профиля больше нет — хранить его куки и входы не для
                      // чего. Отказ проглатываем: каталог мог быть занят
                      // открытым окном, а профиль уходит в любом случае.
                      void forgetBrowser(item.name).catch(() => {});
                      void act({ cmd: "remove-browser-profile", arg: { name: item.name } });
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Panel>
  );
}
