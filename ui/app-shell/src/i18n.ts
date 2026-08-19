/** Строки интерфейса. Два полных словаря вместо ключей с подстановкой: EN
 *  типизирован как RU, поэтому забытый перевод — ошибка сборки, а не пропажа
 *  надписи в окне. */
import type { Lang } from "./platform";

const RU = {
  serviceDown: "Служба не отвечает",
  serviceDownHint: "Запустите PrivacyGateway от имени администратора — без службы ничего не работает",
  off: "Приватный режим выключен",
  offHint: "Выбранные приложения ходят в сеть напрямую",
  offNoProfiles: "Сначала добавьте профиль — включать пока нечего",
  offHintAll: "Компьютер ходит в сеть напрямую",
  connecting: "Подключение…",
  connectingHint: "Пока туннель не подтверждён, выбранные приложения остаются без сети",
  connectingHintAll: "Пока туннель не подтверждён, компьютер остаётся без сети",
  up: "Защищено",
  upHint: (n: number) => `В туннеле приложений: ${n}. Остальной трафик не тронут`,
  upHintAll: "Весь трафик компьютера идёт через туннель",
  upNoApps: "Туннель поднят, но ни одно приложение не выбрано",
  down: "Туннеля нет — доступ закрыт",
  downHint: "Так и задумано: без туннеля выбранные приложения остаются без сети",
  downHintAll: "Так и задумано: без туннеля компьютер остаётся без сети",
  turnOn: "Включить",
  turnOff: "Выключить",
  conduitTo: "сеть",
  profile: "Профиль",
  noProfile: "не выбран",
  latency: "Задержка",
  exit: "Точка выхода",
  received: "Принято",
  sent: "Отправлено",
  profiles: "Профили",
  importLink: "Импорт",
  linkPlaceholder: "share-link, адрес подписки или JSON узла",
  noProfiles: "Профилей нет. Вставьте share-link, адрес подписки или JSON-конфиг — разберётся сам.",
  subscriptions: "Подписки",
  refreshSubscription: (url: string) => `Обновить подписку ${url}`,
  tabMain: "Главное",
  tabBrowsers: "Браузеры",
  browsers: "Браузеры",
  browserNeedsNode: "Сначала заведите профиль узла — через него и пойдёт окно браузера.",
  browserEmpty:
    "Профилей браузера нет. Заведите первый: имя и узел обязательны, личность можно оставить как есть.",
  browserName: "Имя",
  browserNamePlaceholder: "работа, личное, магазин",
  browserNameHint: "Им же назван каталог с куками и входами этого окна.",
  browserNode: "Узел",
  browserNodePick: "выберите узел",
  browserNodeHint: "Через него пойдёт трафик окна. Общий режим не трогается.",
  browserIdentity: "Личность",
  browserPlatform: "Платформа",
  browserPlatformReal: "Настоящая — не подменять",
  browserPlatformCustom: "Своя строка",
  browserVersion: "Версия Chrome",
  browserRandom: "Случайно",
  browserRandomHint: "Случайная версия Chrome на этой же платформе",
  browserMismatch: (real: string) =>
    `Sec-CH-UA всё равно скажет «${real}»: сайт, который смотрит client hints, увидит расхождение со строкой.`,
  browserUa: "user-agent — пусто, значит настоящий",
  browserUaField: "Строка user-agent",
  browserUaSet: "Эта строка уйдёт в --user-agent и в navigator.userAgent.",
  browserUaRealNow: (platform: string, major: number) =>
    `Строка не подставляется — браузер пойдёт со своей. Здесь это ${platform}, Chrome ${major}.`,
  browserUaHint:
    "Меняет строку запроса и navigator.userAgent. Sec-CH-UA, часовой пояс, canvas, WebGL, экран и число ядер остаются настоящими и общими у всех профилей этой машины: это разделение аккаунтов, а не антидетект.",
  browserUaReal: "настоящий",
  browserLang: "Язык",
  browserLangHint: "Список вида nl-NL,nl,en-US,en — в том порядке, в каком его пришлёт браузер",
  browserLangAuto: "Язык: по стране узла",
  browserLangSystem: "Язык: системный",
  browserLangCustom: "Язык: свой",
  browserLangAutoNow: (country: string, value: string) => `Узел сейчас в стране «${country}» → ${value}`,
  browserLangAutoUnknown: (value: string) =>
    `Страна узла ещё не измерена — её узнает прогон профилей. До тех пор → ${value}`,
  browserCancel: "Отмена",
  browserSave: "Сохранить",
  browserCreate: "Создать",
  browserOpen: "Открыть",
  browserOpenHint: (node: string) =>
    `Открыть окно браузера через «${node}». Окно своё: ваши закладки и входы в нём не появятся, а его — сохранятся до следующего раза. Общий режим не трогается.`,
  browserEdit: (name: string) => `Изменить «${name}»`,
  browserRemove: (name: string) => `Убрать «${name}» вместе с его входами и куками`,
  browserNodeGone: "Узла больше нет — выберите профилю другой",
  removeSubscription: (url: string) => `Отписаться от ${url}`,
  active: "активен",
  browserOn: "браузер",
  browserOpenState: "открыт",
  browserOnHint: "Через этот узел открыто окно браузера. Закроете окно — сеанс погаснет сам",
  testProfiles: "Прогнать",
  testProfilesHint: "Проверить каждый профиль отдельным подключением, не трогая текущее",
  probeFailed: "не отвечает",
  measured: (ago: string) => `Измерено ${ago}`,
  logged: (ago: string) => `Записано ${ago}`,
  yesterday: "вчера",
  synced: (ago: string) => `Сверено ${ago}`,
  neverSynced: "не сверялись",
  agoNow: "только что",
  agoMin: (n: number) => `${n} мин назад`,
  agoHour: (n: number) => `${n} ч назад`,
  agoDay: (n: number) => `${n} дн назад`,
  remove: "Удалить",
  confirmRemove: "Удалить?",
  langRu: "Русский",
  langEn: "Английский",
  trafficHint: "За текущее подключение: счётчики начинаются заново с каждым запуском туннеля",
  railUp: "Идёт через туннель",
  railClosed: "Без сети: туннель не подтверждён",
  railDirect: "Идёт напрямую, мимо туннеля",
  apps: "Приложения",
  appsCount: (on: number, all: number) => `${on} из ${all} в туннеле`,
  discover: "Найти установленные",
  addApp: "Добавить",
  appPlaceholder: "C:\\Program Files\\…\\app.exe",
  noApps: "Список пуст — ничей трафик не перехватывается.",
  scopeApps: "Выбранные",
  scopeAll: "Весь компьютер",
  scopeAllNote: "Весь трафик компьютера идёт через туннель — приложения не отбираются, и этот список сейчас не применяется. Охват переключается на шапке окна, у левого конца канала.",
  searchApps: "Поиск по имени или пути",
  searchProfiles: "Поиск по имени профиля",
  appsShown: (shown: number) => `найдено ${shown}`,
  noMatches: "Ничего не подошло — попробуйте часть имени или папки.",
  journal: "Журнал",
  emptyJournal: "Пока ничего не происходило.",
  tabConns: "Соединения",
  conns: "Соединения",
  connsNote: (shown: number, total: number) =>
    shown < total ? `${shown} из ${total} — самые говорливые` : `${total}`,
  connsHint:
    "Что идёт через туннель прямо сейчас. Список спрашивается, пока эта панель открыта, и нигде не сохраняется: ни в журнале, ни на диске, ни тем более наружу.",
  connsOff: "Туннеля нет — и соединений нет.",
  connsEmpty: "Туннель поднят, но по нему пока никто не ходит.",
  connsTunnel: "туннель",
  connsDirect: "напрямую",
  connsDirectHint:
    "Это соединение идёт мимо туннеля. Для невыбранного приложения так и задумано; если приложение выбрано — правило по пути не совпало, и оно только считается защищённым.",
  connsNoProcess: "без процесса",
  connsNoProcessHint: "sing-box не определил владельца: так выглядит трафик службы, драйвера и DNS.",
  hideMessage: "Скрыть сообщение",
  minimizeWindow: "Свернуть окно",
  maximizeWindow: "Развернуть окно",
  restoreWindow: "Восстановить окно",
  closeWindow: "Закрыть окно",
  removeProfile: (name: string) => `Удалить профиль ${name}`,
  removeApp: (name: string) => `Убрать ${name}`,
  switchOn: "Вкл",
  switchOff: "Выкл",
  apply: "Применить",
  scope: "Охват",
  scopeHint:
    "«Весь компьютер» — это не «выбрать все приложения»: под туннель попадает и трафик, за которым нет процесса, — служба, драйвер, DNS.",
  refreshSubs: "Сверка подписок",
  refreshSubsHint:
    "Раз в шесть часов служба перечитывает подписки и заменяет узлы. Срок считается от последней сверки, а не от запуска службы. Активный узел при этом не гаснет, а пропавший не выключает приватный режим.",
  geoTitle: "Спрашивать страну",
  geoHint:
    "Единственный запрос службы наружу: страну узла спрашивают у стороннего сервиса — и только через туннель, с вашего настоящего адреса запрос не уходит. Выключите — страны в окне не будет.",
  probeTitle: "Цель пробы",
  probeHint:
    "Куда стучаться, чтобы признать туннель поднятым. Пусто — сервер самого узла: сторонних адресов продукт по умолчанию не трогает.",
  probePlaceholder: "host:port — пусто, значит сервер узла",
  singboxTitle: "Путь к sing-box",
  singboxHint:
    "Пусто — рядом со службой, иначе из PATH. Новый путь действует со следующего запуска туннеля: ради настройки живой туннель не гасится.",
  singboxPlaceholder: "C:\\Program Files\\sing-box\\sing-box.exe",
  autostartTitle: "Запускать с Windows",
  autostartHint:
    "Окно стартует вместе с системой и сразу уходит в трей. Службы это не касается: она в SCM и поднимает туннель без всякого окна — автозапуск нужен значку, иначе о запертой машине в интерфейсе ни следа.",
  autostartWindowsOnly: "Только в Windows",
  envOverride: "Перебито переменной окружения — служба сказала об этом в журнале",
  exitUnknown: "Точка выхода известна, пока туннель поднят",
  closeTitle: "Закрыть окно?",
  closeHint:
    "Служба держит туннель и правила брандмауэра без всякого окна: закрывается окно, а не продукт.",
  closeWarn:
    "Закроете совсем — в трее не останется значка, а туннель и правила останутся. Вернуть окно можно будет только ярлыком.",
  closeToTray: "Свернуть в трей",
  closeQuit: "Закрыть полностью",
  closeRemember: "Больше не спрашивать",
  openWindow: "Открыть окно",
  hidePanel: "Скрыть плашку",
  settings: "Настройки",
  settingsHint: "Настройки: язык, обновления",
  done: "Готово",
  language: "Язык",
  languageHint:
    "Язык хранит служба: сообщения журнала пишет она, и переключать их отдельно от интерфейса бессмысленно.",
  versionAndUpdates: "Версия и обновления",
  updatesHint: "За обновлениями окно ходит только по нажатию.",
  updateTo: (tag: string) => `Обновить до ${tag}`,
  version: "Версия",
  checkUpdates: "Проверить обновления",
  checking: "Спрашиваю GitHub…",
  upToDate: "Это последняя версия",
  updateAvailable: (tag: string) => `Вышла ${tag}`,
  download: "Скачать",
  allReleases: (n: number) => `Все релизы (${n})`,
};

