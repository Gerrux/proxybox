# Порт на Linux, подпроект 1 (служба) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** На Linux работает туннель с замком и охватом «весь компьютер», управляемый из консоли.

**Architecture:** Замок — одна таблица nftables с `policy drop`, которая ставится и снимается целиком и не касается чужого брандмауэра. IPC переезжает с TCP на unix-сокет в каталоге с правами. Служба живёт под systemd и снимает правила по SIGTERM. Логика службы (`supervise`, проба, поколения) не трогается вовсе.

**Tech Stack:** Rust 2021, без новых зависимостей (WinAPI и вызовы libc объявляются `extern "C"` на месте — так уже сделано в `core-apps`), `nft` и `systemd` как внешние программы, sing-box 1.13.19.

**Spec:** `docs/superpowers/specs/2026-09-06-linux-port-service-design.md`

## Global Constraints

- **Язык репозитория — русский.** Комментарии, доки, сообщения коммитов, строки журнала. Комментарии объясняют «почему», а не «что»; шапка модуля — рационал целиком.
- **Правило со словом «обязан» заводится вместе со сторожем** и абзац ссылается на него по имени теста.
- **Тестов-файлов нет.** Всё в `#[cfg(test)] mod tests` внутри модуля.
- **Windows не должна сломаться.** После каждой задачи обязан проходить `cargo check --workspace --target x86_64-pc-windows-msvc`.
- **Новых зависимостей не добавляем.** В `Cargo.toml` воркспейса нет даже `libc`, и это намеренно.
- **`ponytail:` комментарии настоящие и посчитаны.** В `CLAUDE.md` написано «их четырнадцать». Заводите новый — правьте число там же, в разделе «Стиль».
- **Полная проверка:** `pnpm validate` (= `tsc --noEmit` + `vite build` + `cargo test --workspace`).
- Порты: 48292 mixed/SOCKS, 48293 Clash API. Порт 48291 (IPC) **исчезает**.
- Путь сокета: `/run/proxybox/service.sock`, каталог `/run/proxybox` — `0750 root:proxybox`. Группу `proxybox` заводит пакет (подпроект 3); пока его нет, каталог остаётся `0750 root:root`, то есть службой управляет один root. Это и есть работоспособное состояние подпроекта 1.
- Адрес и имя TUN не меняются: `172.27.234.1`, `proxybox`.

---

## Карта файлов

| Файл | Ответственность | Задача |
| --- | --- | --- |
| `crates/core-ipc/src/unix_socket.rs` (создать) | Серверная сторона сокета: каталог, права, `SO_PEERCRED`. Единственное место с вызовами libc | 1 |
| `crates/core-ipc/src/lib.rs` | `Stream`/`Listener`/`connect`/`Endpoint` — ветка не-Windows переезжает с TCP на сокет; `ADDR` удаляется | 1 |
| `ui/app-shell/vite.config.ts` | Дев-мост ходит по пути сокета, а не по порту | 1 |
| `crates/pg-service/src/main.rs` | `dir()`, `elevated()`, строка журнала о том, где встала служба, SIGTERM, `tun_enabled()` | 2, 3, 5 |
| `crates/core-filter/src/linux.rs` (создать) | Текст таблицы nftables и её постановка; `/sys/class/net` | 4 |
| `crates/core-filter/src/lib.rs` | Фасад: тела расходятся по `mod windows` / `mod linux` | 4 |
| `installer/proxybox.service` (создать) | Unit systemd | 6 |
| `scripts/e2e.sh` | Сквозная проверка fail-closed под root | 6 |
| `.github/workflows/ci.yml` | Job на ubuntu с sing-box и e2e; `cargo check` оболочки под Linux | 6 |
| `CLAUDE.md`, `docs/limitations.md`, `docs/install.md` | Расхождения систем и установка | 7 |

Порядок задач такой, что дерево после каждой собирается и тесты зелёные.

---

### Task 1: Транспорт IPC на unix-сокет

**Files:**
- Create: `crates/core-ipc/src/unix_socket.rs`
- Modify: `crates/core-ipc/src/lib.rs:16-40` (объявления модулей и константы), `:792-960` (`Stream`, `Listener`, `connect`), `:1598-1604` (сторож дев-моста)
- Modify: `crates/pg-service/src/main.rs:15` (импорт `ADDR`), `:3745-3746` (строка журнала)
- Modify: `ui/app-shell/vite.config.ts:14-16, 38-56`
- Test: в `crates/core-ipc/src/unix_socket.rs` и `crates/core-ipc/src/lib.rs`, оба в `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: ничего от других задач.
- Produces:
  - `core_ipc::SOCKET: &str` = `"/run/proxybox/service.sock"`
  - `core_ipc::Endpoint::Socket` (вариант `Tcp` удалён)
  - `core_ipc::Stream::peer(&self) -> Option<u32>` — сигнатура не меняется
  - `unix_socket::bind() -> io::Result<std::os::unix::net::UnixListener>`
  - `unix_socket::client_pid(stream: &std::os::unix::net::UnixStream) -> Option<u32>`

- [ ] **Step 1: Написать падающий тест на права сокета**

В новый файл `crates/core-ipc/src/unix_socket.rs` — пока только тесты и заглушки не нужны, файл создаётся целиком на шаге 3. Тест кладётся туда же:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Сокет службы обязан быть закрыт от посторонних: через него выключают
    /// приватный режим. Права даёт членство в группе — прямой аналог ACL
    /// именованного канала на Windows, где право даёт членство в
    /// «интерактивных пользователях».
    ///
    /// Стережём каталог, а не сам сокет, и это не придирка: между `bind` и
    /// `chmod` сокет существует с правами по umask, и закрыть эту щель можно
    /// только тем, что каталог вокруг него закрыт заранее.
    #[test]
    fn the_socket_is_never_world_writable() {
        let dir = std::env::temp_dir().join(format!("pg-sock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sock = dir.join("service.sock");
        let listener = bind_at(&sock).expect("сокет");
        let mode = std::fs::metadata(&dir).expect("каталог").permissions().mode() & 0o777;
        assert_eq!(mode, 0o750, "каталог сокета открыт посторонним");
        drop(listener);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 2: Убедиться, что тест не собирается**

Run: `cargo test -p core-ipc the_socket_is_never_world_writable`
Expected: FAIL — `cannot find function bind_at in this scope`.

- [ ] **Step 3: Написать `unix_socket.rs`**

Полное содержимое файла (тест из шага 1 остаётся в конце):

```rust
//! Серверная сторона unix-сокета — единственное место с вызовами libc.
//! Клиенты обходятся `UnixStream::connect`: это умеет std.
//!
//! Право управлять службой даёт членство в группе `proxybox`, и это прямой
//! аналог списка доступа именованного канала на Windows: там право даёт
//! членство в «интерактивных пользователях». Различает и то и другое
//! пользователя, а не программу, — иначе и быть не может, свою же консоль
//! запускает кто угодно от имени того же человека.
//!
//! Права стоят на каталоге, а не на сокете, и порядок тут обязателен. Между
//! `bind` и `chmod` сокет уже существует, с правами по umask процесса, а umask
//! службе никто не гарантирует. Закрытый заранее каталог убирает эту щель
//! целиком: до сокета внутри не дотянуться, какими бы правами он ни родился.
//! Сторож — `the_socket_is_never_world_writable`.

