//! Headless-клиент службы. Тот же контракт, что у GUI, — core-ipc.

// Разбор вывода утилит Windows на других платформах не вызывается, но тестами
// покрыт — на Windows dead_code остаётся включённым.
#[cfg_attr(not(windows), allow(dead_code))]
mod doctor;

use core_ipc::{call, t, tf, Request, Response, Scope};

const USAGE_RU: &str = "proxybox <команда>

  status                 состояние туннеля и список приложений
  doctor                 проверка окружения: почему может не работать
  on --profile <имя>     включить приватный режим
  off                    выключить приватный режим
  list-apps              приложения под управлением
  discover               найти установленные приложения и добавить выключенными
  add-app --path <exe>   добавить приложение по пути к .exe
  enable --path <exe>    пустить приложение в туннель
  disable --path <exe>   убрать приложение из-под управления
  scope whitelist|all    охват: сеть только выбранным приложениям и только
                         через туннель; либо весь трафик машины в туннель
  add-profile --link <l> импортировать share-link (vless/vmess/trojan/ss/hy2/tuic/wg),
                         JSON-конфиг sing-box или подписку по https-адресу;
                         тот же адрес повторно — обновить подписку
  profiles               список профилей: имя, тип узла и куда он ведёт
  test [--profile <имя>] прогнать профили: кто отвечает и за сколько.
                         Без --profile — все, а это секунды на каждый
  conns                  живые соединения туннеля: кто, куда, каким маршрутом.
                         Ничего не сохраняется — список собирается на запрос
  browsers               список браузерных профилей
  add-browser --name <имя> --node <профиль> [--ua <строка>] [--lang <языки>]
                         завести браузерный профиль либо переписать такой же:
                         узел даёт адрес, ua и lang — то, что видит сайт
  remove-browser --name <имя>    убрать браузерный профиль
  browse --profile <имя> поднять прокси под браузерный профиль и напечатать его
                         адрес: браузер с --proxy-server пойдёт в него; сеансов
                         бывает несколько, по одному на браузерный профиль
  browse --stop --profile <имя>  погасить этот сеанс браузера
  lang <код>             язык сообщений службы и окна: ru, en, fa, zh, tr, id
  settings               настройки службы: что действует прямо сейчас
  settings [--refresh on|off] [--geo on|off] [--probe host:port]
           [--singbox <путь>]
                         сверка подписок, запрос страны у внешнего сервиса,
                         цель пробы (пусто — сервер самого узла) и путь к
                         sing-box. Переменные окружения сильнее настроек";

