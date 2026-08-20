# Сборка драйвера

Собирается только на Windows и только под WDK. На Linux недоступно ничего:
`cargo test --workspace` и `cargo check --workspace --target
x86_64-pc-windows-msvc` этот крейт не видят вовсе — он в `exclude` корневого
`Cargo.toml`. Так и задумано: красный CI там, где кода никто не менял, стоит
дороже, чем отдельная команда сборки.

## Что нужно

- [WDK или eWDK](https://learn.microsoft.com/en-us/windows-hardware/drivers/download-the-wdk);
  собирать — из developer prompt'а eWDK, иначе `wdk-build` не найдёт окружение
- Rust + MSVC Build Tools
- `cargo install cargo-wdk`

## Сборка

```powershell
cd crates\core-wfp
cargo wdk build
```

На выходе — PE, который становится драйвером после переименования в `.sys`.

## Как убедиться, что он живой

Неподписанный драйвер грузится только на машине с выключенным Secure Boot и
`bcdedit /set testsigning on` — то есть на отладочной, и никогда у человека.
Проверка минимальная и ровно та, ради которой каркас и пуст:

```powershell
sc.exe create pgwfp type= kernel binPath= C:\путь\core_wfp.sys
sc.exe start pgwfp
sc.exe stop pgwfp
sc.exe delete pgwfp
```

Загрузился и выгрузился без синего экрана — фаза 1 закрыта. `sc start`,
отвечающий «Windows не удаётся проверить цифровую подпись», означает, что
`testsigning` не включён или Secure Boot не выключен, а не что драйвер плох.

## Подпись

Для чужой машины `testsigning` не годится: нужен EV-сертификат,
учётная запись Partner Center и attestation-подпись каждой сборки. С
апрельского обновления 2026 Windows 11 24H2/25H2/26H1 и Server 2025 старой
cross-signed-подписи по умолчанию больше не доверяют. Подробнее — «Подпись» в
`docs/wfp.md`.