use std::io;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::process::Stdio;

/// Каталог сокета: войти могут только root и группа `proxybox`.
const DIR_MODE: u32 = 0o750;
/// Кому позволено управлять службой. Заводит группу пакет; пока его нет,
/// каталог остаётся за одним root.
const GROUP: &str = "proxybox";

/// Поднять сокет по пути из контракта.
pub fn bind() -> io::Result<UnixListener> {
    bind_at(Path::new(crate::SOCKET))
}

/// То же, но по произвольному пути — так проверяет сторож, не трогая `/run`.
fn bind_at(path: &Path) -> io::Result<UnixListener> {
    let dir = path.parent().ok_or_else(|| io::Error::other("у сокета нет каталога"))?;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(DIR_MODE))?;
    // Сокет, оставшийся от убитой службы, мешает bind. Снимаем его — но
    // только убедившись, что на том конце никто не слушает: иначе вторая
    // копия службы отобрала бы канал у первой, а распорядитель обязан быть
    // один. Та же мысль, что и в `Listener::bind` на Windows.
    if path.exists() && UnixStream::connect(path).is_err() {
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    // Группу заводит пакет, а он приезжает подпроектом 3. Пока её нет, каталог
    // остаётся за одним root — то есть службой управляет только root, и это
    // честнее, чем открыть каталог кому-то ещё. Отказ поэтому не отказ:
    // `chgrp` на несуществующую группу означает «пакета ещё не было».
    let _ = std::process::Command::new("chgrp")
        .arg(GROUP)
        .arg(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    Ok(listener)
}

#[repr(C)]
struct Ucred {
    pid: i32,
    uid: u32,
    gid: u32,
}

extern "C" {
    fn getsockopt(fd: i32, level: i32, name: i32, value: *mut std::ffi::c_void, len: *mut u32) -> i32;
}

const SOL_SOCKET: i32 = 1;
/// ponytail: номер `SO_PEERCRED` взят для x86_64/aarch64, где он равен 17.
/// На mips и sparc он другой, и там `peer()` вернёт `None` — то есть чужой
/// перестанет называться в журнале, а права не изменятся: их даёт каталог.
/// Апгрейд — таблица по `target_arch`, когда появится сборка под такую машину.
const SO_PEERCRED: i32 = 17;

/// Кто на том конце — номером процесса. Заполняет структуру ядро в момент
/// `connect`, подделать её нечем.
///
/// Это след для журнала, а не право доступа: список доступа различает
/// пользователя, а не программу. Поэтому осечка не отнимает команду — она
/// отнимает имя в журнале.
pub fn client_pid(stream: &UnixStream) -> Option<u32> {
    use std::os::unix::io::AsRawFd;
    let mut cred = Ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<Ucred>() as u32;
    let ok = unsafe {
        getsockopt(stream.as_raw_fd(), SOL_SOCKET, SO_PEERCRED, &mut cred as *mut Ucred as *mut _, &mut len)
    };
    (ok == 0 && cred.pid > 0).then_some(cred.pid as u32)
}
```

- [ ] **Step 4: Прогнать тест**

Run: `cargo test -p core-ipc the_socket_is_never_world_writable`
Expected: PASS.

- [ ] **Step 5: Написать падающий тест на опознание клиента**

В `crates/core-ipc/src/unix_socket.rs`, в тот же `mod tests`:

```rust
    /// Чужого, приславшего разрушающую команду, служба называет в журнале, и
    /// имя ей даёт ядро, а не клиент. Осечка здесь означает не потерянную
    /// команду, а потерянный след — и заметить её больше нечем.
    #[test]
    fn a_stranger_is_named_by_peer_creds() {
        let dir = std::env::temp_dir().join(format!("pg-peer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sock = dir.join("service.sock");
        let listener = bind_at(&sock).expect("сокет");
        let client = UnixStream::connect(&sock).expect("клиент");
        let (server_side, _) = listener.accept().expect("приём");
        assert_eq!(client_pid(&server_side), Some(std::process::id()), "ядро назвало не тот процесс");
        drop(client);
        drop(listener);
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 6: Прогнать тест**

Run: `cargo test -p core-ipc a_stranger_is_named_by_peer_creds`
Expected: PASS (реализация уже написана на шаге 3).

- [ ] **Step 7: Переключить `core-ipc` на сокет**

В `crates/core-ipc/src/lib.rs`:

Объявление модуля рядом с `windows_pipe` (строка 16):

```rust
#[cfg(windows)]
mod windows_pipe;
#[cfg(not(windows))]
mod unix_socket;
```

Удалить строку `pub const ADDR: &str = "127.0.0.1:48291";` и импорт `use std::net::{TcpListener, TcpStream};`. Вместо `ADDR` завести:

```rust
/// Куда встаёт служба вне Windows. Каталог, а не голый путь в `/run`: права
/// стоят на каталоге — см. шапку `unix_socket`.
#[cfg(not(windows))]
pub const SOCKET: &str = "/run/proxybox/service.sock";
```

Заменить варианты `Tcp` на `Unix` во всех четырёх местах (`Inner`, `ListenerInner`, `Endpoint`, и `impl Read`/`Write`/`try_clone`):

```rust
enum Inner {
    #[cfg(not(windows))]
    Unix(std::os::unix::net::UnixStream),
    #[cfg(windows)]
    Pipe(std::fs::File),
}
```

`Endpoint`:

```rust
pub enum Endpoint {
    Pipe,
    Socket,
}
```

`peer()`:

```rust
            #[cfg(not(windows))]
            Inner::Unix(s) => unix_socket::client_pid(s),
```

`bind()`, ветка не-Windows:

```rust
        #[cfg(not(windows))]
        Ok((Listener(ListenerInner::Unix(unix_socket::bind()?)), Endpoint::Socket))
```

`accept()`, ветка не-Windows:

```rust
            #[cfg(not(windows))]
            ListenerInner::Unix(l) => Ok(Stream(Inner::Unix(l.accept()?.0))),
```

`connect()`, ветка не-Windows:

```rust
    #[cfg(not(windows))]
    Ok(Stream(Inner::Unix(std::os::unix::net::UnixStream::connect(SOCKET)?)))
```

- [ ] **Step 8: Починить вызывающих**

В `crates/pg-service/src/main.rs` убрать `ADDR` из импорта (строка 15) и заменить строку журнала (3745-3746):

```rust
        let where_ = match endpoint {
            Endpoint::Pipe => format!("канал {}", core_ipc::PIPE),
            Endpoint::Socket => format!("сокет {}", core_ipc::SOCKET),
        };
```

- [ ] **Step 9: Прогнать тесты — сторож дев-моста обязан покраснеть**

Run: `cargo test --workspace`
Expected: FAIL в `the_dev_bridge_knows_the_port` — он ищет `ADDR`, которого больше нет (ошибка компиляции теста). Это и есть сигнал, что дев-мост остался смотреть в порт.

- [ ] **Step 10: Переписать сторож дев-моста**

В `crates/core-ipc/src/lib.rs` заменить тест целиком:

```rust
    /// Мост дев-сервера ходит в службу по пути сокета, записанному второй раз.
    /// Компилятора у него нет вовсе, и разъезд с контрактом молчит с обеих
    /// сторон: окно просто перестаёт получать статус.
    #[test]
    #[cfg(not(windows))]
    fn the_dev_bridge_knows_the_socket() {
        let vite = include_str!("../../../ui/app-shell/vite.config.ts");
        assert!(vite.contains(&format!("SERVICE_SOCKET = \"{SOCKET}\"")), "vite.config.ts смотрит не в {SOCKET}");
    }
```

- [ ] **Step 11: Переписать дев-мост**

В `ui/app-shell/vite.config.ts` заменить константы (строки 14-16):

```ts
/** Куда стучаться в службу (core_ipc::SOCKET и core_ipc::PIPE). Дублируется
 *  здесь только ради разработки. */
const SERVICE_SOCKET = "/run/proxybox/service.sock";
const SERVICE_PIPE = "\\\\.\\pipe\\proxybox";
```

И заменить выбор адреса внутри `ask` (строка 41) и последнюю строку `req.on("end", ...)`:

```ts
        const ask = (viaPipe: boolean) => {
          const socket = net.connect({ path: viaPipe ? SERVICE_PIPE : SERVICE_SOCKET });
```

```ts
          socket.on("error", (e) => fail(`служба недоступна: ${e.message}`));
        };
        req.on("end", () => ask(process.platform === "win32"));
```

Отката с канала на сокет больше нет: на Windows слушать сокет некому, а если кто-то слушает — это не служба. Обновить и комментарий над `ask` (строки 38-39):

```ts
        // На Windows служба слушает именованный канал, вне Windows — unix-сокет.
        // Отката между ними нет: на чужой платформе на том конце не служба.
```

- [ ] **Step 12: Починить поиск службы в e2e**

`scripts/e2e.sh` находит службу по порту, которого больше нет:

```bash
SVC=$(ss -ltnp 2>/dev/null | grep ':48291 ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
```

Пустой `SVC` под `set -e` роняет скрипт на `kill`, и упадёт он не там, где
сломано. Заменить на поиск по имени процесса — служба у скрипта своя, чужой в
`$WORK` неоткуда взяться:

```bash
SVC=$(pgrep -f 'target/debug/pg-service' | head -1)
[ -n "$SVC" ] || fail "служба не найдена"
```

- [ ] **Step 13: Полная проверка**

Run: `cargo test --workspace && cargo check --workspace --target x86_64-pc-windows-msvc`
Expected: PASS обе команды.

Run: `PG_SINGBOX=$(which sing-box) scripts/e2e.sh`
Expected: PASS — в том числе шаг «перезапуск службы», который и ломался бы без шага 12.

- [ ] **Step 14: Коммит**

```bash
git add crates/core-ipc/src/unix_socket.rs crates/core-ipc/src/lib.rs crates/pg-service/src/main.rs ui/app-shell/vite.config.ts scripts/e2e.sh
git commit -m "Служба вне Windows слушает unix-сокет, а не порт на петле

Сокет на 127.0.0.1 открыт любому процессу машины, а служба умеет выключать
приватный режим — на Windows отката на TCP нет ровно поэтому, и порт
наследовать было нельзя. Право теперь даёт членство в группе, как на Windows
его даёт членство в «интерактивных пользователях».

Права стоят на каталоге, а не на сокете: между bind и chmod сокет уже
существует с правами по umask, и закрыть эту щель может только каталог,
закрытый заранее.

Опознание клиента через SO_PEERCRED выходит строже виндовского: pid, uid и gid
заполняет ядро в момент connect."
```

---

### Task 2: Каталог состояния и права администратора

**Files:**
- Modify: `crates/pg-service/src/main.rs:101-110` (`dir()`), `:962-975` (`elevated()`)
- Test: `crates/pg-service/src/main.rs`, `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: ничего.
- Produces: `dir()` возвращает `/var/lib/proxybox` под root на Linux; `elevated() -> bool` отвечает по `geteuid`.

- [ ] **Step 1: Написать падающий тест**

В `crates/pg-service/src/main.rs`, в `mod tests`:

```rust
    /// Служба под root обязана держать состояние в `/var/lib`, а не в
    /// `$XDG_CONFIG_HOME`: у root это `/root/.config`, то есть домашний каталог
    /// человека, которого нет. В `state.json` лежат пароли и ключи всех
    /// профилей, и место им там, где система держит состояние служб.
    ///
    /// Разработке остаётся XDG: там служба работает обычным процессом, и
    /// `/var/lib` ей не отдадут.
    #[test]
    #[cfg(unix)]
    fn the_service_keeps_its_state_where_the_system_keeps_it() {
        assert_eq!(base_dir(true, Some("/home/kto/.config".into())), PathBuf::from("/var/lib"));
        assert_eq!(base_dir(false, Some("/home/kto/.config".into())), PathBuf::from("/home/kto/.config"));
    }
```

- [ ] **Step 2: Убедиться, что тест не собирается**

Run: `cargo test -p pg-service the_service_keeps_its_state_where_the_system_keeps_it`
Expected: FAIL — `cannot find function base_dir in this scope`.

- [ ] **Step 3: Разделить `dir()` на чистую и грязную половины**

В `crates/pg-service/src/main.rs` заменить `dir()` (строки 101-110) на:

```rust
/// Где служба держит состояние. Грязная половина: спрашивает окружение и
/// права, а решает `base_dir` — её и проверяет сторож.
fn dir() -> PathBuf {
    let base = base_dir(elevated(), std::env::var_os("ProgramData").or_else(|| std::env::var_os("XDG_CONFIG_HOME")).map(PathBuf::from));
    settle(base)
}

/// Куда класть каталог состояния. Под root на Linux — `/var/lib`: у root
/// `$XDG_CONFIG_HOME` указывает в `/root/.config`, то есть состояние службы
/// уехало бы в домашний каталог, которого у неё нет. Без прав — туда, куда
/// показало окружение: так работает разработка.
///
/// На Windows окружение всегда называет `%ProgramData%`, и первая ветка не
/// исполняется: `elevated()` там про права администратора, а не про uid.
/// Сторож — `the_service_keeps_its_state_where_the_system_keeps_it`.
fn base_dir(elevated: bool, from_env: Option<PathBuf>) -> PathBuf {
    match (cfg!(windows), elevated, from_env) {
        (false, true, _) => PathBuf::from("/var/lib"),
        (_, _, Some(env)) => env,
        // Ни окружения, ни прав — работаем рядом с собой, как и раньше.
        (_, _, None) => PathBuf::from("."),
    }
}
```

Убедиться, что старый комментарий про `%USERPROFILE%` внутри System32 переехал в новую шапку, а не потерялся.

- [ ] **Step 4: Прогнать тест**

Run: `cargo test -p pg-service the_service_keeps_its_state_where_the_system_keeps_it`
Expected: PASS.

- [ ] **Step 5: Заменить `elevated()` вне Windows**

Заменить `#[cfg(not(windows))] fn elevated() -> bool { true }` (строки 972-975) на:

```rust
/// Без прав не поднять TUN и не тронуть nftables — а узнать об этом лучше
/// сразу, а не из потока отказов. Раньше вне Windows тут стояло `true`: там
/// службы и не было, проверять было нечего.
#[cfg(not(windows))]
fn elevated() -> bool {
    extern "C" {
        fn geteuid() -> u32;
    }
    unsafe { geteuid() == 0 }
}
```

- [ ] **Step 6: Полная проверка**

Run: `cargo test --workspace && cargo check --workspace --target x86_64-pc-windows-msvc`
Expected: PASS обе.

- [ ] **Step 7: Коммит**

```bash
git add crates/pg-service/src/main.rs
git commit -m "Состояние службы под root живёт в /var/lib, а не в /root/.config

XDG_CONFIG_HOME у root указывает в домашний каталог, которого у службы нет, —
а в state.json лежат пароли и ключи всех профилей. Разработке XDG остаётся:
там служба работает обычным процессом.

Заодно elevated() вне Windows перестал отвечать «да» не глядя: службы там
раньше не было, а теперь без прав не поднять ни TUN, ни nftables."
```

---

### Task 3: Остановка по SIGTERM

**Files:**
- Modify: `crates/pg-service/src/main.rs:3836-3876` (`main()`)
- Test: `crates/pg-service/src/main.rs`, `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `run(stop: Option<mpsc::Receiver<()>>)` — уже существует, менять не надо.
- Produces: на не-Windows `main()` передаёт в `run` заполненный `Some(rx)`.

- [ ] **Step 1: Написать падающий тест**

В `crates/pg-service/src/main.rs`, в `mod tests`:

```rust
    /// Служба, остановленная systemd, обязана вернуть машину: снятие правил
    /// висит на канале остановки, и `run(None)` означал бы запертое исходящее,
    /// пережившее службу. Проверить сигнал в тесте нечем — процесс тут один и
    /// он же испытуемый, — поэтому сторожим текстом: `main` обязан завести
    /// канал и отдать его в `run`.
    #[test]
    #[cfg(unix)]
    fn the_service_gives_the_machine_back() {
        let src = include_str!("main.rs");
        let body = src.split("fn main() -> std::process::ExitCode").nth(1).expect("main на месте");
        assert!(body.contains("watch_for_signals("), "main не ставит обработчик сигналов");
        assert!(!body.contains("run(None)"), "вне Windows служба обязана останавливаться по сигналу, а не только по Ctrl+C");
    }
```

- [ ] **Step 2: Прогнать тест**

Run: `cargo test -p pg-service the_service_gives_the_machine_back`
Expected: FAIL — `main не ставит обработчик сигналов`.

- [ ] **Step 3: Написать обработчик**

В `crates/pg-service/src/main.rs`, рядом с `elevated()`:

```rust
/// Остановка по сигналу. systemd шлёт SIGTERM, человек в консоли — SIGINT, и
/// оба означают одно: погасить туннель и снять правила.
///
/// Обработчик только взводит флаг. Из него нельзя ни звать `nft`, ни трогать
/// канал: в обработчике сигнала разрешено крайне мало, а `mpsc::Sender::send`
/// выделяет память и берёт замок. Поэтому за флагом следит отдельный поток и он
/// же посылает по каналу — тому самому, который на Windows заполняет SCM.
///
/// Сторож — `the_service_gives_the_machine_back`.
#[cfg(not(windows))]
fn watch_for_signals() -> mpsc::Receiver<()> {
    use std::sync::atomic::{AtomicBool, Ordering};

    static STOPPING: AtomicBool = AtomicBool::new(false);

    extern "C" fn on_signal(_: i32) {
        STOPPING.store(true, Ordering::SeqCst);
    }
    extern "C" {
        fn signal(num: i32, handler: extern "C" fn(i32)) -> usize;
    }
    const SIGINT: i32 = 2;
    const SIGTERM: i32 = 15;

    unsafe {
        signal(SIGINT, on_signal);
        signal(SIGTERM, on_signal);
    }

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || loop {
        if STOPPING.load(Ordering::SeqCst) {
            let _ = tx.send(());
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    });
    rx
}
```

- [ ] **Step 4: Подключить его в `main`**

В `crates/pg-service/src/main.rs` заменить хвост `main()`:

```rust
    #[cfg(windows)]
    let stop = None;
    #[cfg(not(windows))]
    let stop = Some(watch_for_signals());

    match run(stop) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("служба не запустилась: {e}");
            std::process::ExitCode::FAILURE
        }
    }
```

- [ ] **Step 5: Прогнать тест**

Run: `cargo test -p pg-service the_service_gives_the_machine_back`
Expected: PASS.

- [ ] **Step 6: Проверить руками, что служба действительно выходит**

Run: `cargo build -p pg-service && ./target/debug/pg-service & sleep 2; kill -TERM %1; sleep 1; jobs`
Expected: процесс завершился, в выводе нет висящего job.

- [ ] **Step 7: Полная проверка и коммит**

Run: `cargo test --workspace && cargo check --workspace --target x86_64-pc-windows-msvc`

```bash
git add crates/pg-service/src/main.rs
git commit -m "Служба вне Windows останавливается по сигналу, а не только по Ctrl+C

Снятие правил висит на канале остановки, а вне Windows в run() уезжал None:
убитая systemd служба оставила бы машину с запертым исходящим. Канал теперь
заполняет обработчик сигналов — тот самый, который на Windows заполняет SCM.

Обработчик только взводит флаг: звать из него nft нельзя, там разрешено
крайне мало, и даже mpsc::Sender::send выделяет память и берёт замок."
```

---

### Task 4: Замок на nftables

**Files:**
- Create: `crates/core-filter/src/linux.rs`
- Modify: `crates/core-filter/src/lib.rs:182-230` (`set_fence`), `:301-320` (`set_killswitch`), `:343-410` (`policy_now`, `locked_by_us`), `:431-477` (`foreign_tunnels`, `adapters`)
- Test: `crates/core-filter/src/linux.rs`, `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: ничего.
- Produces (внутри крейта, наружу контракт не меняется):
  - `linux::table(on: bool, tun_name: &str, uid: u32) -> String` — текст скрипта для `nft -f -`
  - `linux::apply(script: &str) -> io::Result<()>`
  - `linux::locked() -> bool`
  - `linux::tunnels(ours: &str) -> Vec<String>`

**Замечание о полноте.** В этом подпроекте `set_fence` на Linux не ставит ни одного пропуска: пропуска нужны только белому списку, а он — подпроект 2. Значит `Fence::Allow` и `Fence::Off` дают одну и ту же таблицу, и это не упущение, а честный fail-closed: выбранное приложение остаётся без сети, а не уходит напрямую. Ровно так же ведёт себя диагностический `Scope::None` на Windows.

- [ ] **Step 1: Написать падающие тесты на текст таблицы**

Создать `crates/core-filter/src/linux.rs` — пока только с `mod tests`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Замок — одна таблица, и снимается она целиком. Правка правил внутри
    /// чужой таблицы означала бы возврат всей той машинерии, которой на Windows
    /// платят за то, что политику приходится отбирать у системы: чтение чужой
    /// политики, её возврат и метла по сиротам.
    #[test]
    fn the_lock_is_one_table() {
        let on = table(true, "proxybox", 0);
        assert_eq!(on.matches("policy drop").count(), 1, "базовая цепочка обязана быть одна");
        let off = table(false, "proxybox", 0);
        assert!(!off.contains("policy drop"), "снятый замок не оставляет цепочки");
        assert!(off.contains("delete table inet proxybox"), "снятие замка — удаление таблицы целиком");
    }

    /// Наша таблица не смотрит на чужие и не правит их. Это и есть причина, по
    /// которой на Linux не нужен возврат политики: `accept` в базовой цепочке
    /// не отменяет другие цепочки на том же хуке, а `drop` окончателен, — так
    /// что запереть машину можно, не тронув ничего чужого.
    #[test]
    fn the_lock_never_touches_a_foreign_table() {
        let script = table(true, "proxybox", 0);
        let names: Vec<&str> = script.lines().filter(|l| l.contains("table inet")).collect();
        assert!(!names.is_empty(), "таблица обязана называться");
        assert!(names.iter().all(|l| l.contains("inet proxybox")), "в скрипте названа чужая таблица: {names:?}");
    }

    /// Пропуска по `ct state` нет, и его отсутствие — само правило.
    ///
    /// Рассуждение «WFP решает на connect, значит установленные соединения
    /// замок переживают» правдоподобно и неверно: наблюдение с живой машины
    /// говорит обратное, и `PROBE_MISSES` появился ровно поэтому. Заведись
    /// такой пропуск здесь, соединения, шедшие напрямую до включения приватного
    /// режима, пережили бы замок и продолжили идти мимо туннеля — то есть
    /// Linux оказался бы слабее Windows в том самом месте, которое инвариант и
    /// защищает.
    #[test]
    fn the_lock_lets_nothing_through_on_being_established() {
        assert!(!table(true, "proxybox", 0).contains("ct state"), "живые прямые соединения переживают замок");
    }

    /// Туннелю нечем подняться, пока sing-box без сети, и пропуск ему обязан
    /// стоять в той же транзакции, что и сам замок. На Windows это два вызова
    /// netsh, и между ними туннель остаётся без пропуска; здесь такого окна нет.
    #[test]
    fn singbox_gets_its_pass_in_the_same_breath() {
        let script = table(true, "proxybox", 4242);
        assert!(script.contains("meta skuid 4242 accept"), "sing-box остался без пропуска");
        let lock = script.find("policy drop").expect("замок");
        let pass = script.find("meta skuid 4242").expect("пропуск");
        assert!(lock < pass, "пропуск обязан стоять внутри той же цепочки, что и замок");
    }
}
```

- [ ] **Step 2: Убедиться, что тесты не собираются**

Run: `cargo test -p core-filter the_lock_is_one_table`
Expected: FAIL — `cannot find function table`.

- [ ] **Step 3: Написать `linux.rs`**

Дописать в начало `crates/core-filter/src/linux.rs` (перед `mod tests`):

```rust
//! Замок на nftables: одна таблица, которая ставится и снимается целиком.
//!
//! Держится всё на свойстве nftables: `accept` в базовой цепочке не отменяет
//! другие базовые цепочки на том же хуке — пакет продолжает обход, — а `drop`
//! окончателен и обрывает его немедленно, в какой бы таблице цепочка ни лежала.
//! Значит наш `policy drop` запирает машину, не касаясь ни одного чужого
//! правила, и это ровно та семантика «блокировка сильнее разрешения», ради
//! которой на Windows приходится переставлять политику брандмауэра по умолчанию.
//!
//! Отсюда три вещи, которых здесь нет и которые на Windows обязательны:
//! возврата чужой политики (мы её не берём), метлы по сиротам (`nft -f`
//! транзакционен) и окна, в котором sing-box остаётся без пропуска (замок и
//! пропуск встают одним скриптом).
//!
//! Пропусков выбранным приложениям здесь нет вовсе: они нужны только белому
//! списку, а он приезжает следующим подпроектом вместе с cgroup. До тех пор
//! выбранное приложение в белом списке остаётся без сети — то есть fail-closed,
//! а не «ушло напрямую».

use std::io;
use std::process::{Command, Stdio};

/// Имя нашей таблицы. Одно на весь замок: снятие — это её удаление.
const TABLE: &str = "proxybox";

/// Текст скрипта для `nft -f -`.
///
/// Первые две строки — идиома идемпотентности: `nft` отказывается удалять
/// таблицу, которой нет, поэтому её сперва объявляют пустой. Дальше либо
/// ничего (замок снят), либо таблица целиком. Так один и тот же скрипт годится
/// и для постановки, и для смены содержимого: `guard` зовёт нас дважды на одно
/// нажатие, и второй раз обязан быть тихим.
///
/// `uid` — под кем работает служба, а значит и её потомок sing-box. Пропуск
/// именно ему: иначе туннелю нечем подняться. Сторож —
/// `singbox_gets_its_pass_in_the_same_breath`.
///
/// ponytail: пропуск по uid, а не по cgroup самой службы. Под root это значит,
/// что все процессы root проходят замок — в окне до подтверждения туннеля они
/// ходят напрямую. Апгрейд — `socket cgroupv2 level 2
/// "system.slice/proxybox.service"`: systemd эту cgroup уже создал, и сужение
/// не стоит ничего, кроме проверки на живой машине.
pub fn table(on: bool, tun_name: &str, uid: u32) -> String {
    let mut script = format!("table inet {TABLE}\ndelete table inet {TABLE}\n");
    if !on {
        return script;
    }
    script.push_str(&format!(
        "table inet {TABLE} {{\n\
         \tchain output {{\n\
         \t\ttype filter hook output priority filter; policy drop;\n\
         \t\toifname \"lo\" accept\n\
         \t\tmeta skuid {uid} accept\n\
         \t\toifname \"{tun_name}\" accept\n\
         \t}}\n\
         }}\n"
    ));
    script
}

/// Подать скрипт в `nft`. Отказ идёт наружу со стандартной ошибкой самой
/// программы: она говорит, на какой строке остановилась, а строка вызова в
/// журнале только мешает — та же мысль, что у `icacls` в службе.
pub fn apply(script: &str) -> io::Result<()> {
    use std::io::Write;
    let mut child = Command::new("nft")
        .arg("-f")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    child.stdin.take().ok_or_else(|| io::Error::other("nft не принял скрипт"))?.write_all(script.as_bytes())?;
    let out = child.wait_with_output()?;
    match out.status.success() {
        true => Ok(()),
        false => Err(io::Error::other(String::from_utf8_lossy(&out.stderr).trim().to_string())),
    }
}

/// Стоит ли сейчас наш замок. Спрашивается на старте службы: она могла упасть,
/// не сняв его.
pub fn locked() -> bool {
    Command::new("nft")
        .args(["list", "table", "inet", TABLE])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Поднятые интерфейсы, похожие на чужой туннель. Два TUN в системе спорят за
/// маршрут по умолчанию, и человеку об этом надо сказать.
///
/// Читается `/sys/class/net`, а не вывод чужой программы: тот же смысл, что у
/// разбора PowerShell на Windows, но без подпроцесса и без локализации.
pub fn tunnels(ours: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir("/sys/class/net") else { return Vec::new() };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| name != ours)
        // Свой тип интерфейс называет сам: 65534 — это TUN/TAP.
        .filter(|name| {
            std::fs::read_to_string(format!("/sys/class/net/{name}/type")).is_ok_and(|t| t.trim() == "65534")
        })
        .collect()
}
```

- [ ] **Step 4: Прогнать тесты**

Run: `cargo test -p core-filter`
Expected: PASS все четыре новых.

- [ ] **Step 5: Развести фасад по платформам**

В `crates/core-filter/src/lib.rs` объявить модуль после `use`:

```rust
#[cfg(target_os = "linux")]
mod linux;
```

И развести четыре публичные функции. `set_fence` — ранний выход:

```rust
pub fn set_fence(fence: Fence, previous: Option<Fence>, tun_addr: &str, apps: &[String], browser: Option<&str>) -> io::Result<()> {
    // На Linux пропусков нет вовсе: они нужны только белому списку, а он
    // приезжает вместе с cgroup следующим подпроектом. Молчание тут
    // fail-closed — выбранное приложение остаётся без сети, а не уходит
    // напрямую.
    #[cfg(target_os = "linux")]
    {
        let _ = (fence, previous, tun_addr, apps, browser);
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        // ...существующее тело без изменений...
    }
}
```

`set_killswitch` — вся работа замка:

```rust
pub fn set_killswitch(on: bool, singbox: &Path, before: Option<&str>) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let _ = (singbox, before);
        extern "C" {
            fn geteuid() -> u32;
        }
        // Имя интерфейса приходит не сюда, а от службы — как и `tun_addr` в
        // `set_fence`: зависимостей у крейта нет намеренно. Здесь оно совпадает
        // с именем таблицы, и это не совпадение, а одно имя продукта.
        return linux::apply(&linux::table(on, "proxybox", unsafe { geteuid() }));
    }
    #[cfg(not(target_os = "linux"))]
    {
        // ...существующее тело без изменений...
    }
}
```

`policy_now` и `locked_by_us`:

```rust
pub fn policy_now() -> Option<String> {
    // Чужую политику мы не берём, значит и возвращать нечего: снятие замка —
    // это удаление своей таблицы, и машина остаётся ровно такой, какой была.
    #[cfg(target_os = "linux")]
    return None;
    #[cfg(not(target_os = "linux"))]
    {
        // ...существующее тело...
    }
}

