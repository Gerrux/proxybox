//! Стена в пользовательском WFP (`fwpuclnt`): единственное место крейта с
//! unsafe. Сюда приходит готовый желаемый набор из `wall.rs`, а здесь он
//! приводится к виду, в котором стоит в ядре.
//!
//! Направления. Стена закрыта в обе стороны: фильтры стоят на
//! `ALE_AUTH_CONNECT_V4/V6` (исходящие) и на `ALE_AUTH_RECV_ACCEPT_V4/V6`
//! (входящие). Без второго невыбранное приложение с разрешающим входящим
//! правилом Windows Firewall (торрент, игровой сервер) принимало бы пиров на
//! физической карте и обменивалось данными мимо туннеля. Цена названа в
//! `wall.rs`: под замком к машине не достучаться ни по RDP, ни по SSH.
//!
//! Арбитраж. Фильтры брандмауэра Windows (MPSSVC) лежат в своих подслоях, наши —
//! в своём. Между подслоями побеждает запрет: если хоть один подслой решил
//! «блокировать», разрешения в других его не отменяют (если разрешение не
//! «жёсткое», а мы и MPSSVC таких не ставим). Поэтому запрет в нашем подслое
//! сильнее любых разрешающих правил Windows Firewall — а их на машине сотни,
//! и именно они раньше открывали замок политики по умолчанию. Вес подслоя
//! (0xFFFF) на исход не влияет, он лишь ставит нас первыми в очереди разбора.
//!
//! Постоянство. Провайдер, подслой и фильтры — `PERSISTENT`, сессия — не
//! динамическая. Динамические фильтры уходят вместе с процессом, то есть
//! упавшая служба открывала бы сеть: fail-open. Постоянные переживают и
//! падение, и перезагрузку, как переживала политика netsh. Цена — снятие
//! только явное: `apply` с пустым набором или `forget`.
//!
//! Транзакция. Все изменения одним `FwpmTransactionBegin0`…`Commit0`: окна без
//! пропусков между постановкой запрета и постановкой разрешений не бывает, а на
//! ошибке откатывается всё, и WFP никогда не содержит частичного набора.
//! Исключение одно и намеренное: путь, который WFP не перевёл в идентификатор
//! приложения, выпадает из набора вместе со своим пропуском ещё до транзакции
//! (`wall::split`) — иначе один кривой путь в списке не давал бы встать замку.
//! Неизменившиеся фильтры не трогаются: добавление и снятие фильтров на
//! `ALE_AUTH_CONNECT` переавторизует живые потоки.
//!
//! Ключи детерминированные (`wall::rule`): личность фильтра — ключ, сравнение
//! набора в ядре с желаемым идёт по ним.

use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::io;
use std::ptr::null_mut;

use windows::core::{GUID, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    FWP_E_ALREADY_EXISTS, FWP_E_FILTER_NOT_FOUND, FWP_E_NOT_FOUND, FWP_E_PROVIDER_NOT_FOUND, FWP_E_SUBLAYER_NOT_FOUND, HANDLE,
};
use windows::Win32::NetworkManagement::WindowsFilteringPlatform::*;
use windows::Win32::System::Rpc::RPC_C_AUTHN_WINNT;

use crate::wall::{self, Action, Cond, Layer, Rule};

const ERR_ALREADY_EXISTS: u32 = FWP_E_ALREADY_EXISTS.0 as u32;
/// «Нет такого объекта» у WFP — не один код, а свой на каждый род объекта:
/// провайдер, подслой, фильтр, и общий `FWP_E_NOT_FOUND` рядом. Первый же
/// живой прогон (Windows Sandbox, 2026-10-04) ответил на поиск провайдера на
/// чистой машине `0x80320005`, а не общим кодом, — и служба с выключенным
/// приватным режимом писала «правила не поставлены» на каждом круге, не
/// запоминала применённое и потому не доходила до переноса со старого netsh.
/// Сторож — `every_kind_of_absence_is_absence`.
fn absent(code: u32) -> bool {
    [FWP_E_NOT_FOUND, FWP_E_PROVIDER_NOT_FOUND, FWP_E_SUBLAYER_NOT_FOUND, FWP_E_FILTER_NOT_FOUND]
        .iter()
        .any(|e| e.0 as u32 == code)
}

