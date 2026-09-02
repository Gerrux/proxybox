# Остаток подписки и обратный отсчёт — план реализации

> **Для агентов:** ОБЯЗАТЕЛЬНЫЙ ПОД-НАВЫК: выполняйте этот план по задачам через
> superpowers:subagent-driven-development (рекомендуется) или
> superpowers:executing-plans. Шаги размечены чекбоксами (`- [ ]`).

**Цель:** показать в окне остаток подписки (трафик и срок) из заголовка
`Subscription-Userinfo` и обратный отсчёт до следующей попытки поднять туннель.

**Подход:** обе половины независимы. B (отсчёт) — вычисляемое поле в `Status`,
диска не касается, идёт первым и им же проверяется, что правка контракта
доезжает до окна. A (остаток) — заголовок читается из того же ответа, где
список узлов, кладётся в `Saved` рядом с узлами тем же ключом и едет в окно
полем `Subscription`.

**Стек:** Rust (служба `pg-service`, контракт `core-ipc`, HTTP на `ureq` 3.4),
TypeScript + React + Tailwind (окно `ui/app-shell`).

**Спека:** `docs/superpowers/specs/2026-09-02-subscription-quota-and-retry-design.md`
— читайте вместе с планом, аргументация там.

## Общие ограничения

- **Язык репозитория — русский.** Комментарии, доки, сообщения коммитов, строки
  журнала и интерфейса — по-русски. Строки интерфейса дублируются в `RU` и `EN`
  словарях `ui/app-shell/src/i18n.ts`; `EN: typeof RU` не даст забыть половину.
- **Комментарии объясняют «почему», а не «что».** Шапка модуля — рационал
  целиком.
- **Правило со словом «обязан» заводится вместе со сторожем**, и абзац ссылается
  на него по имени теста. Без сторожа правило не пишется.
- **Тестов-файлов в проекте нет**: всё в `#[cfg(test)] mod tests` внутри своего
  модуля.
- **TS strict.** Наружу не уходит ничего: ни телеметрии, ни логов трафика.
- **Проверка после каждой задачи:** `pnpm validate` (это `tsc --noEmit` +
  `vite build` + `cargo test --workspace`). В задачах, трогающих Rust, ещё и
  `cargo check --workspace --target x86_64-pc-windows-msvc`.
- **`src-tauri` — отдельный Cargo-проект** (`exclude` в воркспейсе), собирается
  только на Windows. Этот план его не трогает.
- **Свежая worktree обязательна**, если ещё не в ней: `pnpm install` в новой
  worktree нужен отдельно, иначе `tsc` не найдётся.
- **Ноль значит «не прислали»** — во всех четырёх полях `Quota`. У панелей то же
  значение стоит у безлимитных и бессрочных, различать их не по чему.

---

### Задача 1: отсчёт до следующей попытки — служба

**Файлы:**
- Изменить: `crates/pg-service/src/main.rs` (помощник рядом с `free_name`,
  ветка `Request::Status` на строке 1289, тест в `mod tests`)
- Изменить: `crates/core-ipc/src/lib.rs` (`struct Status`, строка 426)

**Интерфейсы:**
- Отдаёт наружу: `Status.retry_in: Option<u32>` — секунды до следующей попытки;
  `None`, когда попытки не запланировано.
- Отдаёт задаче 2: то же поле под именем `retry_in` в JSON.

- [ ] **Шаг 1: написать падающий тест**

В `crates/pg-service/src/main.rs`, в `mod tests`, рядом с
`private_mode_survives_restart`:

```rust
    /// Отсчёт до следующей попытки не показывает ноль: «через 0 с» читается как
    /// «ничего не происходит» ровно там, где происходит ожидание. Прошедшая
    /// пауза и отсутствие паузы для окна одно и то же — круг надзора в обоих
    /// случаях возьмётся сам.
    #[test]
    fn the_retry_countdown_never_shows_zero() {
        // Отсчёт от будущего момента: у свежего процесса `Instant::now()` может
        // быть меньше вычитаемого, и `now - 5s` паникует.
        let now = Instant::now() + Duration::from_secs(60);
        assert_eq!(retry_in(None, now), None, "паузы не запланировано");
        assert_eq!(retry_in(Some(now - Duration::from_secs(5)), now), None, "пауза уже истекла");
        assert_eq!(retry_in(Some(now), now), None, "пауза истекает ровно сейчас");
        assert_eq!(
            retry_in(Some(now + Duration::from_millis(500)), now),
            Some(1),
            "полсекунды — это ещё «через секунду», а не «уже»",
        );
        assert_eq!(retry_in(Some(now + Duration::from_secs(30)), now), Some(30));
    }
```

