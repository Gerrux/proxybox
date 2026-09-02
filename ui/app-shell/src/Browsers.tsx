import { useEffect, useState, type ReactNode } from "react";
import { forgetBrowser, type Act, type BrowserProfile, type Status } from "./platform";
import { strings } from "./i18n";
import { Avatar, Button, ConfirmButton, Empty, FIELD, flag, Icon, Panel, profileColor, type IconName } from "./ui";

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

/** Токены платформы в строке user-agent — ровно те, что пишет настоящий Chrome.
 *
 *  Windows 10 и Windows 11 отдельными пунктами не стоят: в user-agent они
 *  неразличимы, обе — `Windows NT 10.0`. Различает их только `Sec-CH-UA-Platform-Version`,
 *  а его флагом не подделать, и два пункта с одинаковым выводом были бы враньём
 *  в интерфейсе.
 *
 *  macOS замер на `10_15_7`, а не потому что мы отстали: Chrome сам заморозил
 *  этот номер (UA reduction), и любой другой в строке — аномалия. */
const PLATFORMS = [
  { id: "windows", token: "Windows NT 10.0; Win64; x64" },
  { id: "macos", token: "Macintosh; Intel Mac OS X 10_15_7" },
  { id: "linux", token: "X11; Linux x86_64" },
] as const;

/** Платформа этой машины — по вебвью. Нужна ровно для предупреждения: выбрали
 *  другую, и `Sec-CH-UA-Platform` разойдётся со строкой. */
function realPlatform(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Windows")) return "windows";
  if (ua.includes("Mac OS X")) return "macos";
  return "linux";
}

/** Как называется настоящая платформа в интерфейсе. Те же слова, что в списке
 *  выбора: человек сравнивает их глазами, и «win32» рядом с «Windows» заставило
 *  бы гадать, одно это и то же или нет. */
function realName(): string {
  return { windows: "Windows", macos: "macOS", linux: "Linux" }[realPlatform()] ?? "Linux";
}

/** Версия Chrome у самого окна: вебвью — тот же Chromium, что стоит рядом, и
 *  угадывать её незачем. Ноль — не вебвью (разработка в браузере). */
function realMajor(): number {
  return Number(navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? 0) || 131;
}

/** Строка из платформы и мажорной версии.
 *
 *  Хвост версии остаётся `0.0.0` не по лени: с версии 110 Chrome обнуляет его
 *  сам, и настоящий номер сборки в строке был бы аномалией, которую видно с
 *  первого запроса. Отсюда и смысл слова «уникальный»: профили различаются
 *  между собой, но каждая такая строка — общая для миллионов настоящих
 *  браузеров. Уникальность в смысле «единственный такой в интернете» здесь
 *  ровно то, чего надо избежать. */