pub fn locked_by_us() -> bool {
    #[cfg(target_os = "linux")]
    return linux::locked();
    #[cfg(not(target_os = "linux"))]
    {
        // ...существующее тело...
    }
}
```

`foreign_tunnels`:

```rust
pub fn foreign_tunnels(ours: &str) -> Vec<String> {
    #[cfg(target_os = "linux")]
    return linux::tunnels(ours);
    #[cfg(not(target_os = "linux"))]
    {
        // ...существующее тело...
    }
}
```

- [ ] **Step 6: Полная проверка**

Run: `cargo test --workspace && cargo check --workspace --target x86_64-pc-windows-msvc`
Expected: PASS обе. Существующие сторожа Windows (`the_broom_is_skipped_only_when_there_was_nothing_to_sweep`, `the_lock_gives_back_the_policy_it_found`, `the_pass_is_bound_to_the_tunnel_address`) обязаны остаться зелёными — они проверяют чистые функции, которых правка не касается.

- [ ] **Step 7: Коммит**

```bash
git add crates/core-filter/src/linux.rs crates/core-filter/src/lib.rs
git commit -m "Замок на Linux — одна таблица nftables, и чужой брандмауэр она не трогает

accept в базовой цепочке не отменяет другие цепочки на том же хуке, а drop
окончателен и обрывает обход немедленно, в какой бы таблице цепочка ни лежала.
Значит policy drop в своей таблице запирает машину, не касаясь ничего чужого,
— то есть даёт ту же семантику «блокировка сильнее разрешения», ради которой
на Windows приходится отбирать у системы политику по умолчанию.