const USAGE_EN: &str = "proxybox <command>

  status                 tunnel state and app list
  doctor                 environment check: why it may not work
  on --profile <name>    turn private mode on
  off                    turn private mode off
  list-apps              apps under control
  discover               find installed apps and add them disabled
  add-app --path <exe>   add an app by path to its .exe
  enable --path <exe>    let the app into the tunnel
  disable --path <exe>   take the app out of control
  scope whitelist|all    scope: network for selected apps only and only
                         through the tunnel; or all machine traffic
  add-profile --link <l> import a share-link (vless/vmess/trojan/ss/hy2/tuic/wg),
                         a sing-box JSON config or a subscription https URL;
                         the same URL again refreshes the subscription
  profiles               list profiles: name, node type and where it points
  test [--profile <name>] run profiles: who answers and how fast.
                         Without --profile — all of them, seconds each
  conns                  live tunnel connections: who, where, which route.
                         Nothing is stored — the list is built per request
  browsers               list browser profiles
  add-browser --name <name> --node <profile> [--ua <string>] [--lang <langs>]
                         create or overwrite a browser profile: the node gives
                         the address, ua and lang are what the site sees
  remove-browser --name <name>   drop a browser profile
  browse --profile <name> bring up a proxy for that browser profile and print
                         its address: a browser with --proxy-server goes there;
                         sessions are per browser profile, several at once
  browse --stop --profile <name>  close that browser session
  lang <code>            language of service and window messages: ru, en, fa, zh, tr, id
  settings               service settings: what is in force right now
  settings [--refresh on|off] [--geo on|off] [--probe host:port]
           [--singbox <path>]
                         subscription refresh, exit-country lookup, probe target
                         (empty — the node's own server) and the sing-box path.
                         Environment variables win over settings";

const USAGE_FA: &str = "proxybox <فرمان>

  status                 وضعیت تونل و فهرست برنامه‌ها
  doctor                 بررسی محیط: چرا ممکن است کار نکند
  on --profile <نام>     روشن کردن حالت خصوصی
  off                    خاموش کردن حالت خصوصی
  list-apps              برنامه‌های زیر کنترل
  discover               یافتن برنامه‌های نصب‌شده و افزودن آن‌ها به‌صورت خاموش
  add-app --path <exe>   افزودن برنامه با مسیر فایل .exe
  enable --path <exe>    راه دادن برنامه به تونل
  disable --path <exe>   بیرون بردن برنامه از کنترل
  scope whitelist|all    دامنه: شبکه فقط برای برنامه‌های انتخاب‌شده و فقط از
                         راه تونل؛ یا همهٔ ترافیک رایانه در تونل
  add-profile --link <l> وارد کردن share-link (vless/vmess/trojan/ss/hy2/tuic/wg)،
                         پیکربندی JSON سینگ‌باکس یا اشتراک با نشانی https؛
                         همان نشانی برای بار دوم — به‌روزرسانی اشتراک
  profiles               فهرست پروفایل‌ها: نام، نوع گره و مقصد آن
  test [--profile <نام>] آزمودن پروفایل‌ها: کدام پاسخ می‌دهد و در چه زمانی.
                         بدون --profile — همه، و هر کدام چند ثانیه
  conns                  اتصال‌های زندهٔ تونل: که، به کجا، از کدام مسیر.
                         چیزی ذخیره نمی‌شود — فهرست برای هر درخواست ساخته می‌شود
  browsers               فهرست پروفایل‌های مرورگر
  add-browser --name <نام> --node <پروفایل> [--ua <رشته>] [--lang <زبان‌ها>]
                         ساختن پروفایل مرورگر یا بازنویسی همان: گره نشانی را
                         می‌دهد، ua و lang همان چیزی است که سایت می‌بیند
  remove-browser --name <نام>    برداشتن پروفایل مرورگر
  browse --profile <نام> بالا آوردن پراکسی برای پروفایل مرورگر و چاپ نشانی آن:
                         مرورگر با --proxy-server به آن می‌رود؛ نشست‌ها چندتایی
                         هستند، یکی برای هر پروفایل مرورگر
  browse --stop --profile <نام>  بستن این نشست مرورگر
  lang <کد>              زبان پیام‌های سرویس و پنجره: ru, en, fa, zh, tr, id
  settings               تنظیمات سرویس: هم‌اکنون چه چیزی برقرار است
  settings [--refresh on|off] [--geo on|off] [--probe host:port]
           [--singbox <مسیر>]
                         به‌روزرسانی اشتراک‌ها، پرسیدن کشور از سرویس بیرونی،
                         هدف آزمون (خالی — سرور خود گره) و مسیر sing-box.
                         متغیرهای محیطی بر تنظیمات چیره‌اند";

const USAGE_ZH: &str = "proxybox <命令>

  status                 隧道状态与应用列表
  doctor                 环境检查：为什么可能无法工作
  on --profile <名称>    开启隐私模式
  off                    关闭隐私模式
  list-apps              受管理的应用
  discover               查找已安装的应用并以关闭状态加入
  add-app --path <exe>   按 .exe 路径添加应用
  enable --path <exe>    放行应用进入隧道
  disable --path <exe>   将应用移出管理
  scope whitelist|all    范围：仅所选应用联网且只能走隧道；
                         或整机流量进入隧道
  add-profile --link <l> 导入 share-link（vless/vmess/trojan/ss/hy2/tuic/wg）、
                         sing-box 的 JSON 配置，或 https 订阅地址；
                         同一地址再来一次即更新订阅
  profiles               配置列表：名称、节点类型及去向
  test [--profile <名称>] 检测配置：谁有响应、用时多少。
                         不带 --profile 即全部，每个都要几秒
  conns                  隧道的活动连接：谁、去哪、走哪条路。
                         不做保存 — 列表按请求现场生成
  browsers               浏览器配置列表
  add-browser --name <名称> --node <配置> [--ua <字符串>] [--lang <语言>]
                         新建或覆盖浏览器配置：节点给出地址，
                         ua 与 lang 是网站看到的内容
  remove-browser --name <名称>   移除浏览器配置
  browse --profile <名称> 为该浏览器配置启动代理并打印地址：
                         带 --proxy-server 的浏览器会走它；会话可有多个，
                         每个浏览器配置一个
  browse --stop --profile <名称>  关闭该浏览器会话
  lang <代码>            服务与窗口消息的语言：ru, en, fa, zh, tr, id
  settings               服务设置：此刻实际生效的内容
  settings [--refresh on|off] [--geo on|off] [--probe host:port]
           [--singbox <路径>]
                         订阅同步、向外部服务查询国家、探测目标
                         （留空即节点自身的服务器）以及 sing-box 路径。
                         环境变量优先于设置";

const USAGE_TR: &str = "proxybox <komut>

  status                 tünel durumu ve uygulama listesi
  doctor                 ortam denetimi: neden çalışmıyor olabilir
  on --profile <ad>      gizli kipi aç
  off                    gizli kipi kapat
  list-apps              yönetim altındaki uygulamalar
  discover               kurulu uygulamaları bul ve kapalı olarak ekle
  add-app --path <exe>   uygulamayı .exe yoluyla ekle
  enable --path <exe>    uygulamayı tünele al
  disable --path <exe>   uygulamayı yönetimden çıkar
  scope whitelist|all    kapsam: ağ yalnızca seçili uygulamalara ve yalnızca
                         tünel üzerinden; ya da makinenin tüm trafiği tünele
  add-profile --link <l> share-link (vless/vmess/trojan/ss/hy2/tuic/wg),
                         sing-box JSON yapılandırması ya da https abonelik
                         adresi içe aktar; aynı adres yeniden — aboneliği tazeler
  profiles               profil listesi: ad, düğüm türü ve nereye gittiği
  test [--profile <ad>]  profilleri dene: kim yanıt veriyor, ne kadar sürede.
                         --profile olmadan hepsi, her biri saniyeler sürer
  conns                  tünelin canlı bağlantıları: kim, nereye, hangi rotayla.
                         Hiçbir şey saklanmaz — liste istek başına toplanır
  browsers               tarayıcı profilleri listesi
  add-browser --name <ad> --node <profil> [--ua <metin>] [--lang <diller>]
                         tarayıcı profili oluştur ya da aynısını üzerine yaz:
                         düğüm adresi verir, ua ve lang sitenin gördüğüdür
  remove-browser --name <ad>     tarayıcı profilini kaldır
  browse --profile <ad>  bu tarayıcı profili için vekil aç ve adresini yazdır:
                         --proxy-server ile açılan tarayıcı oraya gider;
                         oturumlar tarayıcı profili başına, birkaç tane olabilir
  browse --stop --profile <ad>   bu tarayıcı oturumunu kapat
  lang <kod>             hizmet ve pencere iletilerinin dili: ru, en, fa, zh, tr, id
  settings               hizmet ayarları: şu anda neyin geçerli olduğu
  settings [--refresh on|off] [--geo on|off] [--probe host:port]
           [--singbox <yol>]
                         abonelik eşitlemesi, dış hizmetten çıkış ülkesi sorgusu,
                         ölçüm hedefi (boş — düğümün kendi sunucusu) ve sing-box
                         yolu. Ortam değişkenleri ayarlara üstün gelir";

const USAGE_ID: &str = "proxybox <perintah>

  status                 status terowongan dan daftar aplikasi
  doctor                 pemeriksaan lingkungan: mengapa mungkin tidak jalan
  on --profile <nama>    nyalakan mode privat
  off                    matikan mode privat
  list-apps              aplikasi yang dikelola
  discover               cari aplikasi terpasang dan tambahkan dalam keadaan mati
  add-app --path <exe>   tambahkan aplikasi lewat jalur .exe
  enable --path <exe>    izinkan aplikasi masuk terowongan
  disable --path <exe>   keluarkan aplikasi dari pengelolaan
  scope whitelist|all    cakupan: jaringan hanya untuk aplikasi terpilih dan
                         hanya lewat terowongan; atau seluruh lalu lintas mesin
  add-profile --link <l> impor share-link (vless/vmess/trojan/ss/hy2/tuic/wg),
                         konfigurasi JSON sing-box, atau alamat langganan https;
                         alamat yang sama sekali lagi — menyegarkan langganan
  profiles               daftar profil: nama, jenis node, dan tujuannya
  test [--profile <nama>] uji profil: siapa yang menjawab dan seberapa cepat.
                         Tanpa --profile berarti semua, tiap satu makan detik
  conns                  koneksi hidup terowongan: siapa, ke mana, lewat rute apa.
                         Tidak ada yang disimpan — daftar dirakit per permintaan
  browsers               daftar profil peramban
  add-browser --name <nama> --node <profil> [--ua <teks>] [--lang <bahasa>]
                         buat profil peramban atau timpa yang sama: node memberi
                         alamat, ua dan lang adalah yang dilihat situs
  remove-browser --name <nama>   hapus profil peramban
  browse --profile <nama> jalankan proksi untuk profil peramban itu dan cetak
                         alamatnya: peramban dengan --proxy-server menuju ke sana;
                         sesi bisa beberapa, satu per profil peramban
  browse --stop --profile <nama> tutup sesi peramban itu
  lang <kode>            bahasa pesan layanan dan jendela: ru, en, fa, zh, tr, id
  settings               pengaturan layanan: apa yang berlaku sekarang
  settings [--refresh on|off] [--geo on|off] [--probe host:port]
           [--singbox <jalur>]
                         penyelarasan langganan, permintaan negara ke layanan
                         luar, sasaran uji (kosong — server node itu sendiri) dan
                         jalur sing-box. Variabel lingkungan mengalahkan pengaturan";

/// Экран помощи — не строка, а вёрстка: колонка команд, колонка пояснений.
/// Ключом в словаре он был бы сорокастрочным литералом, поэтому лежит
/// константами, а `match` без запасной ветки требует написать его на новом
/// языке осознанно — забыть здесь молча нельзя.
///
/// В консоли с фарси колонки поедут: команды латиницей идут слева направо,
/// пояснения — справа налево, и раскладывает это терминал, а не мы.
fn usage() -> String {
    match core_ipc::lang() {
        core_ipc::Lang::Ru => USAGE_RU,
        core_ipc::Lang::En => USAGE_EN,
        core_ipc::Lang::Fa => USAGE_FA,
        core_ipc::Lang::Zh => USAGE_ZH,
        core_ipc::Lang::Tr => USAGE_TR,
        core_ipc::Lang::Id => USAGE_ID,
    }
    .to_string()
}

/// Байты человеку, ровно как в окне: `12.4 MB` вместо тринадцати цифр подряд.
/// Скрипту сырое число тут и не нужно — оно приходит к нему прямо из core-ipc.
fn bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    match i {
        0 => format!("{n} B"),
        // Десятая доля читается только у малых чисел: «1023.9 MB» — это шум.
        _ if v < 10.0 => format!("{v:.1} {}", UNITS[i]),
        _ => format!("{} {}", v.round(), UNITS[i]),
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).cloned()
}