function buildUa(platform: string, major: number): string {
  const token = PLATFORMS.find((p) => p.id === platform)?.token ?? PLATFORMS[0].token;
  return `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** Разбор строки обратно в поля конструктора: профиль открывают на правку, и
 *  показать в списках надо то, что в строке уже написано. Строку могли и
 *  вписать руками — тогда платформа «своя», и конструктор её не трогает. */
function parseUa(ua: string): { platform: string; major: number } {
  if (ua === "") return { platform: "", major: 0 };
  const major = Number(ua.match(/Chrome\/(\d+)/)?.[1] ?? 0);
  const platform = PLATFORMS.find((p) => ua.includes(p.token))?.id;
  return platform && major ? { platform, major } : { platform: "custom", major: 0 };
}

/** Версии на выбор: настоящая и несколько предыдущих. Не все обновляются в тот
 *  же день, поэтому версия на пару-тройку младше так же обычна, как настоящая;
 *  а вот старше настоящей быть не может — такой сборки ещё нет ни у кого. */
function versions(current: number): number[] {
  const real = realMajor();
  const list = Array.from({ length: 8 }, (_, i) => real - i);
  return current > 0 && !list.includes(current) ? [current, ...list] : list;
}

const EMPTY: BrowserProfile = { name: "", node: "", ua: "", lang: AUTO, icon: "" };

/** Зерно аватарки: своё, если человек её перекатывал, иначе имя. Пустым оно
 *  приходит и от профилей, заведённых до появления поля, — тогда картинка
 *  держится за имя, как держался за него цвет до неё. */
function seed(profile: BrowserProfile): string {
  return profile.icon || profile.name;
}

/** Новое зерно. Годится любая строка, которой раньше не было: смысла в ней нет
 *  никакого, весь смысл — в её хеше. */
function roll(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Поле формы: значок, подпись, само поле и описание под ним. Подпись обнимает
 *  поле `<label>`'ом — тогда по ней можно нажать, и читалке с экрана не нужно
 *  ничего дополнительно объяснять. */
function Field({
  icon,
  label,
  hint,
  className = "",
  children,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="engraved flex items-center gap-1.5 text-muted">
        <Icon name={icon} />
        {label}
      </span>
      {/* Строка вокруг поля обязательна: в `FIELD` живёт `flex-1`, и в
          колоночной раскладке он растянул бы поле по высоте вместо ширины. */}
      <div className="flex min-w-0 gap-2">{children}</div>
      {hint != null && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

/** Правка браузерного профиля — отдельной страницей поверх окна, а не полкой
 *  над списком. Полей тут полтора десятка, и постоянно занятая ими верхняя
 *  половина панели означала бы, что самих профилей почти не видно: форму
 *  заполняют раз на профиль, а на список смотрят каждый раз.
 *
 *  Закрывают её «Отмена» и Esc, и больше ничего: страница непрозрачна, мимо неё
 *  не попасть, а закрытие по промаху стоило бы заполненной формы. */
function Editor({
  status,
  act,
  draft,
  origin,
  setDraft,
}: {
  status: Status | null;
  act: Act;
  draft: BrowserProfile;
  /** Имя, под которым профиль открыли: пусто — заводят новый. Из самого
   *  черновика это не выводится — имя в нём человек набирает сам, и совпадение
   *  с чужим означало бы «правка» ровно тогда, когда идёт создание. */
  origin: string;
  setDraft: (draft: BrowserProfile | null) => void;
}) {
  const s = strings(status?.lang);
  const items = status?.browser_profiles ?? [];
  const nodes = status?.profiles ?? [];
  const editing = origin !== "";
  // Имя занято кем-то другим. Сохранение поверх переписало бы чужой профиль, а
  // каталог с его куками остался бы лежать под новой личностью — то есть чужие
  // входы достались бы новому окну.
  const taken = !editing && items.some((i) => i.name === draft.name.trim());
  const ready = draft.name.trim() !== "" && draft.node !== "" && !taken;
  // Поля конструктора не хранятся отдельно от строки: два источника правды
  // разъезжаются на первой же правке руками.
  const ua = parseUa(draft.ua);
  // Страна узла — из прогона профилей: до него её никто не знает, и «по стране
  // узла» честно об этом говорит вместо молчаливого английского.
  const probe = status?.probes.find((p) => p.name === draft.node);
  const code = probe?.code;
  const country = probe?.country;
  const title = editing ? s.browserEdit(origin) : s.browserNew;
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && setDraft(null);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [setDraft]);
  return (
    // Страницей во всё окно, а не карточкой посреди него: fixed — потому что
    // панель обрезает всё, что вылезло за её края (`overflow-hidden` в `Panel`),
    // и окно из неё было бы видно наполовину. Прокрутку держит `Panel`, форме
    // своя не нужна.
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="enter fixed inset-0 z-10 flex flex-col bg-bg p-3"
    >
      <Panel
        className="min-h-0 flex-1"
        title={title}
        action={
          <Button variant="quiet" onClick={() => setDraft(null)}>
            {s.browserCancel}
          </Button>
        }
      >
        <form
          // Поля не растягиваются на всю ширину монитора по той же причине, что и
          // списки в главном окне: строку читают глазом, а не рулеткой.
          className="mx-auto flex w-full max-w-2xl flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            void act({ cmd: "set-browser-profile", arg: { profile: { ...draft, name: draft.name.trim() } } }).then(
              (ok) => ok && setDraft(null),
            );
          }}
        >
          <div className="flex items-center gap-3">
            {/* Картинка стоит у имени, потому что от имени и зависит: буква на
                ней — первая буква того, что набирают рядом. Нажатие
                перекатывает зерно; кнопка тут настоящая, а не картинка с
                обработчиком, — иначе до неё не добраться с клавиатуры. */}
            <button
              type="button"
              onClick={() => setDraft({ ...draft, icon: roll() })}
              title={s.browserIconHint}
              aria-label={s.browserIconHint}
              className="group relative shrink-0 rounded-full transition duration-200 active:scale-95"
            >
              <Avatar seed={seed(draft)} name={draft.name} size={56} />
              {/* Под значком размыта сама аватарка (`backdrop-filter` мутит то,
                  что позади) и притемнена: белый значок читается тогда на любом
                  рисунке пятен, и подбирать ему цвет под каждую аватарку не
                  надо. */}
              <span className="absolute inset-0 grid place-items-center rounded-full bg-black/30 text-white opacity-0 backdrop-blur-[3px] transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
                <Icon name="repeat" className="size-5" />
              </span>
            </button>
            {/* В правке поле заперто: имя — ключ профиля и зерно имени его
                каталога (`core_ipc::dir_name` — сторож `session_dirs_do_not_collide`
                держит его различающим), а переименовать каталог отсюда нечем. Набранное новое имя раньше давало второй профиль с
                чистого листа, а входы оставались в старом — и починить это
                было нечем, потому что старый профиль из формы уже не виден. */}
            <Field
              icon="tag"
              label={s.browserName}
              hint={editing ? s.browserNameLocked : taken ? s.browserNameTaken : s.browserNameHint}
              className="flex-1"
            >
              <input
                autoFocus
                readOnly={editing}
                aria-invalid={taken}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={s.browserNamePlaceholder}
                spellCheck={false}
                className={`${FIELD} ${editing ? "text-muted" : ""} ${taken ? "border-fault" : ""}`}
              />
            </Field>
          </div>
          <Field icon="node" label={s.browserNode} hint={s.browserNodeHint}>
            {/* Родной select, а не свой список: узлов бывает под сотню, и
                системный уже умеет и поиск с клавиатуры, и прокрутку. */}
            <select
              value={draft.node}
              onChange={(e) => setDraft({ ...draft, node: e.target.value })}
              className={FIELD}
            >
              <option value="">{s.browserNodePick}</option>
              {nodes.map((node) => (
                // Адрес узла рядом с именем: имя профилю пишет чужая панель, и
                // два одинаково названных узла в выпадающем списке иначе
                // неразличимы.
                <option key={node.name} value={node.name}>
                  {node.server ? `${node.name} — ${node.server}` : node.name}
                </option>
              ))}
            </select>
          </Field>
          {/* Конструктор личности. Поля не декоративные: каждое попадает в
              строку user-agent, а строка остаётся редактируемой — вписанную
              руками конструктор не переписывает, он её разбирает. */}
          <fieldset className="flex flex-col gap-2.5 rounded-md border border-edge p-2.5">
            <legend className="engraved px-1 text-[11px] text-muted">{s.browserIdentity}</legend>
            <div className="flex flex-wrap gap-2">
              <Field icon="screen" label={s.browserPlatform} className="min-w-[9rem] flex-1">
                <select
                  value={ua.platform}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      // «Настоящая» — это пустая строка: подставлять нечего, и
                      // браузер пойдёт со своим UA.
                      ua: e.target.value === "" ? "" : buildUa(e.target.value, ua.major || realMajor()),
                    })
                  }
                  className={FIELD}
                >
                  <option value="">{s.browserPlatformReal}</option>
                  <option value="windows">Windows</option>
                  <option value="macos">macOS</option>
                  <option value="linux">Linux</option>
                  {/* Пункт живёт, только пока строку вписали руками: выбрать
                      его нельзя, но и врать про платформу он не даёт. */}
                  {ua.platform === "custom" && <option value="custom">{s.browserPlatformCustom}</option>}
                </select>
              </Field>
              <Field icon="chip" label={s.browserVersion} className="min-w-[8rem] flex-1">
                <select
                  value={ua.major}
                  disabled={ua.platform === "" || ua.platform === "custom"}
                  onChange={(e) => setDraft({ ...draft, ua: buildUa(ua.platform, Number(e.target.value)) })}
                  className={FIELD}
                >
                  {ua.major === 0 && <option value={0}>—</option>}
                  {versions(ua.major).map((v) => (
                    <option key={v} value={v}>
                      Chrome {v}
                    </option>
                  ))}
                </select>
              </Field>
              <Button
                variant="ghost"
                className="gap-1.5 self-end"
                title={s.browserRandomHint}
                onClick={() => {
                  const list = versions(0);
                  const platform = ua.platform === "" || ua.platform === "custom" ? realPlatform() : ua.platform;
                  setDraft({ ...draft, ua: buildUa(platform, list[Math.floor(Math.random() * list.length)]) });
                }}
              >
                <Icon name="dice" />
                {s.browserRandom}
              </Button>
            </div>
            <input
              aria-label={s.browserUaField}
              value={draft.ua}
              onChange={(e) => setDraft({ ...draft, ua: e.target.value })}
              placeholder={s.browserUa}
              spellCheck={false}
              className={`${FIELD} font-mono text-[11px]`}
            />
            {/* Что подставится на самом деле, видно тут же: «настоящая»
                оставляет строку браузера, и знать, какая она, человеку надо
                не меньше, чем видеть выдуманную. */}
            <p className="text-[11px] text-muted">
              {ua.platform === "" ? s.browserUaRealNow(realName(), realMajor()) : s.browserUaSet}
            </p>
            {/* Предупреждение стоит там, где его игнорировать труднее всего, —
                под самим выбором. Тултипом это было бы косметикой. */}
            {ua.platform !== "" && ua.platform !== "custom" && ua.platform !== realPlatform() && (
              <p className="flex items-start gap-1.5 text-[11px] text-wait">
                <Icon name="warn" className="mt-0.5" />
                {s.browserMismatch(realName())}
              </p>
            )}
            <p className="text-[11px] text-muted">{s.browserUaHint}</p>
          </fieldset>
          <Field icon="speech" label={s.browserLang} hint={s.browserLangHint}>
            <select
              value={draft.lang === AUTO || draft.lang === "" ? draft.lang : "custom"}
              onChange={(e) =>
                setDraft({ ...draft, lang: e.target.value === "custom" ? acceptLanguage(AUTO, code) : e.target.value })
              }
              className={FIELD}
            >
              <option value={AUTO}>{s.browserLangAuto}</option>
              <option value="">{s.browserLangSystem}</option>
              <option value="custom">{s.browserLangCustom}</option>
            </select>
            {/* Своё значение правится тут же, рядом с выбором: уводить его в
                отдельную строку значило бы оторвать поле от подписи. */}
            {draft.lang !== AUTO && draft.lang !== "" && (
              <input
                value={draft.lang}
                onChange={(e) => setDraft({ ...draft, lang: e.target.value })}
                spellCheck={false}
                className={`${FIELD} font-mono text-[11px]`}
              />
            )}
          </Field>
          {/* Тулинг для «авто»: что оно даст прямо сейчас и почему. Без этой
              строки «по стране узла» — обещание, которое нечем проверить, а
              страна берётся из прогона профилей и до него неизвестна. */}
          {draft.lang === AUTO && (
            <p className="text-[11px] text-muted">
              {country
                ? s.browserLangAutoNow(country, acceptLanguage(AUTO, code))
                : s.browserLangAutoUnknown(acceptLanguage(AUTO, code))}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="submit" variant="primary" disabled={!ready}>
              {editing ? s.browserSave : s.browserCreate}
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}

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
  browse: (profile: BrowserProfile, color: string) => void;
  className?: string;
}) {
  const s = strings(status?.lang);
  const items = status?.browser_profiles ?? [];
  const nodes = status?.profiles ?? [];
  // Черновик и есть признак открытой страницы правки: null — её нет. Рядом с
  // ним — имя, под которым профиль открыли: по нему форма и отличает правку от
  // заведения. Из самого черновика это не выводится: имя в нём набирают руками.
  const [draft, setDraft] = useState<BrowserProfile | null>(null);
  const [origin, setOrigin] = useState("");
  const openForm = (profile: BrowserProfile | null, from = "") => {
    setDraft(profile);
    setOrigin(from);
  };
  return (
    <Panel
      className={className}
      title={s.browsers}
      note={items.length > 0 && <span className="text-muted">{items.length}</span>}
      action={
        // Заводить профиль, когда нет ни одного узла, не во что: под кнопкой
        // открылась бы форма с пустым списком узлов и запертой кнопкой.
        nodes.length > 0 && (
          <Button variant="quiet" onClick={() => openForm(EMPTY)}>
            {s.browserNew}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {nodes.length === 0 && <Empty>{s.browserNeedsNode}</Empty>}
        {draft && (
          <Editor status={status} act={act} draft={draft} origin={origin} setDraft={(d) => openForm(d, d ? origin : "")} />
        )}
        {items.length === 0 ? (
          <Empty>{s.browserEmpty}</Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((item) => {
              const live = status?.browsers.includes(item.name) ?? false;
              // Узел могли удалить или он мог пропасть из подписки: профиль это
              // переживает — в его каталоге входы, — но открыть его нечем, и
              // молчать об этом нельзя.
              const gone = !nodes.some((n) => n.name === item.node);
              const code = status?.probes.find((p) => p.name === item.node)?.code;
              return (
                <li
                  key={item.name}
                  className="enter smooth flex items-center gap-2 rounded-md py-1.5 ps-3 pe-1 hover:bg-surface-2"
                >
                  {/* Та же картинка, что человек выбрал в форме: по ней профиль
                      и находят в списке, а её цвет — цвет значка окна в панели
                      задач, по которому окна сопоставляют между собой. */}
                  <Avatar seed={seed(item)} name={item.name} size={26} />
                  <div className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[13px]" title={item.name}>
                      {item.name}
                    </span>
                    <span className="flex items-baseline gap-2 overflow-hidden text-[11px] text-muted">
                      {live && <span className="engraved shrink-0 text-open">{s.browserOpenState}</span>}
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
                    onClick={() => browse({ ...item, lang: acceptLanguage(item.lang, code) }, profileColor(seed(item)))}
                  >
                    {s.browserOpen}
                  </Button>
                  <Button variant="quiet" aria-label={s.browserEdit(item.name)} onClick={() => openForm(item, item.name)}>
                    ✎
                  </Button>
                  {/* В два клика: с профилем уходят его куки и входы, а это
                      единственное, чего здесь не восстановить.

                      Пока окно живо, каталог сеанса занят, и `remove_dir_all`
                      по нему падает: профиль уйдёт, а куки останутся лежать.
                      Спрашиваем тогда другим текстом: обещание про приватность
                      либо выполняется, либо не даётся. */}
                  <ConfirmButton
                    label={s.browserRemove(item.name)}
                    ask={live ? s.confirmRemoveOpen : s.confirmRemove}
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