Отсюда здесь нет трёх вещей, обязательных на Windows: возврата чужой политики,
метлы по сиротам и окна, в котором sing-box остаётся без пропуска.

Пропусков приложениям нет вовсе — они нужны белому списку, а он приезжает
следующим подпроектом. Молчание тут fail-closed: приложение без сети, а не
ушедшее напрямую."
```

---

### Task 5: TUN на Linux

**Files:**
- Modify: `crates/pg-service/src/main.rs:220-224` (`tun_enabled()`)
- Test: `crates/pg-service/src/main.rs`, `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: ничего.
- Produces: `tun_enabled()` отвечает `true` на Linux, если не выставлен `PG_TUN=0`.

`reap_orphan` в `core-tunnel` менять не надо: его ветка не-Windows уже сверяет имя через `ps` и гасит через `kill`, и на Linux это работает как есть.

- [ ] **Step 1: Написать падающий тест**

```rust
    /// TUN поднимается на обеих целевых системах, а `PG_TUN=0` по-прежнему его
    /// снимает: это ручка диагностическая, как `PG_STACK` и `PG_PPROF`, и
    /// настройкой она не продублирована.
    #[test]
    fn the_tunnel_rises_on_both_target_systems() {
        assert!(tun_allowed(true, None), "на целевой системе TUN обязан подниматься");
        assert!(!tun_allowed(true, Some("0")), "PG_TUN=0 обязан снимать TUN");
        assert!(!tun_allowed(false, None), "вне целевых систем TUN не поднимается");
    }
```