const EN: typeof RU = {
  serviceDown: "Service is not responding",
  serviceDownHint: "Start PrivacyGateway as administrator — nothing works without the service",
  off: "Private mode is off",
  offHint: "Selected apps reach the network directly",
  offNoProfiles: "Add a profile first — there is nothing to turn on yet",
  offHintAll: "The computer reaches the network directly",
  connecting: "Connecting…",
  connectingHint: "Until the tunnel is confirmed, selected apps stay without network",
  connectingHintAll: "Until the tunnel is confirmed, the computer stays without network",
  up: "Protected",
  upHint: (n: number) => `Apps in the tunnel: ${n}. Other traffic is untouched`,
  upHintAll: "All computer traffic goes through the tunnel",
  upNoApps: "The tunnel is up, but no app is selected",
  down: "No tunnel — access is closed",
  downHint: "This is by design: without a tunnel the selected apps stay offline",
  downHintAll: "This is by design: without a tunnel the computer stays offline",
  turnOn: "Turn on",
  turnOff: "Turn off",
  conduitTo: "network",
  profile: "Profile",
  noProfile: "not selected",
  latency: "Latency",
  exit: "Exit point",
  received: "Received",
  sent: "Sent",
  profiles: "Profiles",
  importLink: "Import",
  linkPlaceholder: "share-link, subscription URL or node JSON",
  noProfiles: "No profiles yet. Paste a share-link, a subscription URL or a JSON config — it parses itself.",
  subscriptions: "Subscriptions",
  refreshSubscription: (url: string) => `Refresh subscription ${url}`,
  tabMain: "Main",
  tabBrowsers: "Browsers",
  browsers: "Browsers",
  browserNeedsNode: "Add a node profile first — the browser window goes through it.",
  browserEmpty: "No browser profiles yet. Add the first one: name and node are required, the identity can stay as is.",
  browserName: "Name",
  browserNamePlaceholder: "work, personal, shop",
  browserNameHint: "It also names the folder with this window's cookies and logins.",
  browserNode: "Node",
  browserNodePick: "pick a node",
  browserNodeHint: "The window's traffic goes through it. The general mode is untouched.",
  browserIdentity: "Identity",
  browserPlatform: "Platform",
  browserPlatformReal: "Real — do not spoof",
  browserPlatformCustom: "Custom string",
  browserVersion: "Chrome version",
  browserRandom: "Random",
  browserRandomHint: "A random Chrome version on the same platform",
  browserMismatch: (real: string) =>
    `Sec-CH-UA will still say "${real}": a site that reads client hints sees the mismatch with the string.`,
  browserUa: "user-agent — empty means the real one",
  browserUaField: "User-agent string",
  browserUaSet: "This string goes into --user-agent and navigator.userAgent.",
  browserUaRealNow: (platform: string, major: number) =>
    `Nothing is substituted — the browser goes with its own. Here that is ${platform}, Chrome ${major}.`,
  browserUaHint:
    "Changes the request header and navigator.userAgent. Sec-CH-UA, time zone, canvas, WebGL, screen and core count stay real and shared by every profile on this machine: this separates accounts, it is not an antidetect.",
  browserUaReal: "real",
  browserLang: "Language",
  browserLangHint: "A list like nl-NL,nl,en-US,en — in the order the browser will send it",
  browserLangAuto: "Language: by node country",
  browserLangSystem: "Language: system",
  browserLangCustom: "Language: custom",
  browserLangAutoNow: (country: string, value: string) => `The node is in ${country} now → ${value}`,
  browserLangAutoUnknown: (value: string) => `The node country is not measured yet — a test run finds it. Until then → ${value}`,
  browserCancel: "Cancel",
  browserSave: "Save",
  browserCreate: "Create",
  browserOpen: "Open",
  browserOpenHint: (node: string) =>
    `Open a browser window through "${node}". The window is its own: your bookmarks and logins do not appear in it, and its own are kept for next time. The general mode is untouched.`,
  browserEdit: (name: string) => `Edit "${name}"`,
  browserRemove: (name: string) => `Drop "${name}" with its logins and cookies`,
  browserNodeGone: "The node is gone — pick another one for this profile",
  removeSubscription: (url: string) => `Unsubscribe from ${url}`,
  active: "active",
  browserOn: "browser",
  browserOpenState: "open",
  browserOnHint: "A browser window is open through this node. Close the window and the session goes down by itself",
  testProfiles: "Test all",
  testProfilesHint: "Check every profile with a separate connection, without touching the current one",
  probeFailed: "no answer",
  measured: (ago: string) => `Measured ${ago}`,
  logged: (ago: string) => `Logged ${ago}`,
  yesterday: "yesterday",
  synced: (ago: string) => `Synced ${ago}`,
  neverSynced: "never synced",
  agoNow: "just now",
  agoMin: (n: number) => `${n} min ago`,
  agoHour: (n: number) => `${n} h ago`,
  agoDay: (n: number) => `${n} d ago`,
  remove: "Remove",
  confirmRemove: "Remove?",
  langRu: "Russian",
  langEn: "English",
  trafficHint: "For the current connection: the counters start over with every tunnel start",
  railUp: "Goes through the tunnel",
  railClosed: "No network: the tunnel is not confirmed",
  railDirect: "Goes directly, past the tunnel",
  apps: "Apps",
  appsCount: (on: number, all: number) => `${on} of ${all} in the tunnel`,
  discover: "Find installed",
  addApp: "Add",
  appPlaceholder: "C:\\Program Files\\…\\app.exe",
  noApps: "The list is empty — nobody's traffic is intercepted.",
  scopeApps: "Selected",
  scopeAll: "Whole computer",
  scopeAllNote: "All computer traffic goes through the tunnel — nothing is picked per app, so this list is not applied right now. The scope is switched in the window header, at the left end of the conduit.",
  searchApps: "Search by name or path",
  searchProfiles: "Search profiles by name",
  appsShown: (shown: number) => `${shown} found`,
  noMatches: "Nothing matched — try part of the name or folder.",
  journal: "Journal",
  emptyJournal: "Nothing has happened yet.",
  tabConns: "Connections",
  conns: "Connections",
  connsNote: (shown: number, total: number) =>
    shown < total ? `${shown} of ${total} — the loudest` : `${total}`,
  connsHint:
    "What goes through the tunnel right now. The list is asked for while this panel is open and stored nowhere: not in the journal, not on disk, and certainly not outside.",
  connsOff: "No tunnel — no connections.",
  connsEmpty: "The tunnel is up, but nobody is using it yet.",
  connsTunnel: "tunnel",
  connsDirect: "direct",
  connsDirectHint:
    "This connection bypasses the tunnel. For an app you did not pick that is by design; if the app is picked, the path rule did not match and it is only considered protected.",
  connsNoProcess: "no process",
  connsNoProcessHint: "sing-box could not tell the owner: that is how service, driver and DNS traffic looks.",
  hideMessage: "Hide message",
  minimizeWindow: "Minimize window",
  maximizeWindow: "Maximize window",
  restoreWindow: "Restore window",
  closeWindow: "Close window",
  removeProfile: (name: string) => `Remove profile ${name}`,
  removeApp: (name: string) => `Remove ${name}`,
  switchOn: "On",
  switchOff: "Off",
  apply: "Apply",
  scope: "Scope",
  scopeHint:
    "\"Whole computer\" is not \"select every app\": traffic with no process behind it — the service, the driver, DNS — goes into the tunnel too.",
  refreshSubs: "Subscription refresh",
  refreshSubsHint:
    "Every six hours the service re-reads the subscriptions and replaces the nodes. The clock runs from the last sync, not from the service start. The active node stays up, and a node that disappeared does not turn private mode off.",
  geoTitle: "Ask for the country",
  geoHint:
    "The only request the service makes outwards: the node country is asked from a third-party service — and only through the tunnel, never from your real address. Turn it off and the window shows no country.",
  probeTitle: "Probe target",
  probeHint:
    "Where to knock before calling the tunnel up. Empty — the node's own server: no third-party address is touched by default.",
  probePlaceholder: "host:port — empty means the node's server",
  singboxTitle: "Path to sing-box",
  singboxHint:
    "Empty — next to the service, otherwise from PATH. A new path takes effect on the next tunnel start: a live tunnel is not dropped for a setting.",
  singboxPlaceholder: "C:\\Program Files\\sing-box\\sing-box.exe",
  autostartTitle: "Start with Windows",
  autostartHint:
    "The window starts with the system and goes straight to the tray. The service is unaffected: it lives in the SCM and brings the tunnel up with no window at all — autostart is for the tray icon, without which a locked machine leaves no trace in the interface.",
  autostartWindowsOnly: "Windows only",
  envOverride: "Overridden by an environment variable — the service said so in the journal",
  exitUnknown: "The exit point is known while the tunnel is up",
  closeTitle: "Close the window?",
  closeHint:
    "The service holds the tunnel and the firewall rules with no window at all: it is the window that closes, not the product.",
  closeWarn:
    "Close it for good and no tray icon is left, while the tunnel and the rules stay. The window then comes back only from its shortcut.",
  closeToTray: "Hide to tray",
  closeQuit: "Close for good",
  closeRemember: "Do not ask again",
  openWindow: "Open window",
  hidePanel: "Hide the panel",
  settings: "Settings",
  settingsHint: "Settings: language, updates",
  done: "Done",
  language: "Language",
  languageHint:
    "The language is kept by the service: it writes the journal lines, and switching them apart from the interface makes no sense.",
  versionAndUpdates: "Version and updates",
  updatesHint: "The window asks about updates only when you press.",
  updateTo: (tag: string) => `Update to ${tag}`,
  version: "Version",
  checkUpdates: "Check for updates",
  checking: "Asking GitHub…",
  upToDate: "This is the latest version",
  updateAvailable: (tag: string) => `${tag} is out`,
  download: "Download",
  allReleases: (n: number) => `All releases (${n})`,
};