- [ ] **Шаг 2: убедиться, что тест не собирается**

Запустить: `cargo test -p pg-service the_retry_countdown`
Ожидаемо: `error[E0425]: cannot find function retry_in in this scope`.

- [ ] **Шаг 3: написать помощник**

В `crates/pg-service/src/main.rs`, сразу после `fn free_name` (строка 864):

```rust
/// Секунды до момента `at`. Прошедшее и отсутствующее — одинаково `None`:
/// «пауза кончилась» и «паузы не было» для окна одно и то же, круг надзора в
/// обоих случаях возьмётся сам. Округление вверх, потому что «через 0 с» на
/// экране читается как «ничего не происходит» ровно тогда, когда происходит
/// ожидание. Сторож — `the_retry_countdown_never_shows_zero`.
fn retry_in(at: Option<Instant>, now: Instant) -> Option<u32> {
    let left = at?.checked_duration_since(now)?;
    if left.is_zero() {
        return None;
    }
    Some(left.as_secs() as u32 + u32::from(left.subsec_nanos() > 0))
}
```

- [ ] **Шаг 4: убедиться, что тест проходит**

Запустить: `cargo test -p pg-service the_retry_countdown`
Ожидаемо: PASS.

- [ ] **Шаг 5: завести поле в контракте**

В `crates/core-ipc/src/lib.rs`, внутри `pub struct Status` (начинается на строке
426), последним полем перед закрывающей скобкой:

```rust
    /// Сколько секунд до следующей попытки поднять туннель. `None` — попытки не
    /// запланировано: приватный режим выключен, туннель поднят, либо пауза уже
    /// истекла и круг надзора вот-вот возьмётся сам.
    ///
    /// Поле вычисляемое, а не хранимое: в службе пауза живёт как `Instant`, а он
    /// ни сериализуется, ни означает настенное время. Считается в ответе на
    /// `Status` и на диск не попадает — `Saved` собирается поимённо.
    #[serde(default)]
    pub retry_in: Option<u32>,
```

- [ ] **Шаг 6: вычислять его в ответе на `Status`**

В `crates/pg-service/src/main.rs`, ветка `Request::Status` (строка 1289).
Вставить перед `Response::Status(s.status.clone())` (строка 1305), сразу после
`s.status.browsers = s.browsers.keys().cloned().collect();`:

```rust
            // Здесь же, где прополка сеансов, и по той же причине: запомненное
            // число соврало бы через секунду. Пауза в службе — `Instant`, наружу
            // едут секунды.
            s.status.retry_in = retry_in(s.retry_at, Instant::now());
```

- [ ] **Шаг 7: проверить сборку и сторожа соседей**

Запустить: `cargo test --workspace`
Ожидаемо: всё PASS, включая `a_dead_session_takes_its_pass_with_it` — он читает
текст ветки `Request::Status` и проверяет наличие прополки, а не её точный вид.

Запустить: `cargo check --workspace --target x86_64-pc-windows-msvc`
Ожидаемо: `Finished`.

- [ ] **Шаг 8: коммит**

```bash
git add crates/pg-service/src/main.rs crates/core-ipc/src/lib.rs
git commit -m "Пауза до следующей попытки перестала быть внутренним делом службы"
```

---

### Задача 2: отсчёт до следующей попытки — окно

**Файлы:**
- Изменить: `ui/app-shell/src/platform.ts` (`export type Status`, строка 95)
- Изменить: `ui/app-shell/src/i18n.ts` (словари `RU` и `EN`)
- Изменить: `ui/app-shell/src/StatusBar.tsx` (ветка `down:`, строка 270)

**Интерфейсы:**
- Потребляет из задачи 1: `Status.retry_in: number | null`.
- Ничего наружу не отдаёт.

- [ ] **Шаг 1: тип в контракте окна**

В `ui/app-shell/src/platform.ts`, в `export type Status` (строка 95), последним
полем:

```ts
  /** Сколько секунд до следующей попытки поднять туннель. null — попытки не
   *  запланировано. */
  retry_in: number | null;
```

- [ ] **Шаг 2: строки в словарь**

В `ui/app-shell/src/i18n.ts`, в объект `RU`, сразу после
`downHintWhitelist: …`:

```ts
  // Пока sing-box не поднимается, окно показывало «доступ закрыт» и молчало:
  // перезапуск с нарастающей паузой был неотличим от намертво замершего
  // туннеля. Строка в журнале про паузу есть, но она уезжает вниз и не
  // обновляется.
  retryIn: (n: number) => `следующая попытка через ${n} с`,
```

В объект `EN`, на то же место:

```ts
  retryIn: (n: number) => `retrying in ${n} s`,
```

- [ ] **Шаг 3: показать отсчёт в ветке `down`**

В `ui/app-shell/src/StatusBar.tsx` заменить блок на строках 270–273:

```tsx
        down: {
          title: s.down,
          hint: all ? s.downHintAll : s.downHintWhitelist,
        },
```

на:

```tsx
        down: {
          title: s.down,
          // Отсчёт приписывается к подсказке охвата, а не заменяет её: «доступ
          // закрыт» — это состояние, а пауза — то, что с ним будет дальше.
          // Только здесь: в `connecting` попытка уже идёт, в `off` её нет и не
          // будет, в `up` — тем более.
          hint:
            (all ? s.downHintAll : s.downHintWhitelist) +
            (status.retry_in != null ? ` · ${s.retryIn(status.retry_in)}` : ""),
        },
```

Оговорку про пустой белый список ниже (`view.hint = …` на строке 285) **не
трогать**: она ложится поверх всех четырёх состояний и здесь главнее — если
отмечено ноль приложений, показывать надо её, а не отсчёт.

- [ ] **Шаг 4: проверить**

Запустить: `pnpm validate`
Ожидаемо: код возврата 0. Если `tsc` не находится — сначала `pnpm install`.

- [ ] **Шаг 5: коммит**

```bash
git add ui/app-shell/src/platform.ts ui/app-shell/src/i18n.ts ui/app-shell/src/StatusBar.tsx
git commit -m "Окно говорит, через сколько повторит попытку"
```

---

### Задача 3: тип остатка в контракте

**Файлы:**
- Изменить: `crates/core-ipc/src/lib.rs` (`struct Subscription`, строка 362)
- Изменить: `crates/pg-service/src/main.rs` (`subscriptions_of`, строка 848)
- Изменить: `ui/app-shell/src/platform.ts` (`export type Subscription`, строка 90)

**Интерфейсы:**
- Отдаёт задачам 4–7: `core_ipc::Quota { upload, download, total, expire }` —
  все `u64`; `Subscription.quota: Option<Quota>`.

- [ ] **Шаг 1: завести `Quota`**

В `crates/core-ipc/src/lib.rs`, сразу перед `pub struct Subscription` (строка
362):

```rust
/// Остаток по подписке, как его прислала панель заголовком
/// `Subscription-Userinfo`.
///
/// Ноль значит «не прислали». Отдельного `Option` на каждое поле нет намеренно:
/// у панелей ноль стоит и у безлимитных с бессрочными, так что различить «не
/// прислали» и «нет лимита» всё равно нечем, а четыре развилки в окне ради
/// разницы, которой нет в данных, — четыре лишние ветки.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quota {
    /// Отдано, байты.
    pub upload: u64,
    /// Принято, байты. Израсходованным панели считают сумму с `upload`.
    pub download: u64,
    /// Лимит, байты.
    pub total: u64,
    /// Когда подписка кончается, секунды с эпохи.
    pub expire: u64,
}
```

- [ ] **Шаг 2: поле в `Subscription`**

В том же файле, в `pub struct Subscription`, после `pub nodes: Vec<String>,`:

```rust
    /// Панель остатка не прислала — здесь `None`, и окно про остаток молчит.
    /// Заголовок этот у панелей необязателен, и его отсутствие — норма, а не
    /// сбой: узлы разобраны, показывать просто нечего.
    #[serde(default)]
    pub quota: Option<Quota>,
```

- [ ] **Шаг 3: починить единственное место сборки `Subscription`**