- [ ] **Step 2: Прогнать**

Run: `cargo test -p pg-service the_tunnel_rises_on_both_target_systems`
Expected: FAIL — `cannot find function tun_allowed`.

- [ ] **Step 3: Разделить `tun_enabled`**

```rust
/// TUN — только на целевых системах; в разработке хватает локального SOCKS.
fn tun_enabled() -> bool {
    tun_allowed(cfg!(windows) || cfg!(target_os = "linux"), std::env::var("PG_TUN").ok().as_deref())
}

/// Решение отдельно от окружения — чтобы его было чем проверить.
/// Сторож — `the_tunnel_rises_on_both_target_systems`.
fn tun_allowed(target: bool, pg_tun: Option<&str>) -> bool {
    target && pg_tun != Some("0")
}
```

- [ ] **Step 4: Прогнать тест**

Run: `cargo test -p pg-service the_tunnel_rises_on_both_target_systems`
Expected: PASS.

- [ ] **Step 5: Полная проверка и коммит**

Run: `cargo test --workspace && cargo check --workspace --target x86_64-pc-windows-msvc`

```bash
git add crates/pg-service/src/main.rs
git commit -m "TUN поднимается и на Linux

Конфиг sing-box платформенно нейтрален и не меняется вовсе — это и есть то,
за что заплачено одним конфигом на оба охвата. reap_orphan трогать не пришлось:
его ветка вне Windows уже сверяет имя процесса и гасит его сигналом."
```