/// `on`/`off` у флага-тумблера. Молча принимать что угодно нельзя: `--geo 0`
/// выглядит как выключение, а означало бы «включить».
fn onoff(args: &[String], name: &str) -> Result<Option<bool>, String> {
    match flag(args, name).as_deref() {
        None => Ok(None),
        Some("on") => Ok(Some(true)),
        Some("off") => Ok(Some(false)),
        Some(v) => Err(tf!("{}: нужно on или off, а не «{}»", name, v)),
    }
}

/// Настройки служба принимает набором целиком, а команда меняет только
/// названные поля — отсюда предварительный запрос статуса. Единственная
/// команда CLI с двумя запросами, поэтому она и стоит отдельно от `parse`,
/// который в сеть не ходит вовсе.
///
/// Правка идёт поверх действующих значений, а не сохранённых: других у клиента
/// нет. Значит, `settings --geo off` под выставленной `PG_PROBE` запишет её
/// цель на диск. Переменные ставят в разработке и в e2e, и служба про
/// перебивку говорит в журнале при старте.
fn patch_settings(args: &[String]) -> Result<Request, String> {
    let Ok(Response::Status(status)) = call(&Request::Status) else {
        return Err(t("служба недоступна: настройки хранит она"));
    };
    let mut settings = status.settings;
    if let Some(v) = onoff(args, "--refresh")? {
        settings.refresh = v;
    }
    if let Some(v) = onoff(args, "--geo")? {
        settings.geo = v;
    }
    if let Some(v) = flag(args, "--probe") {
        settings.probe = v;
    }
    if let Some(v) = flag(args, "--singbox") {
        settings.singbox = v;
    }
    Ok(Request::SetSettings { settings })
}