fn fail(func: &str, code: u32) -> io::Error {
    io::Error::other(format!("WFP {func}: 0x{code:08X}"))
}

fn check(func: &str, code: u32) -> io::Result<()> {
    match code {
        0 => Ok(()),
        c => Err(fail(func, c)),
    }
}

/// Строка в UTF-16 с нулём: WFP читает имена до нуля, а владеем ими мы.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn layer_guid(l: Layer) -> GUID {
    match l {
        Layer::V4 => FWPM_LAYER_ALE_AUTH_CONNECT_V4,
        Layer::V6 => FWPM_LAYER_ALE_AUTH_CONNECT_V6,
        Layer::RecvV4 => FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4,
        Layer::RecvV6 => FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6,
    }
}

/// Открытый движок. Закрывается в Drop: незакрытый дескриптор держит RPC.
struct Engine(HANDLE);

impl Engine {
    fn open() -> io::Result<Engine> {
        let mut name = wide("proxybox");
        // Сессия не динамическая (flags = 0): см. шапку модуля.
        let mut session = FWPM_SESSION0::default();
        session.displayData.name = PWSTR(name.as_mut_ptr());
        let mut h = HANDLE::default();
        // SAFETY: session и name живут до конца вызова, h — наш выходной.
        let rc = unsafe { FwpmEngineOpen0(PCWSTR::null(), RPC_C_AUTHN_WINNT, None, Some(&session), &mut h) };
        check("FwpmEngineOpen0", rc)?;
        Ok(Engine(h))
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // SAFETY: дескриптор получен от FwpmEngineOpen0 и закрывается один раз.
        unsafe { FwpmEngineClose0(self.0) };
    }
}

/// Транзакция, откатываемая в Drop, если её не зафиксировали.
struct Txn<'a> {
    engine: &'a Engine,
    done: bool,
}

impl<'a> Txn<'a> {
    fn begin(engine: &'a Engine) -> io::Result<Txn<'a>> {
        // SAFETY: дескриптор живого движка.
        check("FwpmTransactionBegin0", unsafe { FwpmTransactionBegin0(engine.0, 0) })?;
        Ok(Txn { engine, done: false })
    }

    fn commit(mut self) -> io::Result<()> {
        // SAFETY: см. begin.
        check("FwpmTransactionCommit0", unsafe { FwpmTransactionCommit0(self.engine.0) })?;
        self.done = true;
        Ok(())
    }
}

impl Drop for Txn<'_> {
    fn drop(&mut self) {
        if !self.done {
            // SAFETY: транзакция открыта нами и не зафиксирована.
            unsafe { FwpmTransactionAbort0(self.engine.0) };
        }
    }
}

/// Идентификаторы приложений, выданные WFP. Блобы принадлежат WFP и живут,
/// пока их не освободили, — а освобождаются они ровно здесь, в Drop, после того
/// как `FwpmFilterAdd0` закончил с указателями.
struct AppIds(HashMap<String, *mut FWP_BYTE_BLOB>);

impl AppIds {
    /// Идентификаторы всех путей набора и отказы (путь → код). Отказ на одном
    /// пути не прерывает остальные: что из него следует, решает `wall::split`.
    fn resolve(rules: &[Rule]) -> (AppIds, HashMap<String, u32>) {
        let mut ids = AppIds(HashMap::new());
        let mut refused = HashMap::new();
        for path in rules.iter().flat_map(Rule::apps) {
            if ids.0.contains_key(path) || refused.contains_key(path) {
                continue;
            }
            let w = wide(path);
            let mut blob: *mut FWP_BYTE_BLOB = null_mut();
            // SAFETY: w — строка с нулём, blob — выходной указатель.
            let rc = unsafe { FwpmGetAppIdFromFileName0(PCWSTR(w.as_ptr()), &mut blob) };
            match rc {
                0 => {
                    ids.0.insert(path.to_string(), blob);
                }
                code => {
                    refused.insert(path.to_string(), code);
                }
            }
        }
        (ids, refused)
    }
}

