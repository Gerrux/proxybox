/** Строки интерфейса. Полные словари вместо ключей с подстановкой: каждый
 *  типизирован как RU, поэтому забытый перевод — ошибка сборки, а не пропажа
 *  надписи в окне. Запасного языка тут нет и не нужно: `tsc` не даст завести
 *  словарь с дыркой, в отличие от службы, где полноту стережёт тест
 *  (`every_line_has_its_translation`).
 *
 *  RU остаётся первым: с него пишут, на него ссылается тип. */
import { RTL, type Lang } from "./platform";

const RU = {
  serviceDown: "Служба не отвечает",
  serviceDownHint: "Запустите proxybox от имени администратора — без службы ничего не работает",
  off: "Приватный режим выключен",
  offHintWhitelist: "Пока режим выключен, в сеть ходят все — и выбранные, и остальные",
  offNoProfiles: "Сначала добавьте профиль — включать пока нечего",
  offHintAll: "Компьютер ходит в сеть напрямую",
  connecting: "Подключение…",
  connectingHintWhitelist: "Пока туннель не подтверждён, без сети остаются все — и выбранные, и остальные",
  connectingHintAll: "Пока туннель не подтверждён, компьютер остаётся без сети",
  up: "Защищено",
  upHintWhitelist: (n: number) => `Сеть выдана приложениям: ${n}. У остальных её нет`,
  upHintAll: "Весь трафик компьютера идёт через туннель",
  // Пустой белый список запирает машину целиком: пропуска раздаются по
  // списку, а пустой список — это ноль пропусков. Предупреждений два, и
  // разница между ними в том, случилось это уже или ещё нет.
  noAppsLocked: "Ни одно приложение не выбрано — сети нет ни у кого",
  noAppsAhead: "Ни одно приложение не выбрано — в этом охвате сети не будет ни у кого",
  down: "Туннеля нет — доступ закрыт",
  downHintWhitelist: "Так и задумано: без туннеля без сети остаётся весь компьютер",
  downHintAll: "Так и задумано: без туннеля компьютер остаётся без сети",
  // Пока sing-box не поднимается, окно показывало «доступ закрыт» и молчало:
  // перезапуск с нарастающей паузой был неотличим от намертво замершего
  // туннеля. Строка в журнале про паузу есть, но она уезжает вниз и не
  // обновляется.
  retryIn: (n: number) => `следующая попытка через ${n} с`,
  turnOn: "Включить",
  turnOff: "Выключить",
  conduitTo: "сеть",
  profile: "Профиль",
  noProfile: "не выбран",
  // Что окажется из набранного — подписью под полем импорта. Это не разбор:
  // решает служба, а подпись убирает загадку «одно поле на три сущности».
  sniffSub: "адрес подписки",
  sniffJson: "JSON узла",
  sniffLink: "ссылка на узел",
  sniffList: (n: number) => `строк: ${n} — импортируются разом`,
  profileFirst: "Профиль не выбран — «Включить» поднимет этот, первый по алфавиту",
  latency: "Задержка",
  exit: "Точка выхода",
  received: "Принято",
  sent: "Отправлено",
  profiles: "Профили",
  importLink: "Импорт",
  // Надписи на время работы. Подписка качается до двадцати секунд, обход
  // реестра идёт секундами, и погасшая кнопка всё это время неотличима от
  // «не нажалось».
  importing: "Импортирую…",
  linkPlaceholder: "share-link, адрес подписки или JSON узла",
  noProfiles: "Профилей нет. Вставьте share-link, адрес подписки или JSON-конфиг — разберётся сам.",
  ownProfiles: "Свои",
  refreshSubscription: (url: string) => `Обновить подписку ${url}`,
  // Остаток по подписке: трафик и срок. До сих пор их не показывали вовсе, и
  // человек узнавал про них в тот момент, когда перестало работать.
  quotaOf: (used: string, total: string) => `${used} из ${total}`,
  quotaUntil: (date: string) => `до ${date}`,
  quotaExpired: "подписка кончилась",
  quotaHint: "Остаток по подписке, как его прислала панель последней сверкой.",
  tabMain: "Главное",
  tabBrowsers: "Браузеры",
  browsers: "Браузеры",
  browserNeedsNode: "Сначала заведите профиль узла — через него и пойдёт окно браузера.",
  browserEmpty:
    "Профилей браузера нет. Заведите первый: имя и узел обязательны, личность можно оставить как есть.",
  browserNew: "Новый профиль",
  browserName: "Имя",
  browserNamePlaceholder: "работа, личное, магазин",
  browserNameHint: "Им же назван каталог с куками и входами этого окна.",
  // Имя — ключ профиля и зерно имени его каталога (`core_ipc::dir_name`),
  // поэтому в правке оно заперто, а при заведении сверяется с занятыми.
  browserNameLocked: "Имя не меняется: по нему назван каталог с куками и входами. Другое имя — это другой профиль, с чистого листа.",
  browserNameTaken: "Профиль с таким именем уже есть — сохранение переписало бы его.",
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
  browserIcon: "Картинка профиля",
  browserIconHint: "Нажмите, чтобы перекатить картинку",
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
  renameSubscription: "Назвать подписку",
  subName: "Имя подписки",
  refreshAll: "Обновить все",
  refreshAllHint: "Сверить все подписки разом — то же, что нажать ⟳ у каждой",
  // Отчёт об импорте. Читается там же, куда вставляли: общая рамка наверху
  // окна о пропущенных строках сказать не может.
  imported: (added: number, kept: number, gone: number) =>
    `Заведено: ${added}` + (kept > 0 ? `, уже было: ${kept}` : "") + (gone > 0 ? `, убрано: ${gone}` : ""),
  skipped: (n: number) => `Пропущено строк: ${n}`,
  fromFile: "Файл",
  fromFileHint: "Взять текст из файла: сохранённый конфиг, выгрузка подписки, список ссылок",
  editProfile: (name: string) => `Изменить «${name}»`,
  editName: "Имя",
  editNode: "Узел",
  editNodeHint:
    "JSON узла sing-box либо share-link — то же, что принимает импорт. Пусто — меняется только имя.",
  editFromSub: "Узел пришёл из подписки: сверка вернёт его прежним. Править можно только свои.",
  save: "Сохранить",
  cancel: "Отмена",
  testOne: "Проверить",
  testOneHint: "Проверить только этот профиль — остальные не трогать",
  testingProgress: (done: number, total: number) => `Прогон ${done}/${total}`,
  fastest: "Включить быстрый",
  fastestHint: "Поднять туннель на профиле с наименьшей измеренной задержкой",
  active: "активен",
  browserOn: "браузер",
  browserOpenState: "открыт",
  browserOnHint: "Через этот узел открыто окно браузера. Закроете окно — сеанс погаснет сам",
  testProfiles: "Прогнать",
  testing: "Прогоняю…",
  byLatency: "По задержке",
  byLatencyHint: "Переставить список по измеренной задержке. Неизмеренные и мёртвые уходят вниз. Порядок живёт только в окне.",
  latencyThroughTunnel: "измерено сквозь поднятый туннель — в числе и его RTT",
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
  // Каталог сеанса занят живым окном браузера, и стереть его нечем: profile
  // уйдёт, а куки останутся лежать. Обещать обратное в средстве приватности
  // нельзя, поэтому вопрос при открытом окне другой.
  confirmRemoveOpen: "Окно открыто — куки останутся. Всё равно убрать?",
  langRu: "Русский",
  langEn: "Английский",
  langFa: "Персидский",
  trafficHint: "За текущее подключение: счётчики начинаются заново с каждым запуском туннеля",
  fateUp: "Идёт через туннель",
  fateClosed: "Без сети: туннель не подтверждён",
  fateDirect: "Идёт напрямую, мимо туннеля",
  // Снятая галочка под замком белого списка — это не «мимо туннеля»:
  // прямого пути в продукте не осталось вовсе, приложению просто не
  // выдан пропуск.
  fateFenced: "Без сети: приложение не выбрано",
  apps: "Приложения",
  appsCount: (on: number, all: number) => `${on} из ${all} в туннеле`,
  discover: "Найти установленные",
  searching: "Ищу…",
  addApp: "Добавить",
  adding: "Добавляю…",
  appPlaceholder: "C:\\Program Files\\…\\app.exe",
  noApps: "Список пуст — ничей трафик не перехватывается.",
  scopeWhitelist: "Белый список",
  scopeHintWhitelist: "Выбранные приложения — через туннель, у остальных сети нет вовсе",
  scopeAll: "Весь компьютер",
  scopeAllNote: "Весь трафик компьютера идёт через туннель — приложения не отбираются, и этот список сейчас не применяется. Охват переключается на шапке окна, у левого конца канала.",
  whatIsCheck: "Что значит галочка",
  whitelistNote: "Галочка даёт приложению сеть, а не заворачивает его в туннель: снятая означает, что приложение останется без интернета вовсе, а не вернётся в открытую сеть.",
  searchApps: "Поиск по имени или пути",
  searchProfiles: "Поиск по имени профиля",
  appsShown: (shown: number) => `найдено ${shown}`,
  noMatches: "Ничего не подошло — попробуйте часть имени или папки.",
  journal: "Журнал",
  emptyJournal: "Пока ничего не происходило.",
  // Журнал читают, когда уже сломалось и надо кому-то показать. До сих пор
  // для этого оставался скриншот.
  copyLog: "Скопировать",
  copied: "Скопировано",
  tabConns: "Соединения",
  conns: "Соединения",
  connsNote: (shown: number, total: number) =>
    shown < total ? `${shown} из ${total} — самые говорливые` : `${total}`,
  connsHint:
    "Что идёт через туннель прямо сейчас. Список спрашивается, пока эта панель открыта, и нигде не сохраняется: ни в журнале, ни на диске, ни тем более наружу.",
  connsOff: "Туннеля нет — и соединений нет.",
  connsEmpty: "Туннель поднят, но по нему пока никто не ходит.",
  connsDirect: "напрямую",
  connsDirectHint:
    "Выбранное приложение ушло не в туннель. Маршрута мимо туннеля в конфиге нет вовсе, так что это поломка, а не задуманный путь.",
  connsAsideHint:
    "Не в туннель — но и не в открытую сеть: маршрута мимо туннеля в конфиге нет. Так выглядит то, что sing-box разобрал сам: отбитый опрос шлюза, перехваченный DNS. По-настоящему ушедшего мимо соединения тут не было бы вовсе — его sing-box не видит.",
  connsNoProcess: "без процесса",
  connsNoProcessHint:
    "Владельца ищет служба по локальному порту соединения. Имени нет, если соединение уже закрылось, порт делят два сокета или это трафик драйвера, службы и DNS.",
  connsEmptyFenced:
    "Невыбранные приложения заперты брандмауэром, и их соединений тут не бывает: пустой список и есть признак того, что отбор работает.",
  rateHint: (peak: string) =>
    `Скорость канала: ↓ принято, ↑ отправлено. Шкала плавающая, пик окна — ${peak}. Считается по счётчикам туннеля прямо в окне и нигде не сохраняется; служба снимает их своим тактом, поэтому и график едет её шагом, а не шагом опроса.`,
  perSecond: "/с",
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
    "«Весь компьютер» — это не «выбрать все приложения»: под туннель попадает и трафик, за которым нет процесса, — служба, драйвер, DNS. Отличается охват только судьбой невыбранных, поэтому переключение не рвёт живые соединения.",
  refreshSubs: "Сверка подписок",
  refreshSubsHint:
    "Служба сама перечитывает подписки и заменяет узлы. Срок в часах считается от последней удачной сверки, а не от запуска службы. Активный узел при этом не гаснет, а пропавший не выключает приватный режим.",
  refreshHoursPlaceholder: "часов",
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
  serviceDownHint: "Start proxybox as administrator — nothing works without the service",
  off: "Private mode is off",
  offHintWhitelist: "While the mode is off, everyone reaches the network — selected or not",
  offNoProfiles: "Add a profile first — there is nothing to turn on yet",
  offHintAll: "The computer reaches the network directly",
  connecting: "Connecting…",
  connectingHintWhitelist: "Until the tunnel is confirmed, nobody has network — selected or not",
  connectingHintAll: "Until the tunnel is confirmed, the computer stays without network",
  up: "Protected",
  upHintWhitelist: (n: number) => `Apps given network: ${n}. Everyone else has none`,
  upHintAll: "All computer traffic goes through the tunnel",
  noAppsLocked: "No app is selected — nobody has network",
  noAppsAhead: "No app is selected — in this scope nobody will have network",
  down: "No tunnel — access is closed",
  downHintWhitelist: "This is by design: without a tunnel the whole computer stays offline",
  downHintAll: "This is by design: without a tunnel the computer stays offline",
  retryIn: (n: number) => `retrying in ${n} s`,
  turnOn: "Turn on",
  turnOff: "Turn off",
  conduitTo: "network",
  profile: "Profile",
  noProfile: "not selected",
  sniffSub: "subscription address",
  sniffJson: "node JSON",
  sniffLink: "node link",
  sniffList: (n: number) => `${n} lines — imported at once`,
  profileFirst: "No profile chosen — Turn on will start this one, first alphabetically",
  latency: "Latency",
  exit: "Exit point",
  received: "Received",
  sent: "Sent",
  profiles: "Profiles",
  importLink: "Import",
  importing: "Importing…",
  linkPlaceholder: "share-link, subscription URL or node JSON",
  noProfiles: "No profiles yet. Paste a share-link, a subscription URL or a JSON config — it parses itself.",
  ownProfiles: "Own",
  refreshSubscription: (url: string) => `Refresh subscription ${url}`,
  quotaOf: (used: string, total: string) => `${used} of ${total}`,
  quotaUntil: (date: string) => `until ${date}`,
  quotaExpired: "subscription has expired",
  quotaHint: "The subscription balance as the panel reported it at the last sync.",
  tabMain: "Main",
  tabBrowsers: "Browsers",
  browsers: "Browsers",
  browserNeedsNode: "Add a node profile first — the browser window goes through it.",
  browserEmpty: "No browser profiles yet. Add the first one: name and node are required, the identity can stay as is.",
  browserNew: "New profile",
  browserName: "Name",
  browserNamePlaceholder: "work, personal, shop",
  browserNameHint: "It also names the folder with this window's cookies and logins.",
  browserNameLocked: "The name cannot change: it names the folder with cookies and logins. A different name is a different profile, from scratch.",
  browserNameTaken: "A profile with this name already exists — saving would overwrite it.",
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
  browserIcon: "Profile picture",
  browserIconHint: "Click to roll a new picture",
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
  renameSubscription: "Name the subscription",
  subName: "Subscription name",
  refreshAll: "Refresh all",
  refreshAllHint: "Re-sync every subscription at once — the same as pressing ⟳ on each",
  imported: (added: number, kept: number, gone: number) =>
    `Added: ${added}` + (kept > 0 ? `, already there: ${kept}` : "") + (gone > 0 ? `, dropped: ${gone}` : ""),
  skipped: (n: number) => `Skipped lines: ${n}`,
  fromFile: "File",
  fromFileHint: "Take the text from a file: a saved config, a subscription dump, a list of links",
  editProfile: (name: string) => `Edit "${name}"`,
  editName: "Name",
  editNode: "Node",
  editNodeHint: "sing-box node JSON or a share-link — the same as import takes. Empty means name only.",
  editFromSub: "The node came from a subscription: a refresh would undo the edit. Only your own are editable.",
  save: "Save",
  cancel: "Cancel",
  testOne: "Test",
  testOneHint: "Check this profile only, leaving the rest alone",
  testingProgress: (done: number, total: number) => `Testing ${done}/${total}`,
  fastest: "Turn on fastest",
  fastestHint: "Bring the tunnel up on the profile with the lowest measured latency",
  active: "active",
  browserOn: "browser",
  browserOpenState: "open",
  browserOnHint: "A browser window is open through this node. Close the window and the session goes down by itself",
  testProfiles: "Test all",
  testing: "Testing…",
  byLatency: "By latency",
  byLatencyHint: "Reorder the list by measured latency. Unmeasured and dead nodes go last. The order lives in this window only.",
  latencyThroughTunnel: "measured through the live tunnel — its RTT is included",
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
  confirmRemoveOpen: "The window is open — cookies will stay. Remove anyway?",
  langRu: "Russian",
  langEn: "English",
  langFa: "Persian",
  trafficHint: "For the current connection: the counters start over with every tunnel start",
  fateUp: "Goes through the tunnel",
  fateClosed: "No network: the tunnel is not confirmed",
  fateDirect: "Goes directly, past the tunnel",
  fateFenced: "No network: the app is not selected",
  apps: "Apps",
  appsCount: (on: number, all: number) => `${on} of ${all} in the tunnel`,
  discover: "Find installed",
  searching: "Searching…",
  addApp: "Add",
  adding: "Adding…",
  appPlaceholder: "C:\\Program Files\\…\\app.exe",
  noApps: "The list is empty — nobody's traffic is intercepted.",
  scopeWhitelist: "Whitelist",
  scopeHintWhitelist: "Selected apps go through the tunnel, everyone else has no network at all",
  scopeAll: "Whole computer",
  scopeAllNote: "All computer traffic goes through the tunnel — nothing is picked per app, so this list is not applied right now. The scope is switched in the window header, at the left end of the conduit.",
  whatIsCheck: "What the checkmark means",
  whitelistNote: "A checkmark gives the app network, it does not route it into the tunnel: unchecked means the app has no internet at all, not that it goes back to the open network.",
  searchApps: "Search by name or path",
  searchProfiles: "Search profiles by name",
  appsShown: (shown: number) => `${shown} found`,
  noMatches: "Nothing matched — try part of the name or folder.",
  journal: "Journal",
  emptyJournal: "Nothing has happened yet.",
  copyLog: "Copy",
  copied: "Copied",
  tabConns: "Connections",
  conns: "Connections",
  connsNote: (shown: number, total: number) =>
    shown < total ? `${shown} of ${total} — the loudest` : `${total}`,
  connsHint:
    "What goes through the tunnel right now. The list is asked for while this panel is open and stored nowhere: not in the journal, not on disk, and certainly not outside.",
  connsOff: "No tunnel — no connections.",
  connsEmpty: "The tunnel is up, but nobody is using it yet.",
  connsDirect: "direct",
  connsDirectHint:
    "A selected app went somewhere other than the tunnel. There is no bypass route in the config at all, so this is a fault, not a designed path.",
  connsAsideHint:
    "Not into the tunnel — but not into the open network either: there is no bypass route in the config. This is what sing-box handled itself: a rejected gateway poll, a hijacked DNS query. A connection that truly went past would not appear here at all — sing-box never sees it.",
  connsNoProcess: "no process",
  connsNoProcessHint:
    "The service finds the owner by the connection's local port. There is no name when the connection has already closed, two sockets share the port, or it is driver, service and DNS traffic.",
  connsEmptyFenced:
    "Apps you did not pick are fenced off by the firewall, and their connections never show up here: an empty list is the sign that the picking works.",
  rateHint: (peak: string) =>
    `Link speed: ↓ received, ↑ sent. The scale floats with the window, peaking at ${peak}. Counted from the tunnel counters right here in the window and stored nowhere; the service samples them at its own pace, so the graph advances at that pace, not at the polling one.`,
  perSecond: "/s",
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
  refreshHoursPlaceholder: "hours",
  refreshSubsHint:
    "The service re-reads the subscriptions on its own and replaces the nodes. The period, in hours, runs from the last successful sync, not from the service start. The active node stays up, and a node that disappeared does not turn private mode off.",
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

const FA: typeof RU = {
  serviceDown: "سرویس پاسخ نمی‌دهد",
  serviceDownHint: "PrivacyGateway را با دسترسی مدیر اجرا کنید — بدون سرویس هیچ‌چیز کار نمی‌کند",
  off: "حالت خصوصی خاموش است",
  offHintWhitelist: "تا وقتی حالت خاموش است، همه به شبکه می‌روند — چه انتخاب‌شده، چه نه",
  offNoProfiles: "نخست یک پروفایل بیفزایید — فعلاً چیزی برای روشن کردن نیست",
  offHintAll: "رایانه مستقیم به شبکه می‌رود",
  connecting: "در حال اتصال…",
  connectingHintWhitelist: "تا تأیید تونل، هیچ‌کس شبکه ندارد — چه انتخاب‌شده، چه نه",
  connectingHintAll: "تا تأیید تونل، رایانه بدون شبکه می‌ماند",
  up: "محافظت‌شده",
  upHintWhitelist: (n: number) => `برنامه‌های دارای شبکه: ${n}. بقیه شبکه ندارند`,
  upHintAll: "همهٔ ترافیک رایانه از تونل می‌گذرد",
  noAppsLocked: "هیچ برنامه‌ای انتخاب نشده — هیچ‌کس شبکه ندارد",
  noAppsAhead: "هیچ برنامه‌ای انتخاب نشده — در این دامنه هیچ‌کس شبکه نخواهد داشت",
  down: "تونلی نیست — دسترسی بسته است",
  downHintWhitelist: "همین‌طور طراحی شده: بدون تونل، همهٔ رایانه بدون شبکه می‌ماند",
  downHintAll: "همین‌طور طراحی شده: بدون تونل، رایانه بدون شبکه می‌ماند",
  retryIn: (n: number) => `تلاش بعدی تا ${n} ثانیه دیگر`,
  turnOn: "روشن کردن",
  turnOff: "خاموش کردن",
  conduitTo: "شبکه",
  profile: "پروفایل",
  noProfile: "انتخاب نشده",
  sniffSub: "نشانی اشتراک",
  sniffJson: "JSON گره",
  sniffLink: "پیوند گره",
  sniffList: (n: number) => `${n} خط — یک‌جا وارد می‌شوند`,
  profileFirst: "پروفایلی انتخاب نشده — «روشن کردن» همین یکی را بالا می‌آورد، نخستین به ترتیب الفبا",
  latency: "تأخیر",
  exit: "نقطهٔ خروج",
  received: "دریافت‌شده",
  sent: "ارسال‌شده",
  profiles: "پروفایل‌ها",
  importLink: "وارد کردن",
  importing: "در حال وارد کردن…",
  linkPlaceholder: "share-link، نشانی اشتراک یا JSON گره",
  noProfiles: "هنوز پروفایلی نیست. یک share-link، نشانی اشتراک یا پیکربندی JSON بچسبانید — خودش تشخیص می‌دهد.",
  ownProfiles: "خودی",
  refreshSubscription: (url: string) => `به‌روزرسانی اشتراک ${url}`,
  quotaOf: (used: string, total: string) => `${used} از ${total}`,
  quotaUntil: (date: string) => `تا ${date}`,
  quotaExpired: "اشتراک به پایان رسید",
  quotaHint: "باقی‌ماندهٔ اشتراک، همان‌طور که پنل در آخرین همگام‌سازی فرستاد.",
  tabMain: "اصلی",
  tabBrowsers: "مرورگرها",
  browsers: "مرورگرها",
  browserNeedsNode: "نخست یک پروفایل گره بسازید — پنجرهٔ مرورگر از همان می‌گذرد.",
  browserEmpty:
    "هنوز پروفایل مرورگری نیست. نخستین را بسازید: نام و گره لازم‌اند، هویت می‌تواند همین‌طور بماند.",
  browserNew: "پروفایل تازه",
  browserName: "نام",
  browserNamePlaceholder: "کار، شخصی، فروشگاه",
  browserNameHint: "پوشهٔ کوکی‌ها و ورودهای این پنجره هم به همین نام است.",
  browserNameLocked: "نام تغییر نمی‌کند: پوشهٔ کوکی‌ها و ورودها به همین نام است. نام دیگر یعنی پروفایل دیگر، از صفر.",
  browserNameTaken: "پروفایلی با این نام از پیش هست — ذخیره آن را بازنویسی می‌کند.",
  browserNode: "گره",
  browserNodePick: "یک گره برگزینید",
  browserNodeHint: "ترافیک پنجره از آن می‌گذرد. حالت عمومی دست نمی‌خورد.",
  browserIdentity: "هویت",
  browserPlatform: "سکو",
  browserPlatformReal: "واقعی — جعل نکن",
  browserPlatformCustom: "رشتهٔ دلخواه",
  browserVersion: "نسخهٔ کروم",
  browserRandom: "تصادفی",
  browserRandomHint: "نسخهٔ تصادفی کروم روی همین سکو",
  browserIcon: "تصویر پروفایل",
  browserIconHint: "برای گرداندن تصویر کلیک کنید",
  browserMismatch: (real: string) =>
    `Sec-CH-UA باز هم می‌گوید «${real}»: سایتی که client hints را می‌خواند، ناهمخوانی با این رشته را می‌بیند.`,
  browserUa: "user-agent — خالی یعنی واقعی",
  browserUaField: "رشتهٔ user-agent",
  browserUaSet: "این رشته به ‎--user-agent و navigator.userAgent می‌رود.",
  browserUaRealNow: (platform: string, major: number) =>
    `چیزی جایگزین نمی‌شود — مرورگر با رشتهٔ خودش می‌رود. اینجا یعنی ${platform}، کروم ${major}.`,
  browserUaHint:
    "سربرگ درخواست و navigator.userAgent را عوض می‌کند. Sec-CH-UA، منطقهٔ زمانی، canvas، WebGL، صفحه و شمار هسته‌ها واقعی می‌مانند و میان همهٔ پروفایل‌های این رایانه مشترک‌اند: این جدا کردن حساب‌هاست، نه ضدشناسایی.",
  browserUaReal: "واقعی",
  browserLang: "زبان",
  browserLangHint: "فهرستی مانند nl-NL,nl,en-US,en — به همان ترتیبی که مرورگر می‌فرستد",
  browserLangAuto: "زبان: بر پایهٔ کشور گره",
  browserLangSystem: "زبان: سیستمی",
  browserLangCustom: "زبان: دلخواه",
  browserLangAutoNow: (country: string, value: string) => `گره اکنون در کشور «${country}» است ← ${value}`,
  browserLangAutoUnknown: (value: string) =>
    `کشور گره هنوز سنجیده نشده — آزمون پروفایل‌ها آن را می‌یابد. تا آن‌گاه ← ${value}`,
  browserCancel: "انصراف",
  browserSave: "ذخیره",
  browserCreate: "ساختن",
  browserOpen: "باز کردن",
  browserOpenHint: (node: string) =>
    `باز کردن پنجرهٔ مرورگر از راه «${node}». پنجره از آنِ خودش است: نشانک‌ها و ورودهای شما در آن پیدا نمی‌شوند و ورودهای خودش تا دفعهٔ بعد می‌مانند. حالت عمومی دست نمی‌خورد.`,
  browserEdit: (name: string) => `ویرایش «${name}»`,
  browserRemove: (name: string) => `برداشتن «${name}» همراه با ورودها و کوکی‌هایش`,
  browserNodeGone: "گره دیگر نیست — برای این پروفایل یکی دیگر برگزینید",
  removeSubscription: (url: string) => `لغو اشتراک ${url}`,
  renameSubscription: "نام‌گذاری اشتراک",
  subName: "نام اشتراک",
  refreshAll: "به‌روزرسانی همه",
  refreshAllHint: "همگام‌سازی همهٔ اشتراک‌ها یک‌جا — همان فشردن ⟳ روی تک‌تک آن‌ها",
  imported: (added: number, kept: number, gone: number) =>
    `افزوده: ${added}` + (kept > 0 ? `، از پیش موجود: ${kept}` : "") + (gone > 0 ? `، برداشته: ${gone}` : ""),
  skipped: (n: number) => `خط‌های نادیده‌گرفته: ${n}`,
  fromFile: "پرونده",
  fromFileHint: "متن را از پرونده بگیر: پیکربندی ذخیره‌شده، برون‌ریز اشتراک، فهرست پیوندها",
  editProfile: (name: string) => `ویرایش «${name}»`,
  editName: "نام",
  editNode: "گره",
  editNodeHint:
    "JSON گره sing-box یا یک share-link — همان چیزی که وارد کردن می‌پذیرد. خالی یعنی فقط نام عوض می‌شود.",
  editFromSub: "گره از اشتراک آمده است: همگام‌سازی ویرایش را برمی‌گرداند. تنها گره‌های خودی ویرایش‌پذیرند.",
  save: "ذخیره",
  cancel: "انصراف",
  testOne: "بررسی",
  testOneHint: "تنها همین پروفایل را بررسی کن، بقیه دست نخورند",
  testingProgress: (done: number, total: number) => `آزمون ${done}/${total}`,
  fastest: "روشن کردن سریع‌ترین",
  fastestHint: "بالا آوردن تونل روی پروفایلی که کمترین تأخیر سنجیده‌شده را دارد",
  active: "فعال",
  browserOn: "مرورگر",
  browserOpenState: "باز",
  browserOnHint: "از این گره پنجرهٔ مرورگری باز است. پنجره را ببندید و نشست خودش خاموش می‌شود",
  testProfiles: "آزمودن",
  testing: "در حال آزمودن…",
  byLatency: "بر پایهٔ تأخیر",
  byLatencyHint: "چیدن دوبارهٔ فهرست بر پایهٔ تأخیر سنجیده‌شده. نسنجیده‌ها و مرده‌ها به پایین می‌روند. این ترتیب فقط در همین پنجره زنده است.",
  latencyThroughTunnel: "از راه تونلِ بالا سنجیده شده — RTT خودش هم در عدد هست",
  testProfilesHint: "آزمودن هر پروفایل با اتصالی جداگانه، بی‌آنکه اتصال کنونی دست بخورد",
  probeFailed: "پاسخ نمی‌دهد",
  measured: (ago: string) => `سنجیده‌شده ${ago}`,
  logged: (ago: string) => `ثبت‌شده ${ago}`,
  yesterday: "دیروز",
  synced: (ago: string) => `همگام‌شده ${ago}`,
  neverSynced: "هرگز همگام نشده",
  agoNow: "همین حالا",
  agoMin: (n: number) => `${n} دقیقه پیش`,
  agoHour: (n: number) => `${n} ساعت پیش`,
  agoDay: (n: number) => `${n} روز پیش`,
  remove: "حذف",
  confirmRemove: "حذف شود؟",
  confirmRemoveOpen: "پنجره باز است — کوکی‌ها می‌مانند. باز هم برداشته شود؟",
  langRu: "روسی",
  langEn: "انگلیسی",
  langFa: "فارسی",
  trafficHint: "برای اتصال کنونی: شمارنده‌ها با هر بار بالا آمدن تونل از نو آغاز می‌شوند",
  fateUp: "از تونل می‌گذرد",
  fateClosed: "بدون شبکه: تونل تأیید نشده",
  fateDirect: "مستقیم می‌رود، بیرون از تونل",
  fateFenced: "بدون شبکه: برنامه انتخاب نشده",
  apps: "برنامه‌ها",
  appsCount: (on: number, all: number) => `${on} از ${all} در تونل`,
  discover: "یافتن نصب‌شده‌ها",
  searching: "در حال جست‌وجو…",
  addApp: "افزودن",
  adding: "در حال افزودن…",
  appPlaceholder: "C:\\Program Files\\…\\app.exe",
  noApps: "فهرست خالی است — ترافیک هیچ‌کس گرفته نمی‌شود.",
  scopeWhitelist: "فهرست سفید",
  scopeHintWhitelist: "برنامه‌های انتخاب‌شده از تونل می‌گذرند، بقیه اصلاً شبکه ندارند",
  scopeAll: "همهٔ رایانه",
  scopeAllNote: "همهٔ ترافیک رایانه از تونل می‌گذرد — برنامه‌ها گزینش نمی‌شوند و این فهرست هم‌اکنون اعمال نمی‌شود. دامنه در سربرگ پنجره، کنار سر چپ کانال، جابه‌جا می‌شود.",
  whatIsCheck: "تیک یعنی چه",
  whitelistNote: "تیک به برنامه شبکه می‌دهد، نه اینکه آن را به تونل ببرد: نبودِ تیک یعنی برنامه اصلاً اینترنت ندارد، نه اینکه به شبکهٔ باز برگردد.",
  searchApps: "جست‌وجو بر پایهٔ نام یا مسیر",
  searchProfiles: "جست‌وجوی پروفایل بر پایهٔ نام",
  appsShown: (shown: number) => `${shown} یافت شد`,
  noMatches: "چیزی جور در نیامد — بخشی از نام یا پوشه را بیازمایید.",
  journal: "دفتر رویدادها",
  emptyJournal: "هنوز چیزی رخ نداده است.",
  copyLog: "رونوشت",
  copied: "رونوشت شد",
  tabConns: "اتصال‌ها",
  conns: "اتصال‌ها",
  connsNote: (shown: number, total: number) =>
    shown < total ? `${shown} از ${total} — پرگوترین‌ها` : `${total}`,
  connsHint:
    "هم‌اکنون چه چیزی از تونل می‌گذرد. فهرست تا وقتی این پنجره باز است پرسیده می‌شود و هیچ‌جا ذخیره نمی‌شود: نه در دفتر رویدادها، نه روی دیسک و به‌هیچ‌روی بیرون.",
  connsOff: "تونلی نیست — اتصالی هم نیست.",
  connsEmpty: "تونل بالاست، اما هنوز کسی از آن نمی‌گذرد.",
  connsDirect: "مستقیم",
  connsDirectHint:
    "برنامهٔ انتخاب‌شده جایی جز تونل رفته است. در پیکربندی هیچ مسیر دورزننده‌ای نیست، پس این خرابی است، نه راهی که خواسته شده باشد.",
  connsAsideHint:
    "نه به تونل — اما نه به شبکهٔ باز هم: در پیکربندی مسیر دورزننده نیست. این همان چیزی است که sing-box خودش سروسامان داده: پرس‌وجوی ردشدهٔ دروازه، DNS ربوده‌شده. اتصالی که واقعاً بیرون رفته باشد اصلاً اینجا دیده نمی‌شود — sing-box آن را نمی‌بیند.",
  connsNoProcess: "بدون فرایند",
  connsNoProcessHint:
    "سرویس صاحب اتصال را از روی درگاه محلی آن می‌یابد. وقتی اتصال بسته شده باشد، دو سوکت درگاه را شریک باشند یا ترافیک از آنِ درایور، سرویس و DNS باشد، نامی در کار نیست.",
  connsEmptyFenced:
    "برنامه‌های انتخاب‌نشده را دیوارهٔ آتش بسته است و اتصال‌هایشان هرگز اینجا پیدا نمی‌شود: فهرست خالی خودْ نشانهٔ کار کردن گزینش است.",
  rateHint: (peak: string) =>
    `سرعت کانال: ↓ دریافت، ↑ ارسال. مقیاس شناور است و اوج پنجره ${peak} است. از شمارنده‌های تونل همین‌جا در پنجره حساب می‌شود و هیچ‌جا ذخیره نمی‌شود؛ سرویس آن‌ها را با ضرب‌آهنگ خودش برمی‌دارد، پس نمودار هم با همان گام پیش می‌رود، نه با گام پرس‌وجو.`,
  perSecond: "/ث",
  hideMessage: "پنهان کردن پیام",
  minimizeWindow: "کوچک کردن پنجره",
  maximizeWindow: "بزرگ کردن پنجره",
  restoreWindow: "بازگرداندن پنجره",
  closeWindow: "بستن پنجره",
  removeProfile: (name: string) => `حذف پروفایل ${name}`,
  removeApp: (name: string) => `برداشتن ${name}`,
  switchOn: "روشن",
  switchOff: "خاموش",
  apply: "اعمال",
  scope: "دامنه",
  scopeHint:
    "«همهٔ رایانه» یعنی «همهٔ برنامه‌ها را انتخاب کن» نیست: ترافیکی که فرایندی پشتش نیست — سرویس، درایور، DNS — هم به تونل می‌رود. تفاوت دو دامنه فقط در سرنوشت انتخاب‌نشده‌هاست، برای همین جابه‌جایی، اتصال‌های زنده را پاره نمی‌کند.",
  refreshSubs: "همگام‌سازی اشتراک‌ها",
  refreshSubsHint:
    "سرویس هر شش ساعت اشتراک‌ها را دوباره می‌خواند و گره‌ها را جایگزین می‌کند. مهلت از آخرین همگام‌سازی شمرده می‌شود، نه از راه‌اندازی سرویس. گره فعال در این میان خاموش نمی‌شود و گرهی که ناپدید شود حالت خصوصی را خاموش نمی‌کند.",
  refreshHoursPlaceholder: "ساعت",
  geoTitle: "پرسیدن کشور",
  geoHint:
    "تنها درخواست سرویس به بیرون: کشور گره از سرویسی بیرونی پرسیده می‌شود — و تنها از راه تونل؛ از نشانی واقعی شما درخواستی بیرون نمی‌رود. خاموشش کنید و کشوری در پنجره نخواهد بود.",
  probeTitle: "هدف آزمون",
  probeHint:
    "کجا در بزنیم تا تونل بالا شمرده شود. خالی — سرور خود گره: محصول به‌طور پیش‌فرض به نشانی بیگانه دست نمی‌زند.",
  probePlaceholder: "host:port — خالی یعنی سرور گره",
  singboxTitle: "مسیر sing-box",
  singboxHint:
    "خالی — کنار سرویس، وگرنه از PATH. مسیر تازه از راه‌اندازی بعدی تونل کار می‌کند: تونل زنده برای یک تنظیم خاموش نمی‌شود.",
  singboxPlaceholder: "C:\\Program Files\\sing-box\\sing-box.exe",
  autostartTitle: "اجرا همراه ویندوز",
  autostartHint:
    "پنجره همراه سیستم بالا می‌آید و یک‌راست به سینی می‌رود. به سرویس ربطی ندارد: او در SCM است و تونل را بی‌هیچ پنجره‌ای بالا می‌آورد — اجرای خودکار برای نشان سینی است، وگرنه از رایانهٔ قفل‌شده هیچ ردی در رابط نمی‌ماند.",
  autostartWindowsOnly: "فقط در ویندوز",
  envOverride: "با متغیر محیطی بازنویسی شده — سرویس در دفتر رویدادها گفته است",
  exitUnknown: "نقطهٔ خروج تا وقتی تونل بالاست دانسته می‌شود",
  closeTitle: "پنجره بسته شود؟",
  closeHint:
    "سرویس تونل و قواعد دیوارهٔ آتش را بی‌هیچ پنجره‌ای نگه می‌دارد: این پنجره است که بسته می‌شود، نه محصول.",
  closeWarn:
    "اگر یکسره ببندید، نشانی در سینی نمی‌ماند، اما تونل و قواعد می‌مانند. آن‌گاه پنجره را تنها با میان‌بُر می‌توان بازگرداند.",
  closeToTray: "بردن به سینی",
  closeQuit: "بستن کامل",
  closeRemember: "دیگر نپرس",
  settings: "تنظیمات",
  settingsHint: "تنظیمات: زبان، به‌روزرسانی‌ها",
  done: "انجام شد",
  language: "زبان",
  languageHint:
    "زبان را سرویس نگه می‌دارد: پیام‌های دفتر رویدادها را او می‌نویسد، و جدا کردن آن‌ها از رابط بی‌معناست.",
  versionAndUpdates: "نسخه و به‌روزرسانی‌ها",
  updatesHint: "پنجره تنها با فشردن دکمه سراغ به‌روزرسانی می‌رود.",
  updateTo: (tag: string) => `به‌روزرسانی به ${tag}`,
  version: "نسخه",
  checkUpdates: "بررسی به‌روزرسانی",
  checking: "در حال پرسیدن از GitHub…",
  upToDate: "این آخرین نسخه است",
  updateAvailable: (tag: string) => `${tag} بیرون آمد`,
  download: "دانلود",
  allReleases: (n: number) => `همهٔ انتشارها (${n})`,
};

export type Strings = typeof RU;

const DICT: Record<Lang, Strings> = { ru: RU, en: EN, fa: FA };

export function strings(lang: Lang | undefined): Strings {
  return (lang && DICT[lang]) ?? RU;
}

/** Направление письма. Персидский — единственный язык справа налево, но
 *  спрашивают его в двух местах, поэтому ответ один и живёт здесь. */
export function dir(lang: Lang | undefined): "rtl" | "ltr" {
  return lang && RTL.includes(lang) ? "rtl" : "ltr";
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