fn parse(args: &[String]) -> Result<Request, String> {
    match args.first().map(String::as_str) {
        Some("status") => Ok(Request::Status),
        Some("off") => Ok(Request::Off),
        Some("list-apps") => Ok(Request::ListApps),
        // Своё окружение CLI знает сам: он работает от имени человека.
        Some("discover") => Ok(Request::Discover { env: core_ipc::whoami() }),
        Some("on") => flag(args, "--profile")
            .map(|profile| Request::On { profile })
            .ok_or_else(|| t("нужен --profile <имя>")),
        Some("add-app") => flag(args, "--path")
            .map(|path| Request::AddApp { path })
            .ok_or_else(|| t("нужен --path <путь к .exe>")),
        Some(cmd @ ("enable" | "disable")) => flag(args, "--path")
            .map(|path| Request::SetApp { path, enabled: cmd == "enable" })
            .ok_or_else(|| t("нужен --path <путь к .exe>")),
        Some("add-profile") => flag(args, "--link")
            .map(|link| Request::AddProfile { link })
            .ok_or_else(|| t("нужен --link <share-link>")),
        Some("scope") => match args.get(1).map(String::as_str) {
            Some("all") => Ok(Request::SetScope { scope: Scope::All }),
            Some("whitelist") => Ok(Request::SetScope { scope: Scope::Whitelist }),
            // `none` в экране помощи не значится намеренно: он диагностический,
            // как `PG_STACK` и `PG_PPROF`, и человеку выбирать в нём нечего.
            // Описан в README, рядом с остальной диагностикой.
            Some("none") => Ok(Request::SetScope { scope: Scope::None }),
            _ => Err(t("нужен охват: whitelist или all")),
        },
        Some("profiles") => Ok(Request::Status),
        Some("settings") => Ok(Request::Status),
        Some("test") => Ok(Request::TestProfiles { only: flag(args, "--profile") }),
        Some("conns") => Ok(Request::Connections),
        Some("browse") => flag(args, "--profile")
            .map(|profile| match args.iter().any(|a| a == "--stop") {
                true => Request::BrowseStop { profile },
                false => Request::Browse { profile },
            })
            .ok_or_else(|| t("нужен --profile <имя>")),
        Some("browsers") => Ok(Request::Status),
        Some("add-browser") => match (flag(args, "--name"), flag(args, "--node")) {
            (Some(name), Some(node)) => Ok(Request::SetBrowserProfile {
                profile: core_ipc::BrowserProfile {
                    name,
                    node,
                    ua: flag(args, "--ua").unwrap_or_default(),
                    lang: flag(args, "--lang").unwrap_or_default(),
                    // Зерно аватарки в консоли не спрашиваем: перекатывают её
                    // мышью, а пустое означает «по имени».
                    icon: String::new(),
                },
            }),
            _ => Err(t("нужны --name <имя> и --node <профиль>")),
        },
        Some("remove-browser") => flag(args, "--name")
            .map(|name| Request::RemoveBrowserProfile { name })
            .ok_or_else(|| t("нужно --name <имя>")),
        Some("lang") => match args.get(1).map(String::as_str) {
            Some("ru") => Ok(Request::SetLang { lang: core_ipc::Lang::Ru }),
            Some("en") => Ok(Request::SetLang { lang: core_ipc::Lang::En }),
            Some("fa") => Ok(Request::SetLang { lang: core_ipc::Lang::Fa }),
            Some("zh") => Ok(Request::SetLang { lang: core_ipc::Lang::Zh }),
            Some("tr") => Ok(Request::SetLang { lang: core_ipc::Lang::Tr }),
            Some("id") => Ok(Request::SetLang { lang: core_ipc::Lang::Id }),
            _ => Err(t("нужен язык: ru, en, fa, zh, tr или id")),
        },
        _ => Err(usage()),
    }
}