impl Drop for AppIds {
    fn drop(&mut self) {
        for blob in self.0.values_mut() {
            // SAFETY: блоб выдан FwpmGetAppIdFromFileName0 и освобождается один раз.
            unsafe { FwpmFreeMemory0(blob as *mut *mut FWP_BYTE_BLOB as *mut *mut c_void) };
        }
    }
}

/// Условия одного фильтра в виде, который ест WFP. Указатели в
/// `FWP_CONDITION_VALUE0` (блоб приложения) ведут в `AppIds`, который живёт
/// дольше вызова `FwpmFilterAdd0`; остальные значения лежат в самой структуре.
// Поля союза присваиваются по ветке, инициализатором их не выразить.
#[allow(clippy::field_reassign_with_default)]
fn conditions(rule: &Rule, ids: &AppIds) -> Vec<FWPM_FILTER_CONDITION0> {
    rule.conds
        .iter()
        .map(|c| {
            let mut v = FWPM_FILTER_CONDITION0::default();
            v.matchType = FWP_MATCH_EQUAL;
            match c {
                Cond::App(p) => {
                    v.fieldKey = FWPM_CONDITION_ALE_APP_ID;
                    v.conditionValue.r#type = FWP_BYTE_BLOB_TYPE;
                    v.conditionValue.Anonymous.byteBlob = ids.0[p.as_str()];
                }
                Cond::Loopback => {
                    v.fieldKey = FWPM_CONDITION_FLAGS;
                    v.matchType = FWP_MATCH_FLAGS_ALL_SET;
                    v.conditionValue.r#type = FWP_UINT32;
                    v.conditionValue.Anonymous.uint32 = FWP_CONDITION_FLAG_IS_LOOPBACK;
                }
                Cond::LocalAddr(a) => {
                    v.fieldKey = FWPM_CONDITION_IP_LOCAL_ADDRESS;
                    v.conditionValue.r#type = FWP_UINT32;
                    // WFP хранит v4-адрес числом в порядке хоста.
                    v.conditionValue.Anonymous.uint32 = u32::from(*a);
                }
                Cond::Proto(n) => {
                    v.fieldKey = FWPM_CONDITION_IP_PROTOCOL;
                    v.conditionValue.r#type = FWP_UINT8;
                    v.conditionValue.Anonymous.uint8 = *n;
                }
                Cond::LocalPort(n) | Cond::IcmpType(n) => {
                    // FWPM_CONDITION_ICMP_TYPE — это то же поле, что локальный порт.
                    v.fieldKey = FWPM_CONDITION_IP_LOCAL_PORT;
                    v.conditionValue.r#type = FWP_UINT16;
                    v.conditionValue.Anonymous.uint16 = *n;
                }
                Cond::RemotePort(n) => {
                    v.fieldKey = FWPM_CONDITION_IP_REMOTE_PORT;
                    v.conditionValue.r#type = FWP_UINT16;
                    v.conditionValue.Anonymous.uint16 = *n;
                }
            }
            v
        })
        .collect()
}

/// Есть ли наш провайдер. Без него нечего ни читать, ни снимать — и перечисление
/// фильтров по несуществующему провайдеру не стоит на это ставки.
fn provider_exists(e: &Engine) -> io::Result<bool> {
    let key = GUID::from_u128(wall::PROVIDER);
    let mut p: *mut FWPM_PROVIDER0 = null_mut();
    // SAFETY: key и p живы на время вызова.
    match unsafe { FwpmProviderGetByKey0(e.0, &key, &mut p) } {
        0 => {
            // SAFETY: p выдан WFP.
            unsafe { FwpmFreeMemory0(&mut p as *mut *mut FWPM_PROVIDER0 as *mut *mut c_void) };
            Ok(true)
        }
        c if absent(c) => Ok(false),
        c => Err(fail("FwpmProviderGetByKey0", c)),
    }
}