В `crates/pg-service/src/main.rs`, `subscriptions_of` (строка 848) собирает
`Subscription` литералом. Добавить в литерал:

```rust
            quota: None,
```

(Карту квот эта функция получит в задаче 6 — сейчас важно только, чтобы
собиралось.)

- [ ] **Шаг 4: тип в контракте окна**

В `ui/app-shell/src/platform.ts` заменить блок на строках 90–93:

```ts
export type Subscription = {
  url: string;
  nodes: string[];
};
```

на:

```ts
/** Остаток по подписке из заголовка `Subscription-Userinfo`. Ноль в поле значит
 *  «панель не прислала» — то же значение стоит у безлимитных и бессрочных. */
export type Quota = {
  upload: number;
  download: number;
  total: number;
  expire: number;
};

export type Subscription = {
  url: string;
  nodes: string[];
  /** null — панель остатка не прислала. */
  quota: Quota | null;
};
```

- [ ] **Шаг 5: проверить**

Запустить: `pnpm validate`
Ожидаемо: код возврата 0.

Запустить: `cargo check --workspace --target x86_64-pc-windows-msvc`
Ожидаемо: `Finished`.

- [ ] **Шаг 6: коммит**

```bash
git add crates/core-ipc/src/lib.rs crates/pg-service/src/main.rs ui/app-shell/src/platform.ts
git commit -m "В контракте появилось место под остаток подписки"
```

---

### Задача 4: разбор заголовка

**Файлы:**
- Изменить: `crates/pg-service/src/main.rs` (функция рядом с `subscriptions_of`,
  тест в `mod tests`)

**Интерфейсы:**
- Потребляет из задачи 3: `core_ipc::Quota`.
- Отдаёт задаче 6: `fn parse_userinfo(header: Option<&str>) -> Option<Quota>`.

- [ ] **Шаг 1: написать падающий тест**

В `crates/pg-service/src/main.rs`, в `mod tests`:

```rust
    /// Заголовок `Subscription-Userinfo` — де-факто стандарт панелей, а не RFC:
    /// поля необязательны, порядок произволен, пробелы встречаются, а половина
    /// панелей не шлёт его вовсе. Терпимость тут не небрежность: непонятый
    /// заголовок обязан давать «нечего показать», а не отказ импорта — узлы в
    /// том же ответе разобраны и нужны.
    #[test]
    fn a_panel_quota_is_read_from_the_header() {
        let full = parse_userinfo(Some(
            "upload=455727941; download=6603863621; total=1073741824000; expire=1673684400",
        ))
        .expect("полный заголовок разбирается");
        assert_eq!(full.upload, 455_727_941);
        assert_eq!(full.download, 6_603_863_621);
        assert_eq!(full.total, 1_073_741_824_000);
        assert_eq!(full.expire, 1_673_684_400);

        // Безлимитная подписка шлёт только расход.
        let partial = parse_userinfo(Some("upload=1; download=2")).expect("частичный заголовок");
        assert_eq!((partial.total, partial.expire), (0, 0), "непришедшее — ноль, а не отказ");

        // Пробелы и обратный порядок — та же строка.
        let messy = parse_userinfo(Some(" expire = 7 ;  total=9 ")).expect("пробелы не мешают");
        assert_eq!((messy.total, messy.expire), (9, 7));

        // Битое число и незнакомое поле пропускаются, остальное читается.
        let dirty = parse_userinfo(Some("upload=abc; download=5; reset_day=1")).expect("мусор не роняет");
        assert_eq!((dirty.upload, dirty.download), (0, 5));

        assert_eq!(parse_userinfo(None), None, "заголовка нет — это норма");
        assert_eq!(parse_userinfo(Some("хлам без знака равенства")), None, "понять нечего — молчим");
        assert_eq!(parse_userinfo(Some("upload=0; download=0")), None, "все нули показывать нечего");
    }
```

- [ ] **Шаг 2: убедиться, что тест не собирается**

Запустить: `cargo test -p pg-service a_panel_quota`
Ожидаемо: `error[E0425]: cannot find function parse_userinfo in this scope`.

- [ ] **Шаг 3: написать разбор**

В `crates/pg-service/src/main.rs`, сразу перед `fn subscriptions_of` (строка
848):

