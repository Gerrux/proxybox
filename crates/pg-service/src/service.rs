//! Регистрация и работа в качестве службы Windows.
//!
//! Права нужны настоящие: TUN поднимается через wintun, правила ставятся в
//! брандмауэр — и то и другое только от администратора. Поэтому служба живёт
//! под LocalSystem и стартует вместе с системой, а GUI и CLI остаются обычными
//! пользовательскими процессами и разговаривают с ней через core-ipc.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;
use windows_service::service::{
    ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl, ServiceExitCode, ServiceInfo,
    ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

pub use core_ipc::SERVICE_NAME as NAME;
const DISPLAY: &str = "Privacy Gateway";
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
    handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty()))?;
    result.map_err(|e| windows_service::Error::Winapi(e))
}

pub fn dispatch() -> windows_service::Result<()> {
    service_dispatcher::start(NAME, ffi_service_main)
}

fn manager(access: ServiceManagerAccess) -> windows_service::Result<ServiceManager> {
    ServiceManager::local_computer(None::<&str>, access)
}

pub fn install(exe: PathBuf) -> windows_service::Result<()> {
    let service = manager(ServiceManagerAccess::CREATE_SERVICE)?.create_service(
        &ServiceInfo {
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
        },
        ServiceAccess::CHANGE_CONFIG | ServiceAccess::START,
    )?;
    service.set_description(DESCRIPTION)?;
    // Установщику нужна работающая служба сразу, а не после перезагрузки.
    service.start::<&std::ffi::OsStr>(&[])
}

pub fn uninstall() -> windows_service::Result<()> {
    let access = ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE;
    let service = manager(ServiceManagerAccess::CONNECT)?.open_service(NAME, access)?;
    if service.query_status()?.current_state != ServiceState::Stopped {
        service.stop()?;
        // Дать службе снять правила брандмауэра до удаления: иначе выбранные
        // приложения останутся заблокированными, а снимать блокировку нечем.
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(500));
            if service.query_status()?.current_state == ServiceState::Stopped {
                break;
            }
        }
    }
    service.delete()
}