/// Добавить провайдер и подслой, если их нет. «Уже есть» — не ошибка:
/// постоянные объекты переживают службу.
fn ensure_scaffold(e: &Engine) -> io::Result<()> {
    let mut name = wide("proxybox");
    let provider = FWPM_PROVIDER0 {
        providerKey: GUID::from_u128(wall::PROVIDER),
        displayData: FWPM_DISPLAY_DATA0 { name: PWSTR(name.as_mut_ptr()), description: PWSTR::null() },
        flags: FWPM_PROVIDER_FLAG_PERSISTENT,
        ..Default::default()
    };
    // SAFETY: структура и name живут до конца вызова.
    match unsafe { FwpmProviderAdd0(e.0, &provider, None) } {
        0 | ERR_ALREADY_EXISTS => {}
        c => return Err(fail("FwpmProviderAdd0", c)),
    }
    let mut provider_key = GUID::from_u128(wall::PROVIDER);
    let sublayer = FWPM_SUBLAYER0 {
        subLayerKey: GUID::from_u128(wall::SUBLAYER),
        displayData: FWPM_DISPLAY_DATA0 { name: PWSTR(name.as_mut_ptr()), description: PWSTR::null() },
        flags: FWPM_SUBLAYER_FLAG_PERSISTENT,
        providerKey: &mut provider_key,
        weight: 0xFFFF,
        ..Default::default()
    };
    // SAFETY: provider_key и name живут до конца вызова.
    match unsafe { FwpmSubLayerAdd0(e.0, &sublayer, None) } {
        0 | ERR_ALREADY_EXISTS => Ok(()),
        c => Err(fail("FwpmSubLayerAdd0", c)),
    }
}

/// Ключи наших фильтров, какими они стоят в ядре, по обоим слоям.
fn enumerate(e: &Engine) -> io::Result<HashSet<u128>> {
    const PAGE: u32 = 128;
    let mut keys = HashSet::new();
    for layer in [Layer::V4, Layer::V6, Layer::RecvV4, Layer::RecvV6] {
        let mut provider = GUID::from_u128(wall::PROVIDER);
        let template = FWPM_FILTER_ENUM_TEMPLATE0 {
            providerKey: &mut provider,
            layerKey: layer_guid(layer),
            enumType: FWP_FILTER_ENUM_OVERLAPPING,
            actionMask: 0xFFFF_FFFF,
            ..Default::default()
        };
        let mut eh = HANDLE::default();
        // SAFETY: template и provider живут до конца вызова.
        check("FwpmFilterCreateEnumHandle0", unsafe { FwpmFilterCreateEnumHandle0(e.0, Some(&template), &mut eh) })?;
        let mut result = Ok(());
        loop {
            let mut entries: *mut *mut FWPM_FILTER0 = null_mut();
            let mut n = 0u32;
            // SAFETY: eh получен выше, выходные указатели наши.
            let rc = unsafe { FwpmFilterEnum0(e.0, eh, PAGE, &mut entries, &mut n) };
            if rc != 0 {
                result = Err(fail("FwpmFilterEnum0", rc));
                break;
            }
            for i in 0..n as usize {
                // SAFETY: WFP вернул массив из n валидных указателей.
                keys.insert(unsafe { (**entries.add(i)).filterKey }.to_u128());
            }
            // SAFETY: массив выдан WFP и освобождается один раз; n = 0 тоже может нести память.
            unsafe { FwpmFreeMemory0(&mut entries as *mut *mut *mut FWPM_FILTER0 as *mut *mut c_void) };
            if n < PAGE {
                break;
            }
        }
        // SAFETY: eh создан выше.
        unsafe { FwpmFilterDestroyEnumHandle0(e.0, eh) };
        result?;
    }
    Ok(keys)
}

