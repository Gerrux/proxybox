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
}
