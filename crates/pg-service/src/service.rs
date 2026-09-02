//! Регистрация и работа в качестве службы Windows.
//!
//! Права нужны настоящие: TUN поднимается через wintun, правила ставятся в
//! брандмауэр — и то и другое только от администратора. Поэтому служба живёт
//! под LocalSystem и стартует вместе с системой, а GUI и CLI остаются обычными
//! пользовательскими процессами и разговаривают с ней через core-ipc.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;
use windows_service::service::{
    Service, ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept,
    ServiceErrorControl, ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo,
    ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

pub use core_ipc::SERVICE_NAME as NAME;
const DISPLAY: &str = "proxybox";
const DESCRIPTION: &str = "Пускает выбранные приложения в сеть только через туннель пользователя \
                           и отказывает им в доступе, когда туннеля нет.";
/// Аргумент, с которым службу запускает SCM. Без него бинарник работает
/// консольным процессом — так удобнее в разработке.
pub const ARG: &str = "--service";

const SERVICE_TYPE: ServiceType = ServiceType::OWN_PROCESS;

define_windows_service!(ffi_service_main, service_main);

fn service_main(_args: Vec<OsString>) {
    // Докладывать некуда: до регистрации обработчика нет ни SCM, ни консоли.
    let _ = run_service();
}

fn status(state: ServiceState, controls: ServiceControlAccept) -> ServiceStatus {
    ServiceStatus {
        service_type: SERVICE_TYPE,
        current_state: state,
        controls_accepted: controls,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint: Duration::from_secs(10),
        process_id: None,
    }
}

fn run_service() -> windows_service::Result<()> {
    let (tx, rx) = mpsc::channel();
    let handle = service_control_handler::register(NAME, move |control| match control {
        // Остановка — сознательное действие администратора: туннель гасим и
        // правила снимаем. Падение службы (без Stop) правила НЕ снимает — там
        // fail-closed важнее удобства.
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = tx.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })?;

    handle.set_service_status(status(ServiceState::Running, ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN))?;
    let result = crate::run(Some(rx));
    // Код возврата — не украшение: по нему SCM отличает отказ от остановки, и
    // только по отказу запускает failure actions. С нулём при любом исходе
    // служба, не сумевшая занять канал, выглядела бы штатно остановленной —
    // выбранные приложения остались бы в DROP, и поднимать туннель было бы
    // некому до тех пор, пока человек не сходит в «Службы» руками.
    let exit_code = match &result {
        Ok(()) => ServiceExitCode::Win32(0),
        Err(e) => ServiceExitCode::Win32(e.raw_os_error().unwrap_or(1) as u32),
    };
    handle.set_service_status(ServiceStatus {
        exit_code,
        ..status(ServiceState::Stopped, ServiceControlAccept::empty())
    })?;
    result.map_err(|e| windows_service::Error::Winapi(e))
}

pub fn dispatch() -> windows_service::Result<()> {
    service_dispatcher::start(NAME, ffi_service_main)
}

fn manager(access: ServiceManagerAccess) -> windows_service::Result<ServiceManager> {
    ServiceManager::local_computer(None::<&str>, access)
}

/// Дождаться остановки. И `stop`, и убитый процесс службы возвращают
/// управление раньше, чем SCM пометит её остановленной, а стартовать и удалять
/// можно только остановленную.
fn wait_stopped(service: &Service) -> windows_service::Result<()> {
    for _ in 0..20 {
        if service.query_status()?.current_state == ServiceState::Stopped {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(())
}

/// Установка идемпотентна: `install` вызывается установщиком каждый раз, а
/// служба к этому моменту уже может быть в SCM — обновление поверх, повторный
/// запуск установщика, снятая через диспетчер задач служба от прошлой версии.
/// `create_service` на такое отвечает отказом (ERROR_SERVICE_EXISTS), и
/// установщик рапортовал бы о провале там, где чинить нечего.
///
/// Существующей службе переписываем настройки, а не пересоздаём её: удаление в
/// SCM откладывается до закрытия последнего дескриптора, так что пересоздание
/// упиралось бы в ERROR_SERVICE_MARKED_FOR_DELETE и требовало перезагрузки.
/// Путь к бинарнику после обновления другой — потому и переписываем.
pub fn install(exe: PathBuf) -> windows_service::Result<()> {
    let info = ServiceInfo {
        name: NAME.into(),
        display_name: DISPLAY.into(),
        service_type: SERVICE_TYPE,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe,
        launch_arguments: vec![ARG.into()],
        dependencies: vec![],
        // LocalSystem: без него не поднять TUN и не тронуть брандмауэр.
        account_name: None,
        account_password: None,
    };
    let access = ServiceAccess::CHANGE_CONFIG | ServiceAccess::START | ServiceAccess::QUERY_STATUS;
    let manager = manager(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)?;
    let service = match manager.open_service(NAME, access) {
        Ok(service) => {
            service.change_config(&info)?;
            service
        }
        Err(_) => manager.create_service(&info, access)?,
    };
    service.set_description(DESCRIPTION)?;
    // Падение службы правила брандмауэра НЕ снимает — это осознанный fail-closed
    // (см. обработчик Stop выше). Но поднять туннель обратно после падения
    // некому, а SCM по умолчанию не перезапускает ничего: цена одной паники —
    // запертая машина до тех пор, пока человек не заметит и не сходит в
    // «Службы» руками. Три попытки с нарастающей паузой; счётчик сбрасывается
    // сутками без отказов, иначе служба, падающая раз в месяц, после третьего
    // раза за год перестала бы подниматься навсегда.
    //
    // Отказ самой настройки установку не валит: служба в SCM уже есть и
    // работает, а `install` обязана оставаться идемпотентной — см. выше.
    let restart = |delay| ServiceAction { action_type: ServiceActionType::Restart, delay };
    let _ = service.update_failure_actions(ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(24 * 60 * 60)),
        reboot_msg: None,
        command: None,
        actions: Some(vec![
            restart(Duration::from_secs(5)),
            restart(Duration::from_secs(30)),
            restart(Duration::from_secs(60)),
        ]),
    });
    // Ненулевой код возврата — тоже отказ. Без этого флага SCM считает падением
    // только смерть процесса, а служба, не сумевшая занять канал, завершается
    // сама и «штатно» — то есть ровно тот отказ, который и надо перезапускать.
    let _ = service.set_failure_actions_on_non_crash_failures(true);
    // Установщику нужна работающая служба сразу, а не после перезагрузки.
    match service.query_status()?.current_state {
        // Работающую не трогаем: перезапуск уронил бы живой туннель.
        ServiceState::Running | ServiceState::StartPending => Ok(()),
        // Остановка предыдущей версии могла ещё не закончиться.
        _ => {
            wait_stopped(&service)?;
            service.start::<&OsStr>(&[])
        }
    }
}

pub fn uninstall() -> windows_service::Result<()> {
    let access = ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE;
    let service = manager(ServiceManagerAccess::CONNECT)?.open_service(NAME, access)?;
    if service.query_status()?.current_state != ServiceState::Stopped {
        service.stop()?;
        // Дать службе снять правила брандмауэра до удаления: иначе выбранные
        // приложения останутся заблокированными, а снимать блокировку нечем.
        wait_stopped(&service)?;
    }
    service.delete()
}