fn delete_filter(e: &Engine, key: u128) -> io::Result<()> {
    let g = GUID::from_u128(key);
    // SAFETY: g жив на время вызова.
    match unsafe { FwpmFilterDeleteByKey0(e.0, &g) } {
        0 => Ok(()),
        c if absent(c) => Ok(()),
        c => Err(fail("FwpmFilterDeleteByKey0", c)),
    }
}

// Союзы внутри структуры заполняются присваиванием, инициализатором — громоздко.
#[allow(clippy::field_reassign_with_default)]
fn add_filter(e: &Engine, rule: &Rule, ids: &AppIds) -> io::Result<()> {
    let mut name = wide(&rule.name);
    let mut conds = conditions(rule, ids);
    let mut provider = GUID::from_u128(wall::PROVIDER);
    let mut f = FWPM_FILTER0::default();
    f.filterKey = GUID::from_u128(rule.key);
    f.displayData.name = PWSTR(name.as_mut_ptr());
    f.flags = FWPM_FILTER_FLAG_PERSISTENT;
    f.providerKey = &mut provider;
    f.layerKey = layer_guid(rule.layer);
    f.subLayerKey = GUID::from_u128(wall::SUBLAYER);
    // FWP_UINT8 — вес как диапазон 0..=15 внутри подслоя.
    f.weight.r#type = FWP_UINT8;
    f.weight.Anonymous.uint8 = rule.weight;
    f.numFilterConditions = conds.len() as u32;
    f.filterCondition = if conds.is_empty() { null_mut() } else { conds.as_mut_ptr() };
    f.action.r#type = match rule.action {
        Action::Block => FWP_ACTION_BLOCK,
        Action::Permit => FWP_ACTION_PERMIT,
    };
    // SAFETY: name, conds, provider и блобы в `ids` живут до конца вызова;
    // WFP копирует всё, что ему нужно, внутри FwpmFilterAdd0.
    check("FwpmFilterAdd0", unsafe { FwpmFilterAdd0(e.0, &f, None, None) })
}

/// Привести стену к желаемому виду. Идемпотентна, одна транзакция.
///
/// Путь, который WFP не принял, уносит только свои правила (`wall::split`),
/// остальное встаёт; что из этого сказать службе — `wall::outcome`.
///
/// Не вставший целиком набор с замком не оставляет машину без стены: транзакция
/// откатилась, и при первой постановке в ядре нет ничего — белый список был бы
/// открыт всем. Поэтому один повтор в новой транзакции голым замком (`bare`,
/// его считает `wall::bare_lock`), а вернуть всё равно исходную ошибку: служба
/// не запомнит применённое и повторит полный набор.
pub(crate) fn apply(rules: Vec<Rule>, bare: Vec<Rule>) -> io::Result<Vec<String>> {
    let fallback = wall::wants_fallback(&rules, &bare);
    match apply_set(rules) {
        Ok(done) => done,
        Err(e) => {
            if fallback {
                // Отказ запасного не важен: наверх идёт первопричина.
                let _ = apply_set(bare);
            }
            Err(e)
        }
    }
}

/// Внешний `Err` — транзакция не встала (стена не изменилась), внутренний —
/// итог для службы по уже вставшей стене (`wall::outcome`).
fn apply_set(rules: Vec<Rule>) -> io::Result<io::Result<Vec<String>>> {
    let rules = wall::present(rules);
    let engine = Engine::open()?;
    // Пусто и нечего снимать — не создаём провайдера вовсе: так служба на
    // чистой машине с выключенным приватным режимом ничего в WFP не оставляет.
    if rules.is_empty() && !provider_exists(&engine)? {
        return Ok(Ok(Vec::new()));
    }
    // Блобы приложений получаем до транзакции: она держит замок на ядро.
    let (ids, refused) = AppIds::resolve(&rules);
    let (rules, dropped) = wall::split(rules, &refused);
    let txn = Txn::begin(&engine)?;
    if !rules.is_empty() {
        ensure_scaffold(&engine)?;
    }
    let stand = enumerate(&engine)?;
    let want: HashSet<u128> = rules.iter().map(|r| r.key).collect();
    for key in stand.difference(&want) {
        delete_filter(&engine, *key)?;
    }
    for rule in rules.iter().filter(|r| !stand.contains(&r.key)) {
        add_filter(&engine, rule, &ids)?;
    }
    txn.commit()?;
    Ok(wall::outcome(&dropped, &refused))
}