```rust
/// Разбор заголовка `Subscription-Userinfo`.
///
/// Это де-факто стандарт панелей (v2board, sspanel и производные), а не RFC,
/// поэтому терпимость тут не небрежность: поля необязательны, порядок
/// произволен, пробелы вокруг `;` и `=` встречаются, а незнакомое поле и битое
/// число — повод пропустить их, а не отказать в импорте. Заголовка нет вовсе —
/// это норма: подписка скачалась, узлы разобраны, показывать просто нечего.
///
/// Все нули дают `None` по той же причине: понять из заголовка не удалось
/// ничего, и «0 B из 0 B» в окне было бы шумом вместо ответа. Сторож —
/// `a_panel_quota_is_read_from_the_header`.
fn parse_userinfo(header: Option<&str>) -> Option<Quota> {
    let mut quota = Quota::default();
    for part in header?.split(';') {
        let Some((key, value)) = part.split_once('=') else { continue };
        let Ok(number) = value.trim().parse::<u64>() else { continue };
        match key.trim().to_ascii_lowercase().as_str() {
            "upload" => quota.upload = number,
            "download" => quota.download = number,
            "total" => quota.total = number,
            "expire" => quota.expire = number,
            _ => {}
        }
    }
    (quota != Quota::default()).then_some(quota)
}
```

`Quota` уже импортирован: файл тянет типы контракта строкой
`use core_ipc::{…}` (строка 11). Если сборка ругается на неизвестный `Quota` —
добавить его в этот список.

- [ ] **Шаг 4: убедиться, что тест проходит**

Запустить: `cargo test -p pg-service a_panel_quota`
Ожидаемо: PASS.

- [ ] **Шаг 5: коммит**

```bash
git add crates/pg-service/src/main.rs
git commit -m "Заголовок остатка подписки научились читать"
```

---

### Задача 5: достать заголовок из ответа

**Файлы:**
- Изменить: `crates/pg-service/src/main.rs` (`fetch`, строка 791; `get`, строка
  811; `subscribe`, строка 915)

**Интерфейсы:**
- Отдаёт задаче 6: `fetch(url, via_tunnel) -> Result<(String, Option<String>), String>`
  — тело ответа и сырой заголовок `Subscription-Userinfo`, если он был.

- [ ] **Шаг 1: вернуть заголовок из `get`**

В `crates/pg-service/src/main.rs` заменить сигнатуру `get` (строка 811):

```rust
fn get(url: &str, proxy: Option<&str>) -> Result<String, String> {
```

на:

```rust
fn get(url: &str, proxy: Option<&str>) -> Result<(String, Option<String>), String> {
```

и последнюю строку тела:

```rust
    agent.get(url).call().map_err(|e| fail(&e))?.body_mut().read_to_string().map_err(|e| fail(&e))
```

на:

```rust
    let mut response = agent.get(url).call().map_err(|e| fail(&e))?;
    // Заголовок снимаем до тела: `body_mut()` заимствует ответ изменяемо, и
    // после него заголовки уже не спросить. Имя регистронезависимо — за это
    // отвечает `HeaderMap`, а панели пишут его вразнобой.
    let userinfo =
        response.headers().get("subscription-userinfo").and_then(|v| v.to_str().ok()).map(str::to_string);
    let body = response.body_mut().read_to_string().map_err(|e| fail(&e))?;
    Ok((body, userinfo))
```

- [ ] **Шаг 2: пробросить через `fetch`**

В том же файле заменить сигнатуру `fetch` (строка 791):

```rust
fn fetch(url: &str, via_tunnel: bool) -> Result<String, String> {
```

на:

```rust
fn fetch(url: &str, via_tunnel: bool) -> Result<(String, Option<String>), String> {
```

Тело не меняется: обе ветки (`direct()` и поход через туннель) уже возвращают
одно и то же, поэтому `.or_else(|_| direct())` собирается как есть.

- [ ] **Шаг 3: принять кортеж в `subscribe`**

В `crates/pg-service/src/main.rs`, `subscribe` (строка 915), заменить:

```rust
    let body = match fetch(url, via_tunnel) {
        Ok(body) => body,
        Err(message) => return Response::Error { message },
    };
```

на:

```rust
    // Заголовок приезжает тем же ответом, что и список узлов. Второго запроса
    // за остатком не заводим: подписки сверяются раз в шесть часов и ещё по
    // нажатию, а лишний поход к панели — лишний повод считать нас флудом.
    let (body, userinfo) = match fetch(url, via_tunnel) {
        Ok(got) => got,
        Err(message) => return Response::Error { message },
    };
```

- [ ] **Шаг 4: проверить сборку**

Запустить: `cargo test --workspace`
Ожидаемо: всё PASS. Компилятор укажет на любой оставшийся вызов `fetch`/`get`,
ждущий одну строку.

Запустить: `cargo check --workspace --target x86_64-pc-windows-msvc`
Ожидаемо: `Finished`.

Переменная `userinfo` пока не используется — компилятор предупредит
`unused variable`. Это ожидаемо, задача 6 её и потребляет. Если сборка идёт с
`-D warnings`, временно пометить `let (body, _userinfo)` и вернуть имя в задаче 6.

- [ ] **Шаг 5: коммит**

```bash
git add crates/pg-service/src/main.rs
git commit -m "Ответ подписки отдаёт не только тело, но и заголовок остатка"
```

---

### Задача 6: хранение остатка

**Файлы:**
- Изменить: `crates/pg-service/src/main.rs` (`struct Saved` строка 102;
  `Service` рядом с полем `subscriptions`; `Service::load`; `Service::save`
  строка 366; `subscriptions_of` строка 848; `subscribe` строка 915;
  `Request::RemoveSubscription` строка 1407)

**Интерфейсы:**
- Потребляет из задачи 3: `core_ipc::Quota`, `Subscription.quota`.
- Потребляет из задачи 4: `parse_userinfo`.
- Потребляет из задачи 5: `userinfo` в `subscribe`.
- Отдаёт задаче 7: заполненное `Subscription.quota` в `Status`.

- [ ] **Шаг 1: поле на диске**

В `crates/pg-service/src/main.rs`, в `struct Saved` (строка 102), после блока
`subscriptions`:

```rust
    /// Адрес подписки → остаток, который панель прислала последней сверкой.
    /// Ключ тот же, что у `subscriptions`.
    ///
    /// Хранится на диске, а не в памяти процесса: остаток приходит только со
    /// сверкой, а сверка — раз в шесть часов. Без этого окно показывало бы
    /// пустоту от старта службы до первого круга, то есть почти всегда.
    #[serde(default)]
    quotas: BTreeMap<String, Quota>,
```

- [ ] **Шаг 2: поле в состоянии службы**

В том же файле, в `struct Service`, рядом с полем `subscriptions`:

```rust
    quotas: BTreeMap<String, Quota>,
```

В `Service::load`, в литерале `Service { … }`, рядом с
`subscriptions: saved.subscriptions,`:

```rust
            quotas: saved.quotas,
```

В `Service::save` (строка 366), в литерале `Saved { … }`, рядом с
`subscriptions: self.subscriptions.clone(),`:

```rust
            quotas: self.quotas.clone(),
```

- [ ] **Шаг 3: отдать остаток в статус**

Заменить сигнатуру `subscriptions_of` (строка 848):

```rust
fn subscriptions_of(map: &BTreeMap<String, Vec<String>>, profiles: &BTreeMap<String, Value>) -> Vec<Subscription> {
```

на:

```rust
fn subscriptions_of(
    map: &BTreeMap<String, Vec<String>>,
    profiles: &BTreeMap<String, Value>,
    quotas: &BTreeMap<String, Quota>,
) -> Vec<Subscription> {
```

и в литерале `Subscription` заменить `quota: None,` (его положила задача 3) на:

```rust
            quota: quotas.get(url).cloned(),
```

Компилятор укажет два вызова `subscriptions_of` — в `Service::load` и в
`Service::save` (строка 368). В обоих добавить третьим аргументом карту квот:
`&saved.quotas` в `load`, `&self.quotas` в `save`.

- [ ] **Шаг 4: класть остаток при сверке**

В `subscribe` (строка 915), сразу после строки
`s.subscriptions.insert(url.to_string(), names);`:

```rust
    // Остаток кладём рядом с узлами и тем же ключом: пришли они одним ответом.
    // Панель заголовка не прислала — прежнее число убираем, а не оставляем: оно
    // тем более не свежее, чем список, который только что заменили целиком.
    match parse_userinfo(userinfo.as_deref()) {
        Some(quota) => {
            s.quotas.insert(url.to_string(), quota);
        }
        None => {
            s.quotas.remove(url);
        }
    }
```