---

### Task 6: Unit, сквозная проверка и CI

**Files:**
- Create: `installer/proxybox.service`
- Modify: `scripts/e2e.sh`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: всё из задач 1-5.
- Produces: `scripts/e2e.sh` проверяет fail-closed под root; CI гоняет его на ubuntu.

- [ ] **Step 1: Написать unit**

Создать `installer/proxybox.service`:

```ini
[Unit]
Description=proxybox — сеть выбранным приложениям только через туннель
# Замок ставится в nftables, туннель поднимается через TUN: без сети
# стартовать можно, без ядра — нет.
After=network.target
Wants=network.target

[Service]
Type=simple
ExecStart=/usr/bin/pg-service
# Права настоящие: TUN и nftables от обычного пользователя не работают.
# Урезание до CAP_NET_ADMIN — отдельным шагом после проверки на живой машине.
User=root
Restart=on-failure
RestartSec=2
# Остановка обязана быть по SIGTERM: снятие правил висит на обработчике.
# Убитая KILL служба оставит машину с запертым исходящим до следующего старта.
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Добавить в e2e проверку fail-closed**

В `scripts/e2e.sh`, перед `cleanup`, добавить определение режима, а в конец скрипта — саму проверку:

```bash
# Под root на Linux скрипт проверяет сам инвариант, а не только путь до узла:
# поднимает TUN, роняет сервер и убеждается, что наружу не уходит ничего.
# Без root проверять нечем — nftables и TUN требуют прав.
FULL=0
if [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" = "0" ] && command -v nft >/dev/null; then
  FULL=1
fi
```

И в конце файла:

```bash
if [ "$FULL" = "1" ]; then
  # Цель обязана быть непетлевой. `oifname "lo" accept` пропускает петлю всегда
  # и обязан пропускать — иначе машина теряет себя саму, — так что проверка по
  # 127.0.0.1 проходила бы и при снятом замке, то есть не проверяла бы ничего.
  # Берём собственный адрес машины: туда пакет идёт через физический интерфейс,
  # ровно тот путь, который замок и обязан рубить.
  LAN=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
  [ -n "$LAN" ] || fail "у машины нет непетлевого адреса — проверять замок не на чем"
  python3 -m http.server 18082 --bind "$LAN" --directory "$WORK" >/dev/null 2>&1 &
  sleep 1
  # Посторонний — это другой uid: служба и sing-box проходят замок по пропуску,
  # и их успех про замок не говорит ничего.
  outsider() { setpriv --reuid=nobody --regid=nogroup --clear-groups \
      curl -s --max-time 5 "http://$LAN:18082/" >/dev/null 2>&1; }

  step "контроль: при живом туннеле посторонний до цели доходит"
  # Без этой строки следующая проверка зеленела бы и от сломанного curl.
  outsider || fail "посторонний не дошёл до цели ещё до того, как замок защёлкнулся"

  step "fail-closed: сервер мёртв — наружу не уходит ничего"
  kill "$SERVER" 2>/dev/null || true
  # Три промаха подряд плюс круг: PROBE_MISSES=3, PROBE_EVERY=3 с.
  sleep 15
  ./target/debug/proxybox status | grep -q "недоступен" || fail "туннель не признан мёртвым"
  nft list table inet proxybox >/dev/null 2>&1 || fail "замок не стоит при мёртвом туннеле"
  outsider && fail "посторонний процесс достучался наружу при мёртвом туннеле"

  step "снятие замка возвращает машину"
  ./target/debug/proxybox off
  nft list table inet proxybox >/dev/null 2>&1 && fail "снятый замок оставил таблицу"
  outsider || fail "снятый замок не вернул сеть"
fi
```

- [ ] **Step 3: Прогнать e2e локально без root**

Run: `PG_SINGBOX=$(which sing-box) scripts/e2e.sh`
Expected: PASS, блок `fail-closed` пропущен (`FULL=0`). Если `sing-box` не установлен — поставить его версией из `installer/get-singbox.ps1`.

- [ ] **Step 4: Добавить job в CI**

В `.github/workflows/ci.yml` добавить job рядом с существующим:

```yaml
  linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      # Версия sing-box закреплена в установщике, и она обязана быть одна на
      # установщик и на CI: иначе CI зеленеет на версии, которой нет ни у кого.
      - name: sing-box
        run: |
          VER=$(grep -oP '(?<=\$Version = ")[^"]+' installer/get-singbox.ps1)
          curl -sL "https://github.com/SagerNet/sing-box/releases/download/v$VER/sing-box-$VER-linux-amd64.tar.gz" | tar xz
          sudo install "sing-box-$VER-linux-amd64/sing-box" /usr/local/bin/sing-box
      - run: sudo apt-get install -y nftables
      - run: cargo build
      # Под root — то есть с настоящим замком и настоящим TUN. Это первая
      # сквозная проверка инварианта, какая у продукта вообще есть.
      - run: sudo -E PG_SINGBOX=/usr/local/bin/sing-box scripts/e2e.sh
      # Оболочка вне воркспейса, и под Linux её не собирает больше никто.
      - run: sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
      - run: cargo check --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 5: Проверить синтаксис workflow**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"`
Expected: без вывода — YAML разобран.

- [ ] **Step 6: Коммит**

```bash
git add installer/proxybox.service scripts/e2e.sh .github/workflows/ci.yml
git commit -m "Unit systemd и первая сквозная проверка инварианта

Под root на Linux e2e впервые проверяет то, ради чего продукт существует:
поднимает TUN, роняет сервер и убеждается, что посторонний процесс наружу не
уходит. Проверяет именно посторонним процессом от другого uid — служба и
sing-box проходят замок по пропуску, и их успех не значит ничего.

Версия sing-box в CI берётся из установщика: закреплённая обязана быть одна,
иначе CI зеленеет на версии, которой нет ни у кого. Ровно так фатальный конфиг
и уехал в 0.3.1."
```

---

### Task 7: Документация

**Files:**
- Modify: `CLAUDE.md` (разделы «Команды», «Контракт службы», «Что легко сломать», «Стиль»)
- Modify: `docs/limitations.md`
- Modify: `docs/install.md`

- [ ] **Step 1: Пометить windows-специфичные абзацы в CLAUDE.md**

Абзацы про возврат политики, метлу и `touch_policy` в разделе «Что легко сломать» не переписывать: на Windows они верны. Добавить в конец каждого по строке вида «На Linux этого нет: замок — своя таблица nftables, и чужую политику служба не берёт (`core_filter::linux`)».

В разделе «Контракт службы» заменить описание транспорта:

```
Транспорт на Windows — только именованный канал с ACL; вне Windows —
unix-сокет `/run/proxybox/service.sock` в каталоге `0750 root:proxybox`.
Отката между ними нет ни там, ни там: на чужой платформе на том конце не
служба. Права в обоих случаях даёт членство — в «интерактивных пользователях»
на Windows, в группе `proxybox` на Linux, — и различает оно пользователя, а не
программу. Кто на том конце, служба спрашивает у канала
(`GetNamedPipeClientProcessId`) или у сокета (`SO_PEERCRED`).

Группу заводит пакет. Пока пакета нет, каталог сокета остаётся за одним root —
служба слушает, но управляет ею только root; `chgrp` на несуществующую группу
служба считает не отказом, а сообщением «пакета ещё не было».
```

Убрать упоминание порта 48291 из списка портов: остаются 48292 и 48293.

- [ ] **Step 2: Поправить счёт ponytail-комментариев**

В разделе «Стиль» найти «их четырнадцать» и заменить на «их шестнадцать»: задачи 1 и 4 завели два новых (`SO_PEERCRED` по архитектуре, пропуск sing-box по uid вместо cgroup).

Run: `grep -rn 'ponytail:' --include='*.rs' --include='*.sh' --include='*.ts' . | wc -l`
Expected: 16. Если число другое — привести `CLAUDE.md` к нему, а не наоборот.

- [ ] **Step 3: Дописать `docs/limitations.md`**

Добавить в раздел по цене ошибки, ближе к верху:

```markdown
- Белого списка на Linux пока нет: охват выбирается, но пропусков служба не
  ставит, потому что отбирать по приложению в netfilter нечем до cgroup
  (подпроект 2). Выбранное приложение остаётся при этом без сети, а не уходит
  напрямую — то есть инвариант цел, а работает только охват «весь компьютер».
- Пропуск sing-box на Linux выдан по uid службы, то есть под root его получают
  все процессы root. В окне до подтверждения туннеля они ходят напрямую.
  Сужается до cgroup самой службы (`system.slice/proxybox.service`), которую
  systemd уже создал; не сделано, пока не проверено на живой машине.
- Кто разрешает имена на Linux при поднятом туннеле, не проверено. Правило
  `hijack-dns` висит на `tun-in`, а `systemd-resolved` слушает `127.0.0.53`,
  то есть на `lo`: запрос машины под правило не подпадает, и FakeIP для него не
  работает. Наружу мимо туннеля при этом не уходит ничего — resolved ходит к
  своему upstream через `final: proxy`, — но круг по каналу на каждое имя
  вернулся, а его FakeIP и убирал.
```

- [ ] **Step 4: Дописать `docs/install.md`**

Добавить раздел про Linux: пакет ставит `pg-service` в `/usr/bin`, unit в
`/lib/systemd/system`, заводит группу `proxybox` и кладёт в неё `$SUDO_USER`;
включение — `systemctl enable --now proxybox`; состояние в `/var/lib/proxybox`.

- [ ] **Step 5: Полная проверка**

Run: `pnpm validate`
Expected: PASS. `every_line_has_its_translation` обязан остаться зелёным: новых строк для человека в этом подпроекте нет — все новые сообщения идут в `io::Error`, а не через `t()`/`tf!()`.

- [ ] **Step 6: Коммит**

```bash
git add CLAUDE.md docs/limitations.md docs/install.md
git commit -m "Доки знают про Linux

Абзацы про возврат политики и метлу не переписаны, а помечены: на Windows они
по-прежнему верны, и продукт от этого не раздваивается.

В «Чего ещё нет» три честные дыры: белого списка на Linux пока нет вовсе,
пропуск sing-box выдан по uid и под root достаётся всем процессам root, и
неизвестно, кто разрешает имена при поднятом туннеле."
```

---

## Фаза 0: проверка на живой машине

Кодом это не закрывается, и до неё «работает» не говорится. Порядок — по цене
ошибки; пункты 1-3 блокирующие.

| Пункт | Как проверить | Что означает провал |
| --- | --- | --- |
| 1. Замок запирает, не трогая чужой брандмауэр | поднять на машине с `ufw`/`firewalld`, включить приватный режим, проверить чужие правила `nft list ruleset` | вся секция «Замок» неверна |
| 2. `nft delete table` возвращает как было | снимок `nft list ruleset` до и после | нужен возврат политики, то есть вся windows-машинерия |
| 3. Кто разрешает имена и ловится ли это на `tun-in` | новое имя при поднятом туннеле; искать `hijack-dns` в `singbox.log` | выбрать один из трёх кандидатов в спеке |
| 4. `auto_route` sing-box не спорит с нашей таблицей | туннель поднимается и проба проходит | пропуск по uid недостаточен |
| 5. Замок рвёт живые соединения так же, как Windows | открытый `ssh` при защёлкивании | расхождение систем, надо назвать в доках |
| 6. `SO_PEERCRED` даёт pid | разрушающая команда из чужой консоли, смотреть журнал | след теряется, `note_caller` молчит |

---

## Готовность подпроекта

- [ ] `cargo test --workspace` зелёный
- [ ] `cargo check --workspace --target x86_64-pc-windows-msvc` зелёный
- [ ] `pnpm validate` зелёный
- [ ] `scripts/e2e.sh` под root на Linux проходит, включая блок fail-closed
- [ ] Пункты 1-3 фазы 0 пройдены на живой машине
- [ ] `docs/limitations.md` знает про всё, что осталось незакрытым