/// Снять всё: фильтры, подслой, провайдер. Для деинсталляции.
pub(crate) fn forget() -> io::Result<()> {
    let engine = Engine::open()?;
    if !provider_exists(&engine)? {
        return Ok(());
    }
    let txn = Txn::begin(&engine)?;
    for key in enumerate(&engine)? {
        delete_filter(&engine, key)?;
    }
    let sublayer = GUID::from_u128(wall::SUBLAYER);
    // SAFETY: ключи живы на время вызова. Подслой раньше провайдера: пока на
    // него смотрит подслой, провайдер удалить нельзя.
    match unsafe { FwpmSubLayerDeleteByKey0(engine.0, &sublayer) } {
        0 => {}
        c if absent(c) => {}
        c => return Err(fail("FwpmSubLayerDeleteByKey0", c)),
    }
    let provider = GUID::from_u128(wall::PROVIDER);
    // SAFETY: см. выше.
    match unsafe { FwpmProviderDeleteByKey0(engine.0, &provider) } {
        0 => {}
        c if absent(c) => {}
        c => return Err(fail("FwpmProviderDeleteByKey0", c)),
    }
    txn.commit()
}

/// Ключи фильтров, какие сейчас стоят в WFP. Для живого сторожа.
#[cfg(test)]
pub(crate) fn installed() -> io::Result<HashSet<u128>> {
    let engine = Engine::open()?;
    if !provider_exists(&engine)? {
        return Ok(HashSet::new());
    }
    enumerate(&engine)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Fence;
    use std::net::Ipv4Addr;
    use std::path::Path;

    /// Отсутствие провайдера, подслоя или фильтра — это «нечего снимать», а не
    /// сбой. Коды взяты из живого ответа WFP, а не из памяти.
    #[test]
    fn every_kind_of_absence_is_absence() {
        for code in [0x8032_0005u32, 0x8032_0007, 0x8032_0003, 0x8032_0008] {
            assert!(absent(code), "0x{code:08X} — это «нет такого объекта»");
        }
        assert!(!absent(0), "успех — не отсутствие");
        assert!(!absent(ERR_ALREADY_EXISTS), "«уже есть» — не отсутствие");
    }

    /// Только с `--ignored`, от администратора: ставит и снимает настоящую
    /// стену на настоящей машине. Не запускать там, где работает живая служба.
    #[test]
    #[ignore]
    fn the_wall_stands_and_falls_in_wfp() {
        let sb = std::env::current_exe().unwrap();
        let apps = vec![sb.to_string_lossy().into_owned()];
        let tun = Ipv4Addr::new(172, 27, 234, 1);
        let rules = wall::present(wall::wall(Fence::Allow, true, tun, &apps, Path::new(&sb)));
        let bare = wall::bare_lock(true, tun, Path::new(&sb));
        apply(rules.clone(), bare.clone()).expect("стена не встала (нужен администратор)");
        let want: HashSet<u128> = rules.iter().map(|r| r.key).collect();
        assert_eq!(installed().unwrap(), want, "в ядре не то, что просили");
        apply(rules, bare).expect("повторный apply обязан быть тихим");
        apply(wall::wall(Fence::Off, false, tun, &apps, Path::new(&sb)), Vec::new()).unwrap();
        assert!(installed().unwrap().is_empty(), "стена не упала");
        forget().unwrap();
    }
}