- [ ] **Шаг 5: убирать остаток вместе с подпиской**

В ветке `Request::RemoveSubscription` (строка 1407), в рукаве `Some(names) =>`,
первой строкой перед циклом `for name in &names`:

```rust
                // Осиротевшая запись была бы невидима (`subscriptions_of` идёт
                // по узлам), но копилась бы на диске вечно.
                s.quotas.remove(&url);
```

- [ ] **Шаг 6: проверить**

Запустить: `cargo test --workspace`
Ожидаемо: всё PASS, включая `private_mode_survives_restart` — он гоняет
`save()`/`load()` через настоящий файл и поймал бы несобирающееся или
несохраняющееся поле.

Запустить: `cargo check --workspace --target x86_64-pc-windows-msvc`
Ожидаемо: `Finished`.

- [ ] **Шаг 7: коммит**

```bash
git add crates/pg-service/src/main.rs
git commit -m "Остаток подписки переживает перезапуск службы"
```

---

### Задача 7: остаток в окне

**Файлы:**
- Изменить: `ui/app-shell/src/i18n.ts` (словари `RU` и `EN`)
- Изменить: `ui/app-shell/src/Profiles.tsx` (импорты; функция рядом с `sniff`;
  `<summary>` подписки, строка ~211)

**Интерфейсы:**
- Потребляет из задачи 6: `Subscription.quota: Quota | null`.

- [ ] **Шаг 1: строки в словарь**

В `ui/app-shell/src/i18n.ts`, в объект `RU`, рядом с остальными строками
подписок:

```ts
  // Остаток по подписке: трафик и срок. До сих пор их не показывали вовсе, и
  // человек узнавал про них в тот момент, когда перестало работать.
  quotaOf: (used: string, total: string) => `${used} из ${total}`,
  quotaUntil: (date: string) => `до ${date}`,
  quotaExpired: "подписка кончилась",
  quotaHint: "Остаток по подписке, как его прислала панель последней сверкой.",
```

В объект `EN`, на то же место:

```ts
  quotaOf: (used: string, total: string) => `${used} of ${total}`,
  quotaUntil: (date: string) => `until ${date}`,
  quotaExpired: "subscription has expired",
  quotaHint: "The subscription balance as the panel reported it at the last sync.",
```

- [ ] **Шаг 2: импорты в `Profiles.tsx`**

В `ui/app-shell/src/Profiles.tsx` заменить строки 1–5:

```tsx
import { useState } from "react";
import type { Act, Probe, Status } from "./platform";
import type { Strings } from "./i18n";
import { measuredAgo, strings, syncedAgo } from "./i18n";
import { AddField, Button, ConfirmButton, Empty, flag, Panel, SearchField } from "./ui";
```

на:

```tsx
import { useState } from "react";
import type { Act, Lang, Probe, Quota, Status } from "./platform";
import type { Strings } from "./i18n";
import { measuredAgo, strings, syncedAgo } from "./i18n";
import { bytes } from "./StatusBar";
import { AddField, Button, ConfirmButton, Empty, flag, Panel, SearchField } from "./ui";
```

`bytes` уже экспортирован из `StatusBar.tsx` (строка 24) и оттуда же его берёт
панель соединений — второй такой же форматтер разошёлся бы с этим на первом
округлении.

- [ ] **Шаг 3: завести строку остатка**

Компонентом, а не функцией с вызовом в JSX: считать текст надо после проверки на
«нечего показать», а `<summary>` — выражение, и промежуточной переменной там
негде жить.

В `ui/app-shell/src/Profiles.tsx`, сразу после функции `sniff` (она кончается
перед комментарием `/** Со скольких профилей список перестаёт читаться глазом.`):

