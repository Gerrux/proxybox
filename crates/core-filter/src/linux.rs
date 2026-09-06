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
//! Пропусков выбранным приложениям здесь нет вовсе: отбирать по приложению
//! нечем до cgroup, а она приезжает следующим подпроектом. До тех пор белый
//! список на Linux неотличим от охвата «весь компьютер» — правило `oifname
//! "<tun>" accept` выдаёт туннель всем процессам без разбора, и в туннель идут
//! все. Инвариант это не нарушает: мимо туннеля по-прежнему не уходит никто,
//! напрямую не ходит ни один процесс — просто внутри туннеля пока нет
//! перегородки между выбранными и остальными.

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
