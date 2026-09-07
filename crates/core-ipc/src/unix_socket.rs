//! Серверная сторона unix-сокета — единственное место с вызовами libc.
//! Клиенты обходятся `UnixStream::connect`: это умеет std.
//!
//! Право управлять службой даёт членство в группе `proxybox`, и это прямой
//! аналог списка доступа именованного канала на Windows: там право даёт
//! членство в «интерактивных пользователях». Различает и то и другое
//! пользователя, а не программу, — иначе и быть не может, свою же консоль
//! запускает кто угодно от имени того же человека.
//!
//! Права стоят на двух вещах разом, и обе обязательны. Каталог закрыт до
//! `bind`, а не после: `DirBuilder` с выставленным `mode` создаёт его сразу с
//! нужными правами одним вызовом ядра, без окна между `mkdir` и `chmod`, в
//! которое иначе мог заглянуть кто угодно. Но каталог одной проверкой вход не
//! закрывает: Linux при `connect()` отдельно проверяет право записи на сам
//! инод сокета — это открытие файла, а не обход пути, и прав каталога для
//! него мало. Сокет рождается под umask процесса (обычно 0755, root:root), и
//! без явного `chmod`/`chgrp` на него самого членство в группе давало бы
//! `EACCES`, а не доступ. Сторож — `the_socket_is_never_world_writable`.

use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::process::{Command, Stdio};

/// Каталог сокета: войти могут только root и группа `proxybox`.
const DIR_MODE: u32 = 0o750;
/// Сам сокет: то же чтение-запись владельцу и группе, без обхода каталога
/// оно бесполезно, но Linux спрашивает его отдельно — см. шапку модуля.
const SOCK_MODE: u32 = 0o660;
/// Кому позволено управлять службой. Заводит группу пакет; пока его нет,
/// каталог остаётся за одним root.
const GROUP: &str = "proxybox";

/// Поднять сокет по пути из контракта (с поправкой на `PG_SOCKET`).
pub fn bind() -> io::Result<UnixListener> {
    bind_at(Path::new(&crate::socket()))
}

fn chgrp(target: &Path) {
    // Группу заводит `.deb` (installer/postinst). Без пакета — установка из
    // исходников — ни каталога, ни сокета в системе для неё нет вовсе, то
    // есть службой управляет только root, и это честнее, чем открыть их
    // кому-то ещё. Отказ поэтому не отказ: `chgrp` на несуществующую группу
    // означает «пакета не было».
    let _ = Command::new("chgrp").arg(GROUP).arg(target).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// То же, но по произвольному пути — так проверяет сторож, не трогая `/run`.
fn bind_at(path: &Path) -> io::Result<UnixListener> {
    let dir = path.parent().ok_or_else(|| io::Error::other("у сокета нет каталога"))?;
    // `DirBuilder::create` (без `recursive`) отличает «создал я» от «каталог
    // был» через `AlreadyExists` — `create_dir_all` этого не умеет, он тихо
    // считает существующий каталог успехом. Разница существенная:
    // PG_SOCKET=/tmp/pg.sock указывает прямо в /tmp, и `chmod`/`chgrp` поверх
    // чужого каталога снял бы с /tmp sticky-бит и закрыл его для всех
    // остальных пользователей машины — тихо и необратимо. Свой каталог
    // получает права и группу, чужой остаётся как был.
    let ours = match std::fs::DirBuilder::new().mode(DIR_MODE).create(dir) {
        Ok(()) => true,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => false,
        Err(e) => return Err(e),
    };
    // Сокет, оставшийся от убитой службы, мешает bind. Снимаем его — но
    // только убедившись, что на том конце никто не слушает: иначе вторая
    // копия службы отобрала бы канал у первой, а распорядитель обязан быть
    // один. Та же мысль, что и в `Listener::bind` на Windows.
    if path.exists() && UnixStream::connect(path).is_err() {
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(SOCK_MODE))?;
    if ours {
        chgrp(dir);
    }
    chgrp(path);
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
    /// Каталога мало: Linux при `connect()` отдельно проверяет право записи
    /// на сам инод сокета, и без явного `chmod` на него самого щель осталась
    /// бы — членство в группе давало бы `EACCES` вместо доступа. Стережём
    /// поэтому обоих.
    #[test]
    fn the_socket_is_never_world_writable() {
        let dir = std::env::temp_dir().join(format!("pg-sock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sock = dir.join("service.sock");
        let listener = bind_at(&sock).expect("сокет");
        let dir_mode = std::fs::metadata(&dir).expect("каталог").permissions().mode() & 0o777;
        assert_eq!(dir_mode, 0o750, "каталог сокета открыт посторонним");
        let sock_mode = std::fs::metadata(&sock).expect("сокет").permissions().mode() & 0o777;
        assert_eq!(sock_mode, 0o660, "сам сокет открыт шире, чем группе");
        drop(listener);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `PG_SOCKET` в чужом каталоге (`/tmp/pg.sock`, форма для запуска без
    /// root — см. `PG_SOCKET` в `CLAUDE.md`) не имеет права переставлять права
    /// `/tmp`: чужой каталог мы не создавали, и `chmod`/`chgrp` поверх него
    /// снял бы sticky-бит и закрыл его для всех остальных пользователей машины.
    #[test]
    fn a_foreign_directory_keeps_its_own_permissions() {
        let dir = std::env::temp_dir();
        let before = std::fs::metadata(&dir).expect("каталог").permissions().mode() & 0o7777;
        let sock = dir.join(format!("pg-foreign-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&sock);
        let listener = bind_at(&sock).expect("сокет");
        let after = std::fs::metadata(&dir).expect("каталог").permissions().mode() & 0o7777;
        assert_eq!(before, after, "чужой каталог не наш, чтобы его переставлять");
        drop(listener);
        let _ = std::fs::remove_file(&sock);
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