/// Консоль Windows живёт в кодовой странице 866/1251, и русский вывод в ней
/// превращается в мусор. Переключаем на UTF-8 — kernel32 линкуется всегда,
/// ради одного вызова тянуть крейт незачем.
#[cfg(windows)]
fn utf8_console() {
    extern "system" {
        fn SetConsoleOutputCP(code_page: u32) -> i32;
    }
    unsafe { SetConsoleOutputCP(65001) };
}

#[cfg(not(windows))]
fn utf8_console() {}

/// Язык службы — источник истины для всего, что она прислала. Явный PG_LANG
/// сильнее: его выставил пользователь именно для этого запуска.
fn adopt(lang: core_ipc::Lang) {
    if std::env::var_os("PG_LANG").is_none() {
        core_ipc::set_lang(lang);
    }
}

fn main() -> std::process::ExitCode {
    utf8_console();
    // Язык клиента: сначала из окружения — статус придёт позже и уточнит его.
    core_ipc::set_lang(core_ipc::lang_from_env());
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Справка идёт в stdout и с нулевым кодом: `--help`, отвечающий как отказ,
    // ломает любой скрипт, который его вызвал осознанно. Без аргументов вовсе —
    // это как раз ошибка, и та же справка уходит в stderr ниже.
    if args.first().is_some_and(|a| matches!(a.as_str(), "help" | "--help" | "-h" | "/?")) {
        println!("{}", usage());
        return std::process::ExitCode::SUCCESS;
    }
    // Единственная команда мимо службы: она нужна как раз когда служба молчит.
    if args.first().is_some_and(|a| a == "doctor") {
        return match doctor::report(&doctor::run()) {
            true => std::process::ExitCode::SUCCESS,
            false => std::process::ExitCode::FAILURE,
        };
    }
    let parsed = match args.first().map(String::as_str) {
        // С флагами настройки правятся поверх нынешних, и для этого нужен
        // предварительный запрос; без флагов это обычный `status`, который их и
        // печатает.
        Some("settings") if args.len() > 1 => patch_settings(&args),
        _ => parse(&args),
    };
    let req = match parsed {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return std::process::ExitCode::FAILURE;
        }
    };
    match call(&req) {
        Err(e) => {
            eprintln!("{}", tf!("служба недоступна ({}): запустите pg-service", e));
            std::process::ExitCode::FAILURE
        }
        Ok(Response::Error { message }) => {
            eprintln!("{message}");
            std::process::ExitCode::FAILURE
        }
        // Иконок CLI не спрашивает — печатать в терминал нечего. Узел целиком
        // (`ProfileNode`) спрашивает только форма правки в окне: править JSON в
        // одну строку аргумента незачем, когда рядом есть `add-profile`.
        Ok(Response::Done | Response::Icon(_) | Response::ProfileNode { .. }) => std::process::ExitCode::SUCCESS,
        // Что вышло из импорта. Пропущенное печатается с причиной: вставили
        // полсотни строк, приехало двенадцать — и куда делись остальные, до сих
        // пор не отвечал никто.
        Ok(Response::Imported { added, kept, gone, skipped, skipped_total }) => {
            println!(
                "{}",
                tf!("заведено {}, уже было {}, убрано {}, пропущено {}", added, kept, gone, skipped_total)
            );
            for why in &skipped {
                eprintln!("  {why}");
            }
            if skipped_total > skipped.len() {
                eprintln!("  … {}", skipped_total - skipped.len());
            }
            std::process::ExitCode::SUCCESS
        }
        // Адрес целиком: его вставляют в --proxy-server как есть.
        Ok(Response::Proxy { port }) => {
            println!("socks5://127.0.0.1:{port}");
            std::process::ExitCode::SUCCESS
        }
        Ok(Response::Connections { conns, total }) => {
            for c in &conns {
                // Маршрут первой колонкой: ради него список и спрашивают.
                // Процесс — именем файла: путь целиком гонит строку за край, а
                // отличать один chrome.exe от другого тут всё равно нечем.
                let route = if c.tunneled { t("туннель") } else { t("напрямую") };
                let name = c.process.rsplit(['\\', '/']).next().unwrap_or("—");
                println!("{route:<10} {:<24} {:<40} ↓{} ↑{}", if name.is_empty() { "—" } else { name }, c.host, bytes(c.rx), bytes(c.tx));
            }
            if total > conns.len() {
                println!("{}", tf!("… и ещё {}", total - conns.len()));
            }
            std::process::ExitCode::SUCCESS
        }
        Ok(Response::Apps(apps)) => {
            for a in apps {
                println!("[{}] {} — {}", if a.enabled { "x" } else { " " }, a.name, a.path);
            }
            std::process::ExitCode::SUCCESS
        }
        // Печатается то, что действует, — вместе с ответом на `settings --…`:
        // увидеть результат правки в том же выводе важнее, чем сэкономить
        // четыре строки.
        Ok(Response::Status(s)) if args[0] == "settings" => {
            adopt(s.lang);
            let onoff = |v: bool| if v { "on" } else { "off" };
            let or = |v: &str, empty: String| if v.is_empty() { empty } else { v.to_string() };
            println!("{:<10} {}", "refresh", onoff(s.settings.refresh));
            println!("{:<10} {}", "geo", onoff(s.settings.geo));
            println!("{:<10} {}", "probe", or(&s.settings.probe, t("сервер узла")));
            println!("{:<10} {}", "singbox", or(&s.settings.singbox, t("рядом со службой либо PATH")));
            std::process::ExitCode::SUCCESS
        }
        Ok(Response::Status(s)) if args[0] == "test" => {
            adopt(s.lang);
            for p in &s.probes {
                let verdict = match (p.latency_ms, &p.error) {
                    (Some(ms), _) => match &p.country {
                        Some(c) => tf!("{} мс — {}", ms, c),
                        None => tf!("{} мс", ms),
                    },
                    (None, Some(e)) => e.clone(),
                    (None, None) => t("не проверен"),
                };
                println!("{:<20} {verdict}", p.name);
            }
            // Все профили мёртвые — это отказ, а не «успешно ничего не нашли».
            match s.probes.iter().any(|p| p.latency_ms.is_some()) {
                true => std::process::ExitCode::SUCCESS,
                false => std::process::ExitCode::FAILURE,
            }
        }
        Ok(Response::Status(s)) if args[0] == "browsers" => {
            adopt(s.lang);
            for b in &s.browser_profiles {
                let open = match s.browsers.contains(&b.name) {
                    true => t("открыт"),
                    false => t("закрыт"),
                };
                println!("{:<20} {:<20} {open}", b.name, b.node);
                if !b.ua.is_empty() {
                    println!("{:<20} ua: {}", "", b.ua);
                }
                if !b.lang.is_empty() {
                    println!("{:<20} lang: {}", "", b.lang);
                }
            }
            std::process::ExitCode::SUCCESS
        }
        Ok(Response::Status(s)) if args[0] == "profiles" => {
            adopt(s.lang);
            for p in &s.profiles {
                // Куда ведёт узел — то же, что и в окне: по одному имени два
                // одинаково названных узла подписки не различить.
                let where_to = match (p.kind.as_str(), p.server.as_str()) {
                    ("", "") => String::new(),
                    (kind, "") => format!("  {kind}"),
                    (kind, server) => format!("  {kind} → {server}"),
                };
                // Два знака, а не один: активный профиль и отмеченный — разные
                // вещи, и строка обязана показывать обе. Ставит звёздочку окно
                // (`set-favorite`); в консоли её видно, но не меняют — как и
                // остальное, чему в ней не нашлось дела.
                let active = if s.profile.as_deref() == Some(&p.name) { '*' } else { ' ' };
                let star = if p.favorite { '★' } else { ' ' };
                println!("{active}{star}{:<24}{where_to}", p.name);
            }
            std::process::ExitCode::SUCCESS
        }
        Ok(Response::Status(s)) => {
            adopt(s.lang);
            let latency = s.latency_ms.unwrap_or(0);
            let state = match s.tunnel {
                core_ipc::Tunnel::Off => t("выключен"),
                core_ipc::Tunnel::Connecting => t("подключение"),
                core_ipc::Tunnel::Up => tf!("поднят, {} мс", latency),
                core_ipc::Tunnel::Down => t("недоступен — выбранные приложения без сети"),
            };
            let on = s.apps.iter().filter(|a| a.enabled).count();
            println!("{:<11} {state}", t("туннель:"));
            println!(
                "{:<11} {}",
                t("охват:"),
                match s.scope {
                    Scope::All => t("весь трафик компьютера"),
                    Scope::Whitelist => t("только выбранные приложения, остальным сеть закрыта"),
                    Scope::None => t("никто: туннель поднят, но пропусков нет ни у кого"),
                }
            );
            println!("{:<11} {}", t("профиль:"), s.profile.unwrap_or_else(|| "—".into()));
            println!("{:<11} {}", t("страна:"), s.country.unwrap_or_else(|| "—".into()));
            println!("{:<11} ↓{} ↑{}", t("трафик:"), bytes(s.rx), bytes(s.tx));
            println!(
                "{:<11} {} ({} {})",
                t("приложения:"),
                s.apps.len(),
                t("в туннеле"),
                on
            );
            if !s.browsers.is_empty() {
                println!("{:<11} {}", t("браузер:"), s.browsers.join(", "));
            }
            if let Some(last) = s.log.first() {
                println!("{:<11} {}", t("последнее:"), last.text);
            }
            std::process::ExitCode::SUCCESS
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Округление и выбор единицы — единственная арифметика в клиенте.
    #[test]
    fn bytes_read_like_in_the_window() {
        assert_eq!(bytes(0), "0 B");
        assert_eq!(bytes(1023), "1023 B", "до килобайта единицу не меняем");
        assert_eq!(bytes(1024), "1.0 KB");
        assert_eq!(bytes(1024 * 12), "12 KB", "у больших чисел десятая доля — шум");
        assert_eq!(bytes(1024 * 1024 * 3 + 512 * 1024), "3.5 MB");
        assert_eq!(bytes(u64::MAX), "16777216 TB", "выше терабайта единиц нет — число растёт, а не единица");
    }

    /// Имя бинарника у крейта своё (`[[bin]]` в Cargo.toml), и `pg-cli.exe` не
    /// существует нигде: установщик кладёт `proxybox.exe`, и он же
    /// собирается в `target/`. `scripts/cpu.ps1` зовёт клиента, чтобы
    /// переключить охват, и знает это имя третьим местом — разъедется, и
    /// скрипт будет искать несуществующий файл, а человеку предложит собрать
    /// то, чего не бывает. Проверено на живом: именно так и вышло.
    #[test]
    fn the_cpu_script_knows_the_cli_name() {
        let script = include_str!("../../../scripts/cpu.ps1");
        let want = format!("$CLI_NAME = \"{}\"", env!("CARGO_BIN_NAME"));
        assert!(script.contains(&want), "в scripts/cpu.ps1 нет строки «{want}»");
    }

    /// Справка не должна выглядеть отказом, а разбор — молча съедать команду.
    #[test]
    fn usage_is_not_a_command() {
        assert!(parse(&["--help".into()]).is_err(), "справку разбирает main, до parse");
        assert!(parse(&[]).is_err());
        assert!(matches!(parse(&["status".into()]), Ok(Request::Status)));
    }
}
