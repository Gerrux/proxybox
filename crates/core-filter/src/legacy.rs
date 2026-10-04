//! Эпоха netsh: всё, что осталось от замка, когда он был политикой брандмауэра.
//!
//! Живого пути здесь нет — стену теперь ставит WFP (`wfp.rs`). Остался разовый
//! уход: машина, на которой стояла прошлая версия, хранит в брандмауэре наши
//! разрешающие правила и, что хуже, `blockoutbound` в политике по умолчанию.
//! Правила переживают и перезагрузку, и переустановку; политика — тем более.
//! `migrate` снимает то и другое, возвращая политику, какой её нашёл замок.
//!
//! Модуль собирается и под тестами на любой платформе (чистая сборка команд
//! проверяется без единого системного вызова), а системные вызовы — только на
//! Windows.

#[cfg(windows)]
use std::io;

/// Общее начало имени у всех наших правил эпохи netsh: по нему и только по нему
/// они снимаются.
const RULE_PREFIX: &str = "proxybox: ";

/// Тот же префикс до переименования продукта. Метла обязана мести и его: правила
/// брандмауэра переживают переустановку, а сирота — это молчаливый пропуск в
/// туннель для приложения, которое человек из списка уже убрал. Сторож —
/// `the_broom_sweeps_the_old_name_too`.
const LEGACY_RULE_PREFIX: &str = "Privacy Gateway: ";

/// Разрешение для sing-box, каким его ставила прошлая версия, и его двойник
/// под прежним именем продукта. Наличие любого из них — признак, что на машине
/// стоял замок эпохи netsh.
const ALLOW_RULE: &str = "proxybox: sing-box";
const LEGACY_ALLOW_RULE: &str = "Privacy Gateway: sing-box";

fn sweep_mask() -> String {
    format!("{RULE_PREFIX}*")
}

/// Снять все наши правила по маске имени, а не по списку путей: путь между
/// постановкой и снятием успевает сменить написание, и правило по имени уже не
/// находится. Теперь метёт и разрешение для sing-box — стены на его месте уже
/// нет, ничьей сети оно не охраняет, а оставленное разрешало бы чужой уже
/// бинарник.
fn sweep_command() -> String {
    format!(
        "Get-NetFirewallRule -DisplayName '{}','{}*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule",
        sweep_mask(),
        LEGACY_RULE_PREFIX
    )
}

/// Профили брандмауэра и действия политики — списками, и списки закрытые.
/// Строка политики лежала в `state.json`, который правят руками, а обратно
/// уезжает в команду PowerShell: незакрытый список подставлял бы туда что
/// угодно.
const PROFILES: [&str; 3] = ["Domain", "Private", "Public"];
const ACTIONS: [&str; 3] = ["Allow", "Block", "NotConfigured"];

/// Разбор одной записи «профиль=входящее/исходящее». `None` — запись не наша.
fn entry(line: &str) -> Option<(&str, &str, &str)> {
    let (name, actions) = line.split_once('=')?;
    let (inbound, outbound) = actions.split_once('/')?;
    let known = PROFILES.contains(&name) && ACTIONS.contains(&inbound) && ACTIONS.contains(&outbound);
    known.then_some((name, inbound, outbound))
}

fn parse<'a>(lines: impl Iterator<Item = &'a str>) -> Option<Vec<(&'a str, &'a str, &'a str)>> {
    let mut out = Vec::new();
    for line in lines.map(str::trim).filter(|l| !l.is_empty()) {
        out.push(entry(line)?);
    }
    (!out.is_empty()).then_some(out)
}

/// Команда, возвращающая политику к той, что стояла до замка. Профили порознь —
/// ровно то, чего не умеет `netsh set allprofiles`. Всё или ничего: половина
/// политики хуже никакой — вернув два профиля из трёх, мы оставили бы третий
/// без сети.
fn restore_command(saved: &str) -> Option<String> {
    let parts = parse(saved.split(';'))?;
    Some(
        parts
            .into_iter()
            .map(|(name, inbound, outbound)| {
                format!("Set-NetFirewallProfile -Name {name} -DefaultInboundAction {inbound} -DefaultOutboundAction {outbound}")
            })
            .collect::<Vec<_>>()
            .join("; "),
    )
}

fn policy_args(outbound: &str) -> Vec<String> {
    vec!["advfirewall".into(), "set".into(), "allprofiles".into(), "firewallpolicy".into(), format!("blockinbound,{outbound}")]
}

#[cfg(windows)]
fn powershell(command: &str) {
    let _ = std::process::Command::new("powershell").args(["-NoProfile", "-Command", command]).output();
}

/// С ответом «получилось ли»: на возврате политики молчание вместо ошибки
/// означало бы машину, оставшуюся с запертым исходящим.
#[cfg(windows)]
fn powershell_ok(command: &str) -> bool {
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", command])
        .output()
        .is_ok_and(|o| o.status.success())
}

/// Стоит ли правило с таким именем. `netsh … show rule` отвечает кодом
/// выхода, а не локализованным текстом.
#[cfg(windows)]
fn rule_exists(name: &str) -> bool {
    std::process::Command::new("netsh")
        .args(["advfirewall", "firewall", "show", "rule"])
        .arg(format!("name={name}"))
        .output()
        .is_ok_and(|o| o.status.success())
}

