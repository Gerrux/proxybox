# Разработка

## Структура

```
crates/
  core-ipc/          контракт службы ↔ клиенты + клиентский вызов call()
  core-apps/         автообнаружение приложений (каталог, ярлыки «Пуска», реестр,
                     пакеты MSIX, запущенные процессы) и их иконки
  core-config/       share-link (vless/vmess/trojan/ss/hy2/tuic/wg) и тело подписки
                     → узел sing-box
  core-tunnel/       генерация конфига sing-box, запуск и присмотр, проба, трафик
  core-filter/       политика fail-closed + пропуска брандмауэра выбранным .exe
  pg-service/        служба: состояние, процесс sing-box, надзор раз в 3 с;
                     на Windows — служба SCM (install/uninstall в ней же)
  pg-cli/            бинарник proxybox — headless-клиент контракта
src-tauri/           Tauri 2.x оболочка (отдельный Cargo-проект, сборка только
                     на Windows); пробрасывает запросы фронтенда в core-ipc
ui/app-shell/        Vite+React+TS+Tailwind: статус, профили, приложения, журнал
resources/apps/      каталог-дополнение к реестру: консольные инструменты и то,
                     что не регистрируется (catalog.v1.json, вшит в core-apps)
installer/           hooks.nsh (регистрация службы) и build.ps1 (сборка установщика)
scripts/e2e.sh       сквозная проверка на своём же sing-box-сервере
scripts/bench-cores.sh  сравнение ядер (sing-box / mihomo / Xray) на одном стенде
```

## Требования

- Rust toolchain; Node + [pnpm](https://pnpm.io) 9+
- **sing-box** рядом с бинарником службы (`sing-box.exe`), в `PATH` или по пути
  из `PG_SINGBOX`. В установщик кладётся вместе со службой.
- Для десктоп-сборки (только Windows) — Tauri CLI 2.x
  (`cargo install tauri-cli --version "^2"`), MSVC/VS Build Tools, WebView2.
  На Linux нет webkit2gtk — `src-tauri` не собирается, ядро и фронтенд собираются.

## Команды

```bash
pnpm install
cargo run -p pg-service                       # служба (терминал 1)
cargo run -p pg-cli -- add-profile --link 'vless://…'
cargo run -p pg-cli -- add-profile --link 'https://панель/sub'  # подписка целиком
cargo run -p pg-cli -- profiles                # что заведено: имя, тип, куда ведёт
cargo run -p pg-cli -- discover                # найти установленные приложения
cargo run -p pg-cli -- enable --path 'C:\…\chrome.exe'
cargo run -p pg-cli -- on --profile myvpn
cargo run -p pg-cli -- status
cargo run -p pg-cli -- test                    # прогнать профили: кто отвечает
cargo run -p pg-cli -- test --profile myvpn    # только этот — секунды вместо минут
cargo run -p pg-cli -- conns                   # живые соединения: кто, куда, каким
                                               # маршрутом; ничего не сохраняется
cargo run -p pg-cli -- add-browser --name работа --node myvpn --lang auto
cargo run -p pg-cli -- browsers                # браузерные профили и их сеансы
cargo run -p pg-cli -- browse --profile работа # свой прокси под профиль: адрес
                                               # для --proxy-server браузера
cargo run -p pg-cli -- browse --stop --profile работа  # погасить этот сеанс
cargo run -p pg-cli -- settings                # настройки службы: что действует
cargo run -p pg-cli -- settings --geo off      # не спрашивать страну у сервиса
cargo run -p pg-cli -- doctor                  # почему не работает: окружение

pnpm --filter app-shell dev                   # фронтенд на :5173; дев-сервер
                                              # сам ходит в службу (см. vite.config.ts),
                                              # так интерфейс живой и без Tauri
cargo tauri dev                               # окно с фронтендом (Windows)

pnpm validate                                 # lint + build + cargo test
cargo check --workspace --target x86_64-pc-windows-msvc   # проверка windows-веток
PG_SINGBOX=/путь/к/sing-box scripts/e2e.sh    # сквозная проверка, нужен sing-box
scripts/settings.sh                           # настройки: правка, диск, окружение
```

`scripts/e2e.sh` поднимает собственный vless-сервер, импортирует ссылку на него,
включает приватный режим, проверяет что трафик идёт через туннель и что после
убийства сервера соединения перестают проходить.

Переменные: `PG_SINGBOX` — путь к бинарнику, `PG_TUN=0` — не поднимать TUN,
`PG_PROBE=host:port` — цель пробы (по умолчанию сам сервер профиля, чтобы не
трогать сторонние адреса), `PG_GEO=0` — не спрашивать точку выхода,
`PG_REFRESH=0` — не сверять подписки по расписанию.

Четыре из них — `PG_SINGBOX`, `PG_PROBE`, `PG_GEO`, `PG_REFRESH` — теперь есть
и настройками: в окне и в `proxybox settings`. Переменная сильнее
настройки, и служба говорит об этом строкой в журнале при старте; на диск
перебивка не уходит — она живёт ровно столько, сколько выставлена переменная.
`scripts/settings.sh` проверяет это без sing-box.

В `%APPDATA%\proxybox\`: `state.json` — профили, приложения и последнее
измеренное про каждый профиль,
`singbox.json` — сгенерированный конфиг, `singbox.log` — вывод sing-box
(последняя строка попадает в журнал службы, когда запуск не удался),
`journal.json` — сам журнал службы, те же тридцать строк, что показаны в окне.
Журнал лежит файлом именно потому, что перезапуск службы — это обновление,
падение или загрузка машины, то есть ровно те случаи, ради которых в него и
смотрят; под SCM у службы нет ни консоли, ни stderr.

`doctor` проверяет не свой код, а внешние причины: отвечает ли служба, найден ли
sing-box, работает ли служба Base Filtering Engine (без неё `netsh` не поставит
блокирующие правила), запущено ли всё от администратора, не включён ли системный
прокси и не подняты ли чужие TUN/VPN-адаптеры — они спорят за маршруты с нашим
`strict_route`. Провал хотя бы одной проверки — ненулевой код возврата.
Единственная команда, которая работает без службы: она нужна ровно тогда, когда
служба молчит.

## Если что-то не работает

- **Tauri пишет «Waiting for your frontend dev server»**, хотя vite уже поднялся —
  выключите сторонний VPN: подняв свой TUN, он перехватывает в том числе пробы
  на 127.0.0.1, и Tauri не видит дев-сервер. По той же причине `doctor`
  предупреждает о чужих поднятых TUN/VPN-адаптерах.
- **«Служба не отвечает»** — она не запущена или запущена без прав
  администратора. `run.bat` от имени администратора, либо `sc query proxybox`.
- **`configure tun interface: Access is denied`** и `netsh … requires elevation`
  — это одно и то же: службу запустили без прав администратора. Ни TUN, ни
  правила брандмауэра без них не поднимаются, а без них приватного режима нет.
- **Первая же команда — `proxybox doctor`**: он проверяет права, службу,
  sing-box, Base Filtering Engine, системный прокси и чужие туннели.

