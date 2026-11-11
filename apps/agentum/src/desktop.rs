//! Private Linux X display, sandbox check, capture and bounded input helpers.
use crate::computer::{Fault, OpResult};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
mod apps;
pub use apps::valid_app;
use std::{
    fs,
    io::{Read, Write},
    os::unix::{net::UnixStream, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    thread,
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use x11rb::{
    connection::Connection,
    protocol::xproto::{ConnectionExt, ImageFormat, ImageOrder},
    rust_connection::{DefaultStream, PollMode, RustConnection, Stream},
};
// x11rb's default poll has no deadline. Bound the full X exchange, including setup.
struct DeadlineStream {
    stream: DefaultStream,
    deadline: Instant,
}
impl Stream for DeadlineStream {
    fn poll(&self, mode: PollMode) -> std::io::Result<()> {
        use std::os::fd::AsRawFd;
        loop {
            let left = self.deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "X server timed out",
                ));
            }
            let mut fd = nix::libc::pollfd {
                fd: self.stream.as_raw_fd(),
                events: (if mode.readable() {
                    nix::libc::POLLIN
                } else {
                    0
                }) | (if mode.writable() {
                    nix::libc::POLLOUT
                } else {
                    0
                }),
                revents: 0,
            };
            // SAFETY: fd points to one initialized pollfd, valid for this call.
            let result = unsafe {
                nix::libc::poll(
                    &mut fd,
                    1,
                    left.as_millis().max(1).min(i32::MAX as u128) as i32,
                )
            };
            if result > 0 {
                return Ok(());
            }
            let e = std::io::Error::last_os_error();
            if result < 0 && e.kind() != std::io::ErrorKind::Interrupted {
                return Err(e);
            }
        }
    }
    fn read(
        &self,
        buf: &mut [u8],
        fds: &mut Vec<x11rb::utils::RawFdContainer>,
    ) -> std::io::Result<usize> {
        self.stream.read(buf, fds)
    }
    fn write(
        &self,
        buf: &[u8],
        fds: &mut Vec<x11rb::utils::RawFdContainer>,
    ) -> std::io::Result<usize> {
        self.stream.write(buf, fds)
    }
}
fn failed(error: impl std::fmt::Display) -> Fault {
    Fault::new("op_failed", error.to_string())
}
fn bad(message: &str) -> Fault {
    Fault::new("bad_request", message)
}
fn unavailable(message: impl Into<String>) -> Fault {
    Fault::new("desktop_unavailable", message)
}
pub fn quality(frame: &Value) -> OpResult<u8> {
    match frame.get("quality") {
        None | Some(Value::Null) => Ok(60),
        Some(v) => v
            .as_u64()
            .filter(|q| (1..=95).contains(q))
            .map(|q| q as u8)
            .ok_or_else(|| bad("quality must be 1 to 95")),
    }
}
const TOOL_COMMANDS: &str = "behave behave_screen_edge click exec get_desktop get_desktop_for_window get_desktop_viewport get_num_desktops getactivewindow getdisplaygeometry getmouselocation getwindowclassname getwindowfocus getwindowgeometry getwindowname getwindowpid help key keydown keyup mousedown mousemove mousemove_relative mouseup search selectwindow set_desktop set_desktop_for_window set_desktop_viewport set_num_desktops set_window sleep type version windowactivate windowclose windowfocus windowkill windowlower windowmap windowminimize windowmove windowquit windowraise windowreparent windowsize windowstate windowunmap";
pub fn validate_actions(frame: &Value) -> OpResult<usize> {
    let actions = frame["actions"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 64)
        .ok_or_else(|| bad("actions must hold 1 to 64 entries"))?;
    let mut scroll = 0;
    let mut typed = 0;
    for a in actions {
        let point = || {
            a["x"].as_i64().is_some_and(|v| (0..1280).contains(&v))
                && a["y"].as_i64().is_some_and(|v| (0..800).contains(&v))
        };
        let button = || matches!(a["button"].as_str(), Some("left" | "middle" | "right"));
        let valid = match a["type"].as_str() {
            Some("mouse_move") => point(),
            Some("mouse_down" | "mouse_up") => button(),
            Some("click") => {
                point() && button() && a["count"].as_u64().is_some_and(|n| (1..=3).contains(&n))
            }
            Some("scroll") => {
                let deltas = [a["dx"].as_i64(), a["dy"].as_i64()];
                let valid = point()
                    && deltas
                        .iter()
                        .all(|d| d.is_some_and(|d| (-50..=50).contains(&d)));
                if valid {
                    scroll += deltas
                        .iter()
                        .map(|d| d.unwrap().unsigned_abs())
                        .sum::<u64>();
                }
                valid
            }
            Some("key") => a["keys"].as_str().is_some_and(|k| {
                !k.is_empty()
                    && k.chars().count() <= 64
                    && k.split('+').all(|part| {
                        !part.is_empty()
                            && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
                    })
                    && !TOOL_COMMANDS
                        .split_whitespace()
                        .any(|c| c.eq_ignore_ascii_case(k))
            }),
            Some("type") => a["text"].as_str().is_some_and(|t| {
                let count = t.chars().count();
                typed += count;
                (1..=512).contains(&count)
            }),
            _ => false,
        };
        if !valid {
            return Err(bad("invalid desktop action"));
        }
    }
    if scroll > 60 {
        return Err(bad("batch exceeds 60 scroll clicks"));
    }
    Ok(typed)
}
fn validate_clipboard(frame: &Value) -> OpResult<()> {
    if frame["text"].as_str().is_none_or(|t| t.len() > 65536) {
        return Err(bad("clipboard text exceeds 64 KiB or is missing"));
    }
    let selections = frame["selections"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 2)
        .ok_or_else(|| bad("name 1 or 2 clipboard selections"))?;
    if !selections
        .iter()
        .all(|s| matches!(s.as_str(), Some("clipboard" | "primary")))
        || (selections.len() == 2 && selections[0] == selections[1])
    {
        return Err(bad("unknown or duplicate clipboard selection"));
    }
    Ok(())
}
fn steps(a: &Value) -> Vec<(Vec<String>, Option<String>)> {
    let kind = a["type"].as_str().unwrap_or("");
    let val = |key: &str| a[key].as_i64().unwrap_or(0).to_string();
    let button = match a["button"].as_str() {
        Some("left") => "1",
        Some("middle") => "2",
        _ => "3",
    };
    let strings = |v: Vec<&str>| v.into_iter().map(str::to_owned).collect::<Vec<_>>();
    match kind {
        "mouse_move" => vec![(vec!["mousemove".into(), val("x"), val("y")], None)],
        "mouse_down" | "mouse_up" => vec![(
            strings(vec![
                if kind == "mouse_down" {
                    "mousedown"
                } else {
                    "mouseup"
                },
                button,
            ]),
            None,
        )],
        "click" => vec![(
            vec![
                "mousemove".into(),
                val("x"),
                val("y"),
                "click".into(),
                "--repeat".into(),
                val("count"),
                "--delay".into(),
                "0".into(),
                button.into(),
            ],
            None,
        )],
        "scroll" => {
            let mut result = vec![(vec!["mousemove".into(), val("x"), val("y")], None)];
            for (key, pos, neg) in [("dy", "5", "4"), ("dx", "7", "6")] {
                let n = a[key].as_i64().unwrap();
                if n != 0 {
                    result.push((
                        vec![
                            "click".into(),
                            "--repeat".into(),
                            n.unsigned_abs().to_string(),
                            "--delay".into(),
                            "5".into(),
                            if n > 0 { pos.into() } else { neg.into() },
                        ],
                        None,
                    ));
                }
            }
            result
        }
        "key" => vec![(
            strings(vec!["key", "--", a["keys"].as_str().unwrap()]),
            None,
        )],
        "type" => vec![(
            strings(vec!["type", "--delay", "2", "--file", "-"]),
            Some(a["text"].as_str().unwrap().into()),
        )],
        _ => vec![],
    }
}
struct Life {
    stop: AtomicBool,
    xvfb: AtomicU32,
    pids: Mutex<Vec<u32>>,
}
pub struct Desktop {
    display: u16,
    /// Whether the opt-in is on: the bus is required and apps expose their accessibility tree.
    agent_apps: bool,
    /// The session bus every program on this desktop shares, once it is up.
    bus: OnceLock<String>,
    snapshots: apps::Snapshots,
    agent_desktop: String,
    dir: PathBuf,
    auth: PathBuf,
    cookie: Vec<u8>,
    life: Arc<Life>,
    turn: Arc<Semaphore>,
    shots: Arc<Semaphore>,
    threads: Mutex<Vec<thread::JoinHandle<()>>>,
}
impl Desktop {
    pub fn environment(&self) -> Vec<(String, String)> {
        let mut environment = vec![
            ("DISPLAY".into(), format!(":{}", self.display)),
            (
                "XAUTHORITY".into(),
                self.auth.to_string_lossy().into_owned(),
            ),
        ];
        if let Some(bus) = self.bus.get() {
            environment.push(("DBUS_SESSION_BUS_ADDRESS".into(), bus.clone()));
            environment.push((
                "XDG_RUNTIME_DIR".into(),
                self.dir.to_string_lossy().into_owned(),
            ));
        }
        if self.agent_apps {
            // Chromium joins the accessibility bus only with both of these. Debian's wrapper
            // reads CHROMIUM_FLAGS, and the image's own wrapper passes it through.
            environment.push(("ACCESSIBILITY_ENABLED".into(), "1".into()));
            environment.push((
                "CHROMIUM_FLAGS".into(),
                "--force-renderer-accessibility".into(),
            ));
        }
        environment
    }
    /// A desktop with no X server or processes, for tests that run helpers.
    #[cfg(test)]
    fn for_test(dir: &Path) -> Self {
        Self {
            display: 0,
            agent_apps: true,
            bus: OnceLock::new(),
            snapshots: Default::default(),
            agent_desktop: "agent-desktop".into(),
            dir: dir.into(),
            auth: dir.join("Xauthority"),
            cookie: vec![],
            life: Arc::new(Life {
                stop: AtomicBool::new(false),
                xvfb: AtomicU32::new(0),
                pids: Mutex::new(vec![]),
            }),
            turn: Arc::new(Semaphore::new(1)),
            shots: Arc::new(Semaphore::new(2)),
            threads: Mutex::new(vec![]),
        }
    }
    fn command(&self, name: &str) -> Command {
        let mut c = Command::new(name);
        c.env_clear();
        for key in ["PATH", "HOME", "LANG"] {
            if let Ok(value) = std::env::var(key) {
                c.env(key, value);
            }
        }
        c.envs(self.environment())
            .current_dir(&self.dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        // SAFETY: pre_exec only calls prctl; no allocator or locks run after fork.
        unsafe {
            c.pre_exec(|| {
                if nix::libc::prctl(nix::libc::PR_SET_PDEATHSIG, nix::libc::SIGTERM) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        c
    }
    fn owns(&self) -> bool {
        let pid = self.life.xvfb.load(Ordering::SeqCst);
        pid > 0
            && fs::read_to_string(format!("/tmp/.X{}-lock", self.display))
                .ok()
                .and_then(|s| s.trim().parse::<u32>().ok())
                == Some(pid)
    }
    fn connect(&self) -> OpResult<RustConnection<DeadlineStream>> {
        self.connect_for(Duration::from_secs(1))
    }
    fn connect_for(&self, budget: Duration) -> OpResult<RustConnection<DeadlineStream>> {
        if !self.owns() {
            return Err(unavailable(
                "display is not held by this desktop's X server",
            ));
        }
        connect_display(self.display, &self.cookie, budget)
    }

    pub fn start(state: &Path, display: u16, agent_apps: bool) -> OpResult<Self> {
        if !cfg!(target_os = "linux") {
            return Err(unavailable("desktop is supported only on Linux"));
        }
        let lock = PathBuf::from(format!("/tmp/.X{display}-lock"));
        if let Ok(raw) = fs::read_to_string(&lock) {
            let pid = raw
                .trim()
                .parse::<i32>()
                .map_err(|_| unavailable("display lock has no process id"))?;
            if pid > 0
                && alive_result(nix::sys::signal::kill(
                    nix::unistd::Pid::from_raw(pid),
                    None,
                ))
            {
                return Err(unavailable(format!(
                    "display :{display} is already in use; choose --desktop-display"
                )));
            }
        }
        let dir = state.join("desktop");
        crate::instance::private_dir(&dir).map_err(|e| unavailable(e.to_string()))?;
        let auth = dir.join("Xauthority");
        let cookie: Vec<u8> = (0..16).map(|_| rand::random::<u8>()).collect();
        write_xauthority(&auth, display, &cookie)?;
        let d = Self {
            display,
            agent_apps,
            bus: OnceLock::new(),
            snapshots: Default::default(),
            agent_desktop: "agent-desktop".into(),
            dir,
            auth,
            cookie,
            life: Arc::new(Life {
                stop: AtomicBool::new(false),
                xvfb: AtomicU32::new(0),
                pids: Mutex::new(vec![]),
            }),
            turn: Arc::new(Semaphore::new(1)),
            shots: Arc::new(Semaphore::new(2)),
            threads: Mutex::new(vec![]),
        };
        let mut xvfb = d.command("Xvfb");
        xvfb.args([
            format!(":{display}"),
            "-screen".into(),
            "0".into(),
            "1280x800x24".into(),
            "-nolisten".into(),
            "tcp".into(),
            "-nolisten".into(),
            "local".into(),
            "-auth".into(),
            d.auth.to_string_lossy().into_owned(),
        ]);
        d.supervise(xvfb, true)?;
        let deadline = Instant::now() + Duration::from_secs(15);
        while d.connect().is_err() {
            if Instant::now() > deadline {
                d.stop();
                return Err(unavailable("Xvfb did not answer within 15 seconds"));
            }
            thread::sleep(Duration::from_millis(100));
        }
        Ok(d)
    }
    pub fn launch(state: &Path, display: u16, agent_apps: bool) -> OpResult<Self> {
        if let Some(binary) = required_binaries(agent_apps)
            .iter()
            .find(|b| !crate::privilege::on_path(b))
        {
            return Err(missing_package(binary));
        }
        let d = Self::start(state, display, agent_apps)?;
        let result = (|| {
            d.start_bus()?;
            d.supervise(d.command("openbox"), false)?;
            let profile = tempfile::tempdir_in(&d.dir)?;
            let mut c = d.command("chromium");
            c.args([
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                &format!("--user-data-dir={}", profile.path().display()),
                "--dump-dom",
                "about:blank",
            ]);
            let out = run_helper(c, None, Duration::from_secs(45), 1 << 20)?;
            if !String::from_utf8_lossy(&out).contains("<html") {
                return Err(unavailable("Chromium sandbox self-test rendered nothing"));
            }
            Ok(())
        })();
        if let Err(e) = result {
            d.stop();
            return Err(unavailable(format!(
                "Chromium sandbox self-test failed: {}",
                e.message
            )));
        }
        Ok(d)
    }
    /// One session bus per desktop, at a fixed path in the private directory so a restart keeps the
    /// address. It is the bus agent-desktop and the apps' accessibility bridge meet on.
    fn start_bus(&self) -> OpResult<()> {
        if !crate::privilege::on_path("dbus-daemon") {
            // A desktop without the opt-in runs as before on hosts that have no bus.
            return Ok(());
        }
        let socket = self.dir.join("bus");
        let address = format!("unix:path={}", socket.display());
        if address.len() > 100 {
            return Err(unavailable(
                "the state directory path is too long for a D-Bus socket",
            ));
        }
        let _ = fs::remove_file(&socket);
        let mut bus = self.command("dbus-daemon");
        bus.args([
            "--session",
            "--nofork",
            "--nopidfile",
            &format!("--address={address}"),
        ]);
        self.supervise(bus, false)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        while !socket.exists() {
            if Instant::now() > deadline {
                return Err(unavailable("dbus-daemon did not start within 10 seconds"));
            }
            thread::sleep(Duration::from_millis(50));
        }
        let _ = self.bus.set(address);
        Ok(())
    }
    fn supervise(&self, mut command: Command, xvfb: bool) -> OpResult<()> {
        let mut child = command.spawn().map_err(failed)?;
        let life = self.life.clone();
        let display = self.display;
        let cookie = self.cookie.clone();
        let handle = thread::spawn(move || {
            let mut delay = 1;
            loop {
                let pid = child.id();
                life.pids.lock().unwrap().push(pid);
                if xvfb {
                    life.xvfb.store(pid, Ordering::SeqCst);
                }
                let start = Instant::now();
                loop {
                    if life.stop.load(Ordering::SeqCst) {
                        let _ = nix::sys::signal::killpg(
                            nix::unistd::Pid::from_raw(pid as i32),
                            nix::sys::signal::Signal::SIGTERM,
                        );
                        let deadline = Instant::now() + Duration::from_secs(5);
                        while Instant::now() < deadline {
                            if child.try_wait().ok().flatten().is_some() {
                                return;
                            }
                            thread::sleep(Duration::from_millis(20));
                        }
                        crate::computer::kill_group(pid);
                        let _ = child.wait();
                        return;
                    }
                    if child.try_wait().ok().flatten().is_some() {
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                life.pids.lock().unwrap().retain(|p| *p != pid);
                if xvfb {
                    life.xvfb.store(0, Ordering::SeqCst);
                }
                if start.elapsed() > Duration::from_secs(30) {
                    delay = 1;
                }
                for _ in 0..delay * 10 {
                    if life.stop.load(Ordering::SeqCst) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                delay = (delay * 2).min(30);
                loop {
                    if life.stop.load(Ordering::SeqCst) {
                        return;
                    }
                    if !xvfb
                        && (life.xvfb.load(Ordering::SeqCst) == 0
                            || connect_display(display, &cookie, Duration::from_secs(1)).is_err())
                    {
                        // The private cookie is supplied explicitly below; never start the WM
                        // until the restarted X server is accepting connections.
                        thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                    match command.spawn() {
                        Ok(c) => {
                            child = c;
                            break;
                        }
                        Err(_) => thread::sleep(Duration::from_secs(1)),
                    }
                }
            }
        });
        self.threads.lock().unwrap().push(handle);
        Ok(())
    }
    pub fn stop(&self) {
        self.life.xvfb.store(0, Ordering::SeqCst);
        self.life.stop.store(true, Ordering::SeqCst);
        for pid in self.life.pids.lock().unwrap().iter() {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(*pid as i32),
                nix::sys::signal::Signal::SIGTERM,
            );
        }
        for handle in self.threads.lock().unwrap().drain(..) {
            let _ = handle.join();
        }
        self.life.pids.lock().unwrap().clear();
        self.life.xvfb.store(0, Ordering::SeqCst);
    }
    fn screenshot(&self, q: u8, budget: Duration) -> OpResult<Value> {
        let conn = self.connect_for(budget)?;
        let setup = conn.setup();
        let screen = &setup.roots[0];
        let reply = conn
            .get_image(
                ImageFormat::Z_PIXMAP,
                screen.root,
                0,
                0,
                screen.width_in_pixels,
                screen.height_in_pixels,
                u32::MAX,
            )
            .map_err(failed)?
            .reply()
            .map_err(failed)?;
        let format = setup
            .pixmap_formats
            .iter()
            .find(|f| f.depth == reply.depth)
            .ok_or_else(|| unavailable("unknown X pixel format"))?;
        if format.bits_per_pixel != 32 {
            return Err(unavailable("only 32-bit X pixels are supported"));
        }
        let visual = screen
            .allowed_depths
            .iter()
            .flat_map(|d| &d.visuals)
            .find(|v| v.visual_id == screen.root_visual)
            .ok_or_else(|| unavailable("unknown root visual"))?;
        let mut rgb = Vec::with_capacity(
            screen.width_in_pixels as usize * screen.height_in_pixels as usize * 3,
        );
        for p in reply.data.chunks_exact(4) {
            let raw = if setup.image_byte_order == ImageOrder::LSB_FIRST {
                u32::from_le_bytes(p.try_into().unwrap())
            } else {
                u32::from_be_bytes(p.try_into().unwrap())
            };
            for mask in [visual.red_mask, visual.green_mask, visual.blue_mask] {
                rgb.push(if mask == 0 {
                    0
                } else {
                    ((raw & mask) >> mask.trailing_zeros()) as u8
                });
            }
        }
        encode_screenshot(
            &rgb,
            screen.width_in_pixels.into(),
            screen.height_in_pixels.into(),
            q,
        )
    }
}
impl Drop for Desktop {
    fn drop(&mut self) {
        self.stop();
    }
}
fn connect_display(
    display: u16,
    cookie: &[u8],
    budget: Duration,
) -> OpResult<RustConnection<DeadlineStream>> {
    let stream = UnixStream::connect(format!("/tmp/.X11-unix/X{}", display))
        .map_err(|e| unavailable(e.to_string()))?;
    let (stream, _) = DefaultStream::from_unix_stream(stream)?;
    RustConnection::connect_to_stream_with_auth_info(
        DeadlineStream {
            stream,
            deadline: Instant::now() + budget,
        },
        0,
        b"MIT-MAGIC-COOKIE-1".to_vec(),
        cookie.to_vec(),
    )
    .map_err(|_| unavailable("X server did not accept the private cookie"))
}
fn sandbox_failure(text: &str) -> String {
    text.lines()
        .find_map(|line| {
            line.find("No usable sandbox")
                .or_else(|| line.find("namespace"))
                .map(|i| &line[i..])
        })
        .unwrap_or("Chromium sandbox self-test failed")
        .chars()
        .take(256)
        .collect()
}
fn alive_result(result: std::result::Result<(), nix::errno::Errno>) -> bool {
    matches!(result, Ok(()) | Err(nix::errno::Errno::EPERM))
}
pub fn required_binaries(agent_apps: bool) -> Vec<&'static str> {
    let mut binaries = vec!["Xvfb", "openbox", "xdotool", "xclip", "chromium"];
    if agent_apps {
        binaries.extend(["dbus-daemon", "agent-desktop"]);
    }
    binaries
}
fn missing_package(binary: &str) -> Fault {
    unavailable(format!(
        "{binary} is missing. {}",
        crate::privilege::Problem::Desktop.explain("user", "desktop")
    ))
}
fn encode_screenshot(rgb: &[u8], width: u32, height: u32, q: u8) -> OpResult<Value> {
    let mut bytes = vec![];
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, q)
        .encode(rgb, width, height, image::ExtendedColorType::Rgb8)
        .map_err(failed)?;
    let data = STANDARD.encode(bytes);
    if data.len() > 3 << 20 {
        return Err(Fault::new(
            "too_large",
            "screenshot exceeds 3 MiB; use lower quality",
        ));
    }
    Ok(json!({"data_b64":data,"width":width,"height":height,"media_type":"image/jpeg"}))
}
fn write_xauthority(path: &Path, display: u16, cookie: &[u8]) -> OpResult<()> {
    let mut data = vec![255, 255];
    for part in [
        b"".as_slice(),
        display.to_string().as_bytes(),
        b"MIT-MAGIC-COOKIE-1",
        cookie,
    ] {
        data.extend_from_slice(&(part.len() as u16).to_be_bytes());
        data.extend_from_slice(part);
    }
    crate::instance::atomic_write(path, &data).map_err(|e| unavailable(e.to_string()))
}
struct Finished {
    status: std::process::ExitStatus,
    data: Vec<u8>,
    errors: std::sync::mpsc::Receiver<Vec<u8>>,
    deadline: Instant,
}
fn run_process(
    mut command: Command,
    input: Option<&str>,
    budget: Duration,
    cap: usize,
) -> OpResult<Finished> {
    if budget.is_zero() {
        return Err(Fault::new(
            "op_failed",
            "desktop operation timed out before it could start",
        ));
    }
    let capture = cap > 0;
    if capture {
        command.stderr(Stdio::piped());
    }
    command.stdout(if capture {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().map_err(failed)?;
    let pid = child.id();
    let out = child.stdout.take();
    let error = child.stderr.take();
    let (error_sender, error_receiver) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(error) = error {
            let _ = error.take(65537).read_to_end(&mut bytes);
        }
        let _ = error_sender.send(bytes);
    });
    let (sender, receiver) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut data = Vec::new();
        if let Some(out) = out {
            let _ = out.take(cap as u64 + 1).read_to_end(&mut data);
        }
        let _ = sender.send(data);
    });
    if let Some(input) = input {
        let mut pipe = child.stdin.take().unwrap();
        let data = input.as_bytes().to_vec();
        thread::spawn(move || {
            let _ = pipe.write_all(&data);
        });
    }
    let deadline = Instant::now() + budget;
    let mut captured = None;
    let status = loop {
        if captured.is_none()
            && let Ok(data) = receiver.try_recv()
        {
            if data.len() > cap {
                crate::computer::kill_group(pid);
                let _ = child.wait();
                return Err(Fault::new(
                    "too_large",
                    "desktop result exceeds its size limit",
                ));
            }
            captured = Some(data);
        }
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if Instant::now() >= deadline {
            crate::computer::kill_group(pid);
            let _ = child.wait();
            return Err(Fault::new("op_failed", "desktop helper timed out"));
        }
        thread::sleep(Duration::from_millis(5));
    };
    let data = match captured {
        Some(data) => data,
        None => receiver
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .map_err(|_| Fault::new("op_failed", "desktop output pipe timed out"))?,
    };
    if data.len() > cap {
        return Err(Fault::new(
            "too_large",
            "desktop result exceeds its size limit",
        ));
    }
    Ok(Finished {
        status,
        data,
        errors: error_receiver,
        deadline,
    })
}
fn run_helper(
    command: Command,
    input: Option<&str>,
    budget: Duration,
    cap: usize,
) -> OpResult<Vec<u8>> {
    let sandbox = command.get_program() == "chromium";
    let finished = run_process(command, input, budget, cap)?;
    let data = finished.data;
    if !finished.status.success() {
        let error = finished
            .errors
            .recv_timeout(finished.deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_default();
        let text = String::from_utf8_lossy(&error);
        if text.contains("not available") {
            return Ok(vec![]);
        }
        let message = if sandbox {
            sandbox_failure(&text)
        } else {
            "desktop helper failed; check desktop packages".into()
        };
        return Err(Fault::new("op_failed", message));
    }
    Ok(data)
}
pub async fn dispatch(
    desktop: Option<&Desktop>,
    frame: &Value,
    config: &crate::instance::ComputerConfig,
) -> OpResult<Value> {
    let op = frame["op"].as_str().unwrap_or("");
    if matches!(op, "desktop_snapshot" | "desktop_act" | "desktop_apps") {
        return apps::dispatch(desktop, frame, config).await;
    }
    let read_only = config.read_only;
    let typed = match op {
        "desktop_screenshot" => {
            quality(frame)?;
            0
        }
        "desktop_input" => validate_actions(frame)?,
        "desktop_clipboard_set" => {
            validate_clipboard(frame)?;
            0
        }
        "desktop_clipboard_get" => 0,
        _ => return Err(Fault::new("unknown_op", "unknown desktop operation")),
    };
    if read_only && matches!(op, "desktop_input" | "desktop_clipboard_set") {
        return Err(Fault::new(
            "read_only",
            "this computer refuses desktop writes",
        ));
    }
    let d = desktop.ok_or_else(|| unavailable("desktop is not running; use --desktop"))?;
    let budget = Duration::from_millis(match op {
        "desktop_screenshot" => 4000,
        "desktop_input" => 2000 + typed as u64 * 5,
        _ => 2500,
    });
    let start = Instant::now();
    let slots = if op == "desktop_screenshot" {
        &d.shots
    } else {
        &d.turn
    };
    let _permit = tokio::time::timeout(budget, slots.acquire())
        .await
        .map_err(|_| Fault::new("op_failed", "desktop busy"))?
        .map_err(|_| unavailable("desktop stopped"))?;
    if !d.owns() {
        return Err(unavailable("X server is not owned by this desktop"));
    }
    // Helpers have process deadlines; run blocking operations away from the socket read loop.
    tokio::task::block_in_place(|| match op {
        "desktop_screenshot" => {
            d.screenshot(quality(frame)?, budget.saturating_sub(start.elapsed()))
        }
        "desktop_input" => {
            for action in frame["actions"].as_array().unwrap() {
                for (args, input) in steps(action) {
                    let remaining = budget
                        .checked_sub(start.elapsed())
                        .ok_or_else(|| Fault::new("op_failed", "desktop input timed out"))?;
                    let mut command = d.command("xdotool");
                    command.args(args);
                    run_helper(command, input.as_deref(), remaining, 1024)?;
                }
            }
            Ok(json!({"ok":true}))
        }
        "desktop_clipboard_get" => {
            let mut c = d.command("xclip");
            c.args(["-selection", "clipboard", "-o", "-t", "UTF8_STRING"]);
            let data = run_helper(c, None, budget.saturating_sub(start.elapsed()), 65536)?;
            Ok(json!({"text":String::from_utf8_lossy(&data)}))
        }
        "desktop_clipboard_set" => {
            for s in frame["selections"].as_array().unwrap() {
                let mut c = d.command("xclip");
                c.args(["-selection", s.as_str().unwrap(), "-i"]);
                c.stdout(Stdio::null());
                run_helper(
                    c,
                    frame["text"].as_str(),
                    budget.saturating_sub(start.elapsed()),
                    0,
                )?;
            }
            Ok(json!({"ok":true}))
        }
        _ => unreachable!(),
    })
}

#[cfg(test)]
static DISPLAY_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn validation_matches_protocol_limits_and_blocks_command_injection() {
        for keys in ["ctrl+a", "Return", "Alt+F4"] {
            assert!(validate_actions(&json!({"actions":[{"type":"key","keys":keys}]})).is_ok());
        }
        for keys in [
            "",
            "exec",
            "WindowKill",
            "--clearmodifiers",
            "ctrl+a sleep 1",
            "ctrl++a",
        ] {
            assert!(validate_actions(&json!({"actions":[{"type":"key","keys":keys}]})).is_err());
        }
        for a in [
            json!({"type":"mouse_move","x":1280,"y":0}),
            json!({"type":"click","x":0,"y":0,"button":"left","count":4}),
            json!({"type":"type","text":"x".repeat(513)}),
            json!({"type":"scroll","x":0,"y":0,"dx":50,"dy":50}),
            json!({"type":"unknown"}),
        ] {
            assert!(validate_actions(&json!({"actions":[a]})).is_err());
        }
        assert!(validate_actions(&json!({"actions":[]})).is_err());
        for q in [0, 96, -1] {
            assert!(quality(&json!({"quality":q})).is_err());
        }
        assert_eq!(quality(&json!({})).unwrap(), 60);
        assert!(
            validate_clipboard(&json!({"text":"ok","selections":["clipboard","primary"]})).is_ok()
        );
        for selections in [
            json!([]),
            json!(["clipboard", "clipboard"]),
            json!(["other"]),
        ] {
            assert!(validate_clipboard(&json!({"text":"ok","selections":selections})).is_err());
        }
    }
    #[test]
    fn input_steps_keep_text_out_of_argv_and_use_contract_delays() {
        let s = steps(&json!({"type":"type","text":"secret"}));
        assert_eq!(s[0].1.as_deref(), Some("secret"));
        assert!(!s[0].0.contains(&"secret".into()));
        assert_eq!(s[0].0, vec!["type", "--delay", "2", "--file", "-"]);
        let s = steps(&json!({"type":"scroll","x":3,"y":4,"dx":-2,"dy":1}));
        assert_eq!(s.len(), 3);
        assert_eq!(s[1].0.last().unwrap(), "5");
        assert_eq!(s[2].0.last().unwrap(), "6");
    }
    #[test]
    fn xauthority_format_mode_and_live_display_refusal() {
        let _display = DISPLAY_TEST_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth");
        write_xauthority(&path, 90, &[1; 16]).unwrap();
        let data = fs::read(&path).unwrap();
        assert_eq!(&data[..6], &[255, 255, 0, 0, 0, 2]);
        assert!(data.windows(18).any(|w| w == b"MIT-MAGIC-COOKIE-1"));
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let display = crate::instance::free_display(&[], Path::new("/tmp")).unwrap();
        let lock = format!("/tmp/.X{display}-lock");
        fs::write(&lock, std::process::id().to_string()).unwrap();
        let result = Desktop::start(dir.path(), display, false);
        let _ = fs::remove_file(lock);
        assert!(result.is_err());
    }
    #[test]
    fn real_xvfb_capture_ownership_and_cleanup() {
        if std::env::var("AGENTUM_DESKTOP_E2E").as_deref() != Ok("1") {
            return;
        }
        let _display = DISPLAY_TEST_LOCK.lock().unwrap();
        if !crate::privilege::on_path("Xvfb") {
            writeln!(
                std::io::stderr(),
                "Xvfb missing; skipping real display test"
            )
            .unwrap();
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let display = crate::instance::free_display(&[], Path::new("/tmp")).unwrap();
        let d = Desktop::start(dir.path(), display, false).unwrap();
        let result = d.screenshot(60, Duration::from_secs(4)).unwrap();
        assert_eq!(result["width"], 1280);
        assert_eq!(result["height"], 800);
        let jpeg = STANDARD
            .decode(result["data_b64"].as_str().unwrap())
            .unwrap();
        assert!(image::load_from_memory(&jpeg).is_ok());
        let pid = d.life.xvfb.swap(0, Ordering::SeqCst);
        assert!(d.connect().is_err());
        d.life.xvfb.store(pid, Ordering::SeqCst);
        d.stop();
        assert!(!d.owns());
    }
    #[test]
    fn helpers_have_deadlines_and_result_caps() {
        let mut c = Command::new("sh");
        c.args(["-c", "sleep 30"]).process_group(0);
        let start = Instant::now();
        assert!(run_helper(c, None, Duration::from_millis(20), 100).is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
        let mut c = Command::new("printf");
        c.arg("12345");
        assert_eq!(
            run_helper(c, None, Duration::from_secs(1), 4)
                .unwrap_err()
                .code,
            "too_large"
        );
    }
}

#[cfg(test)]
mod helper_failure_tests {
    #[test]
    fn missing_desktop_helper_is_an_operation_failure() {
        let error = super::run_helper(
            std::process::Command::new("/no-such-agentum-desktop-helper"),
            None,
            std::time::Duration::from_secs(1),
            100,
        )
        .unwrap_err();
        assert_eq!(error.code, "op_failed");
    }
}

#[cfg(test)]
mod review_tests {
    use super::*;
    #[test]
    fn display_lock_eperm_means_alive() {
        assert!(alive_result(Err(nix::errno::Errno::EPERM)));
        assert!(alive_result(Ok(())));
        assert!(!alive_result(Err(nix::errno::Errno::ESRCH)));
    }
    #[test]
    fn clipboard_read_stops_at_the_cap() {
        let mut c = Command::new("sh");
        c.args(["-c", "head -c 10000000 /dev/zero"])
            .process_group(0);
        assert_eq!(
            run_helper(c, None, Duration::from_secs(2), 65536)
                .unwrap_err()
                .code,
            "too_large"
        );
    }
    #[test]
    fn no_selection_recognises_xclip() {
        for (text, empty) in [
            ("Error: target UTF8_STRING not available", true),
            ("Error: Can't open display: :99", false),
        ] {
            let mut c = Command::new("sh");
            c.args(["-c", "printf '%s' \"$1\" >&2; exit 1", "sh", text]);
            assert_eq!(
                run_helper(c, None, Duration::from_secs(1), 65536).is_ok(),
                empty
            );
        }
    }
    #[test]
    fn encode_screenshot_refuses_an_oversized_frame() {
        let noise: Vec<u8> = (0..2000 * 2000 * 3).map(|_| rand::random()).collect();
        assert_eq!(
            encode_screenshot(&noise, 2000, 2000, 95).unwrap_err().code,
            "too_large"
        );
        let small = encode_screenshot(&[0; 32 * 16 * 3], 32, 16, 95).unwrap();
        assert_eq!(small["width"], 32);
        assert_eq!(small["height"], 16);
        assert_eq!(small["media_type"], "image/jpeg");
    }
    #[test]
    fn missing_package_reason_names_the_binary() {
        assert!(missing_package("Xvfb").message.contains("Xvfb"));
        assert!(missing_package("xclip").message.contains("xclip"));
    }
}

#[cfg(test)]
mod parity_tests {
    use super::*;
    #[test]
    fn self_test_failure_names_the_sandbox() {
        assert!(sandbox_failure("noise\n[9:9:ERROR:zygote_host_impl_linux.cc:129] No usable sandbox! If this is Debian...").starts_with("No usable sandbox!"));
        assert_eq!(
            sandbox_failure("noise"),
            "Chromium sandbox self-test failed"
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn real_desktop_end_to_end_and_sandbox() {
        if std::env::var("AGENTUM_DESKTOP_E2E").as_deref() != Ok("1") {
            return;
        }
        let _display = DISPLAY_TEST_LOCK.lock().unwrap();
        if let Some(binary) = required_binaries(false)
            .iter()
            .find(|b| !crate::privilege::on_path(b))
        {
            writeln!(
                std::io::stderr(),
                "{binary} missing; skipping desktop end-to-end and sandbox tests"
            )
            .unwrap();
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let display = crate::instance::free_display(&[], Path::new("/tmp")).unwrap();
        let d = match Desktop::launch(dir.path(), display, false) {
            Ok(d) => d,
            Err(e) => {
                assert!(e.message.contains("sandbox"), "{}", e.message);
                return;
            }
        };
        dispatch(
            Some(&d),
            &json!({"op":"desktop_input","actions":[{"type":"mouse_move","x":10,"y":20}]}),
            &Default::default(),
        )
        .await
        .unwrap();
        dispatch(Some(&d), &json!({"op":"desktop_clipboard_set","text":"clipboard round trip","selections":["clipboard"]}), &Default::default()).await.unwrap();
        let result = dispatch(
            Some(&d),
            &json!({"op":"desktop_clipboard_get"}),
            &Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(result["text"], "clipboard round trip");
        let result = dispatch(
            Some(&d),
            &json!({"op":"desktop_screenshot"}),
            &Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(result["width"], 1280);
        assert_eq!(result["media_type"], "image/jpeg");
    }
}

#[cfg(test)]
mod restart_tests {
    use super::*;
    #[test]
    fn openbox_restart_waits_for_xvfb() {
        if std::env::var("AGENTUM_DESKTOP_E2E").as_deref() != Ok("1") {
            return;
        }
        let _display = DISPLAY_TEST_LOCK.lock().unwrap();
        if !crate::privilege::on_path("Xvfb") {
            writeln!(
                std::io::stderr(),
                "Xvfb missing; skipping window manager restart test"
            )
            .unwrap();
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let display = crate::instance::free_display(&[], Path::new("/tmp")).unwrap();
        let d = Desktop::start(dir.path(), display, false).unwrap();
        let marker = dir.path().join("wm-starts");
        let mut command = d.command("sh");
        command
            .args(["-c", "echo started >> \"$1\"; exec sleep 30", "sh"])
            .arg(&marker);
        d.supervise(command, false).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() || d.life.pids.lock().unwrap().len() < 2 {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        let xvfb = d.life.xvfb.swap(0, Ordering::SeqCst);
        let wm = *d
            .life
            .pids
            .lock()
            .unwrap()
            .iter()
            .find(|p| **p != xvfb)
            .unwrap();
        crate::computer::kill_group(wm);
        thread::sleep(Duration::from_millis(1300));
        assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 1);
        d.life.xvfb.store(xvfb, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(5);
        while fs::read_to_string(&marker).unwrap().lines().count() < 2 {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
    }
}