export type Strings = typeof RU;

export function strings(lang: Lang | undefined): Strings {
  return lang === "en" ? EN : RU;
}

/** Возраст события словами. Точность крупная нарочно: важно «сейчас или
 *  давно», а не сколько именно минут. */
function ago(s: Strings, at: number): string | undefined {
  if (!at) return undefined;
  const sec = Math.max(0, Math.floor(Date.now() / 1000) - at);
  return sec < 90
    ? s.agoNow
    : sec < 3600
      ? s.agoMin(Math.round(sec / 60))
      : sec < 86400
        ? s.agoHour(Math.round(sec / 3600))
        : s.agoDay(Math.round(sec / 86400));
}

/** Задержка и страна переживают перезапуск службы, и без возраста цифра
 *  прошлой недели читается как сегодняшняя. */
export function measuredAgo(s: Strings, at: number): string | undefined {
  const when = ago(s, at);
  return when && s.measured(when);
}

/** То же для журнала. Час и минуты в ленте есть, а возраста в них нет: «5 мин
 *  назад» глаз из «14:32» не считает, и подсказка отвечает именно на это. */
export function loggedAgo(s: Strings, at: number): string | undefined {
  const when = ago(s, at);
  return when && s.logged(when);
}

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Подпись дня в журнале. У сегодняшнего её нет — это умолчание, и подписывать
 *  его значит спорить с ним же. Год печатается только чужой: тридцать строк
 *  переживают перезапуск службы, а машина — и зимовку. */
export function dayLabel(s: Strings, lang: Lang, at: number): string | undefined {
  if (!at) return undefined;
  const when = new Date(at * 1000);
  const now = new Date();
  const days = Math.round((midnight(now) - midnight(when)) / 86_400_000);
  if (days <= 0) return undefined;
  if (days === 1) return s.yesterday;
  return when.toLocaleDateString(lang, {
    day: "numeric",
    month: "long",
    ...(when.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Возраст списка узлов. Без него по строке подписки не отличить список,
 *  пришедший час назад, от импортированного в прошлом месяце и с тех пор ни
 *  разу не сверенного: адрес-то один и тот же. */
export function syncedAgo(s: Strings, at: number | null): string {
  const when = at ? ago(s, at) : undefined;
  return when ? s.synced(when) : s.neverSynced;
}
