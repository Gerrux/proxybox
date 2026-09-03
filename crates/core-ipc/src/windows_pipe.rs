//! Серверная сторона именованного канала — единственное место с WinAPI.
//! Клиенты обходятся обычным `File`: открыть существующий канал умеет std.

use std::ffi::c_void;
use std::fs::File;
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};

type Handle = *mut c_void;
const INVALID_HANDLE_VALUE: isize = -1;
const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
const PIPE_TYPE_BYTE: u32 = 0;
const PIPE_UNLIMITED_INSTANCES: u32 = 255;
const SDDL_REVISION_1: u32 = 1;
const ERROR_PIPE_CONNECTED: i32 = 535;
const BUFFER: u32 = 64 * 1024;

/// SYSTEM и администраторы — полный доступ; интерактивные пользователи —
/// чтение и запись, потому что GUI работает от обычного пользователя.
/// `S:(ML;;NWNR;;;LW)` — метка целостности: процесс низкой целостности
/// (вкладка браузера, приложение из Store) до канала не дотянется.
const SDDL: &str = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)S:(ML;;NWNR;;;LW)";
/// Тот же список без метки целостности: постановка SACL может не пройти, и
/// потерять из-за этого весь канал хуже, чем потерять отсечку песочниц.
const SDDL_NO_LABEL: &str = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;IU)";

#[repr(C)]
struct SecurityAttributes {
    length: u32,
    descriptor: *mut c_void,
    inherit: i32,
}

extern "system" {
    fn GetNamedPipeClientProcessId(pipe: Handle, pid: *mut u32) -> i32;
    fn CreateNamedPipeW(
        name: *const u16,
        open_mode: u32,
        pipe_mode: u32,
        max_instances: u32,
        out_buffer: u32,
        in_buffer: u32,
        default_timeout: u32,
        security: *const SecurityAttributes,
    ) -> Handle;
    fn ConnectNamedPipe(pipe: Handle, overlapped: *mut c_void) -> i32;
    fn LocalFree(mem: *mut c_void) -> *mut c_void;
}

// Отдельным блоком не для красоты: kernel32 приносит с собой std, а advapi32 —
// нет, и без явного #[link] SDDL-функция не находится на этапе линковки
// (LNK2019). Сама она давно живёт в sechost.dll, но импорт по-прежнему через
// advapi32.lib — так эту пару и линкуют.
#[link(name = "advapi32")]
extern "system" {
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl: *const u16,
        revision: u32,
        descriptor: *mut *mut c_void,
        size: *mut u32,
    ) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Дескриптор безопасности из строки SDDL. Освобождается LocalFree — так его
/// отдаёт ConvertStringSecurityDescriptor…
struct Descriptor(*mut c_void);

impl Descriptor {
    fn new(sddl: &str) -> io::Result<Self> {
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(sddl).as_ptr(),
                SDDL_REVISION_1,
                &mut ptr,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Descriptor(ptr))
    }
}

impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

fn create_with(sddl: &str) -> io::Result<File> {
    let descriptor = Descriptor::new(sddl)?;
    let security = SecurityAttributes {
        length: std::mem::size_of::<SecurityAttributes>() as u32,
        descriptor: descriptor.0,
        inherit: 0,
    };
    let handle = unsafe {
        CreateNamedPipeW(
            wide(crate::PIPE).as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE,
            PIPE_UNLIMITED_INSTANCES,
            BUFFER,
            BUFFER,
            0,
            &security,
        )
    };
    if handle as isize == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_handle(handle as RawHandle) })
}

fn create() -> io::Result<File> {
    create_with(SDDL).or_else(|_| create_with(SDDL_NO_LABEL))
}

/// Создаётся ли канал вообще (права, поддержка SDDL). Экземпляр сразу
/// закрывается — рабочие создаёт accept.
pub fn probe() -> io::Result<()> {
    create().map(drop)
}

/// Номер процесса на том конце канала.
///
/// Список доступа различает пользователя, но не программу: от имени человека
/// работает и окно, и любая другая программа, которую он запустил, — а команды
/// у службы разрушающие. Запретить по этому номеру ничего нельзя (свою же
/// консоль запускает кто угодно), а вот сказать в журнале, кто пришёл, — можно,
/// и это разница между «выключили молча» и «выключили, и вот кто».
pub fn client_pid(pipe: &File) -> Option<u32> {
    let mut pid = 0u32;
    // SAFETY: хэндл живёт, пока живёт `pipe`; функция пишет ровно один u32.
    let ok = unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle() as Handle, &mut pid) };
    (ok != 0).then_some(pid)
}

/// Новый экземпляр канала и ожидание клиента на нём.
pub fn accept() -> io::Result<File> {
    let pipe = create()?;
    let connected = unsafe { ConnectNamedPipe(pipe.as_raw_handle() as Handle, std::ptr::null_mut()) };
    if connected == 0 {
        let error = io::Error::last_os_error();
        // Клиент успел подключиться между созданием и ожиданием — это успех.
        if error.raw_os_error() != Some(ERROR_PIPE_CONNECTED) {
            return Err(error);
        }
    }
    Ok(pipe)
}