/// Разовый уход от эпохи netsh. `saved` — политика, которую прошлая версия
/// хранила в `state.json`. Звать надо уже после того, как стена WFP стоит:
/// тогда машина в этот момент не остаётся без замка.
///
/// Без следов и без сохранённой политики — ровно два вопроса netsh и больше
/// ничего.
#[cfg(windows)]
pub(crate) fn migrate(saved: Option<&str>) -> io::Result<bool> {
    let marked = saved.is_some() || rule_exists(ALLOW_RULE) || rule_exists(LEGACY_ALLOW_RULE);
    if !marked {
        return Ok(false);
    }
    // Сначала политика, потом метла: sing-box ещё может понадобиться своё
    // разрешение, пока `blockoutbound` не снят. Запасной путь обязателен и
    // обязан быть именно таким: машина с запертым исходящим — это машина без
    // сети вообще, а потерянная настройка рядом с этим не стоит ничего.
    if !saved.and_then(restore_command).is_some_and(|c| powershell_ok(&c)) {
        let out = std::process::Command::new("netsh").args(policy_args("allowoutbound")).output()?;
        if !out.status.success() {
            return Err(io::Error::other(String::from_utf8_lossy(&out.stdout).trim().to_string()));
        }
    }
    powershell(&sweep_command());
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Замок эпохи netsh менял политику всей машины, а значит уход обязан
    /// вернуть её такой, какой взял: своя настройка исходящего у человека
    /// бывает, и заменить её умолчанием Windows — потеря, которую он заметит
    /// месяцем позже и не свяжет с нами.
    ///
    /// Три вещи важнее круга: половину политики возвращать нельзя (два профиля
    /// из трёх означают третий без сети), непонятую строку возвращать нельзя
    /// вовсе (она едет в команду PowerShell, а лежит в файле, который правят
    /// руками), и профили обязаны возвращаться порознь.
    #[test]
    fn the_lock_gives_back_the_policy_it_found() {
        let saved = "Domain=Block/Allow;Private=Block/Allow;Public=Block/Block";
        let command = restore_command(saved).expect("политику обязаны вернуть");
        for profile in PROFILES {
            assert!(command.contains(&format!("-Name {profile} ")), "профиль {profile} не возвращается");
        }
        assert!(
            command.contains("-Name Public -DefaultInboundAction Block -DefaultOutboundAction Block"),
            "профили обязаны возвращаться порознь, а не все одним значением: {command}"
        );

        // Своя настройка человека — тот же `Block` на исходящем: уход обязан
        // её сохранить, а не снять чужой kill-switch.
        let mine = "Domain=Block/Block;Private=Block/Block;Public=Block/Block";
        assert!(restore_command(mine).unwrap().contains("-DefaultOutboundAction Block"));

        // Всё или ничего.
        assert_eq!(restore_command("Domain=Block/Allow;Зона=Блок/Разрешить"), None, "половина политики хуже никакой");
        assert_eq!(restore_command(""), None, "пустая строка — это не политика");
        assert_eq!(restore_command("Domain=Block/Allow;мусор"), None);
        assert_eq!(restore_command("Domain=Block/Wide-Open"), None, "действие не из списка");

        // И то, ради чего список закрыт: строка из `state.json` попадает в
        // команду PowerShell целиком.
        assert_eq!(restore_command("Domain=Block/Allow; Remove-Item C:\\ -Recurse"), None, "подстановка в команду");
        assert_eq!(restore_command("Domain=Block/Allow`; calc"), None);

        // Запасной путь — умолчание Windows.
        assert_eq!(policy_args("allowoutbound").last().unwrap(), "blockinbound,allowoutbound");
    }

    /// Переименование продукта не отменяет правил, поставленных под старым
    /// именем: они лежат в брандмауэре и переживают и перезагрузку, и
    /// переустановку. Метла обязана снимать оба префикса, пока на свете есть
    /// хоть одна машина с прошлой установкой.
    #[test]
    fn the_broom_sweeps_the_old_name_too() {
        let cmd = sweep_command();
        assert!(cmd.contains(&format!("'{LEGACY_RULE_PREFIX}*'")), "метла не метёт старое имя: {cmd}");
        assert!(cmd.contains(&format!("'{}'", sweep_mask())), "метла не метёт своё же имя: {cmd}");
        assert!(!cmd.contains('\n'), "PowerShell получает команду одним аргументом: {cmd}");
    }

    /// Разрешение для sing-box под маску подходит, и теперь метла его
    /// забирает: стена на его месте не стоит на политике, и оставленное
    /// разрешение разрешало бы то, что человек уже не просит.
    #[test]
    fn the_broom_takes_the_singbox_rule_too() {
        assert!(ALLOW_RULE.starts_with(RULE_PREFIX));
        assert!(LEGACY_ALLOW_RULE.starts_with(LEGACY_RULE_PREFIX));
        assert!(!sweep_command().contains("-ne"), "обхода у метлы больше нет: {}", sweep_command());
    }
}