```tsx
/** Остаток по подписке: сколько израсходовано из лимита и до какого числа.
 *
 *  Ноль в поле значит «панель не прислала», и то же значение стоит у
 *  безлимитных с бессрочными, — поэтому про непришедшее просто молчим, а не
 *  пишем «0 B из 0 B». Понять нечего вовсе — не рисуем ничего.
 *
 *  Израсходовано — это `upload + download`: панели считают их вместе, и два
 *  числа порознь тут никому не нужны.
 *
 *  Тревога двойная и по разным осям: осталось меньше десятой части лимита или
 *  меньше трёх суток до срока. Тон при этом `wait`, а не `fault`: это
 *  предупреждение, а не поломка, и красный тут обещал бы сработавшую защиту.
 *  Красный остаётся истёкшему сроку — он уже объясняет, почему узлы молчат. */
function Remaining({ s, quota, lang }: { s: Strings; quota: Quota; lang: Lang | undefined }) {
  const used = quota.upload + quota.download;
  const parts: string[] = [];
  if (quota.total > 0) parts.push(s.quotaOf(bytes(used), bytes(quota.total)));
  else if (used > 0) parts.push(bytes(used));
  const days = quota.expire > 0 ? (quota.expire * 1000 - Date.now()) / 86_400_000 : null;
  if (days != null) {
    parts.push(
      days < 0 ? s.quotaExpired : s.quotaUntil(new Date(quota.expire * 1000).toLocaleDateString(lang ?? "ru")),
    );
  }
  if (parts.length === 0) return null;
  const low = quota.total > 0 && quota.total - used < quota.total / 10;
  const tone =
    days != null && days < 0 ? "text-fault" : low || (days != null && days < 3) ? "text-wait" : "text-muted";
  return (
    <span
      title={s.quotaHint}
      className={`shrink-0 font-sans text-[11px] font-normal normal-case tracking-normal ${tone}`}
    >
      {parts.join(" · ")}
    </span>
  );
}
```

- [ ] **Шаг 4: донести остаток до группы**

Группы уже собираются из подписок — остаток кладётся туда же, тем же движением,
и искать его в `<summary>` по адресу не приходится. В
`ui/app-shell/src/Profiles.tsx` заменить блок `const groups = [ … ];` (строка
~93):

```tsx
  const groups = [
    { url: null, names: profiles.filter((name) => !fromSubs.has(name) && match(name)), quota: null },
    ...subscriptions.map((sub) => ({ url: sub.url, names: sub.nodes.filter(match), quota: sub.quota })),
  ];
```

Своя группа остатка не имеет и иметь не может: она про узлы, заведённые руками,
и панели за ними нет.

- [ ] **Шаг 5: показать её в шапке группы**

В том же файле в разборе группы заменить `groups.map(` и его параметр (строка
~187):

```tsx
          groups.map(
            ({ url, names }) =>
```

на:

```tsx
          groups.map(
            ({ url, names, quota }) =>
```

Затем найти в `<summary>` счётчик узлов (строка ~227):

```tsx
                    <span className="shrink-0 font-sans text-[11px] font-normal normal-case tracking-normal">
                      {names.length}
                    </span>
```

и вставить **перед** ним:

```tsx
                    {/* Остаток стоит `shrink-0`, а обрезается адрес: остаток
                        короткий и постоянной длины, а схема с хвостом адреса —
                        длинная. Живёт он в <summary>, а не под ним: в свёрнутом
                        виде это единственное место, где его вообще видно, а
                        свёрнуты подписки как раз чаще всего. */}
                    {quota && <Remaining s={s} quota={quota} lang={status?.lang} />}
```

- [ ] **Шаг 6: проверить**

Запустить: `pnpm validate`
Ожидаемо: код возврата 0.

- [ ] **Шаг 7: коммит**

```bash
git add ui/app-shell/src/i18n.ts ui/app-shell/src/Profiles.tsx
git commit -m "Подписка показывает, сколько осталось и до какого числа"
```

---

## Итоговая проверка

- [ ] `pnpm validate` — код возврата 0
- [ ] `cargo check --workspace --target x86_64-pc-windows-msvc` — `Finished`
- [ ] `cargo test -p pg-service the_retry_countdown a_panel_quota` — оба PASS
- [ ] Раздел README «Чего ещё нет» не трогать: этот заход ни одного пункта
      оттуда не закрывает.

## Что осталось непроверенным

Заголовок `Subscription-Userinfo` не снят с живой панели — форма взята из
экосистемы. При первой живой подписке посмотреть, что приходит на самом деле, и
дописать образец в `a_panel_quota_is_read_from_the_header`. Терпимость разбора
заведена ровно на этот случай: незнакомая форма даёт «нечего показать», а не
отказ импорта.
