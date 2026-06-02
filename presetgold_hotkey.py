"""PresetGold system hotkey.

Uses only Python's standard library and native Windows APIs.
No AutoHotkey, no pywin32, no external packages.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import sys
import time
from datetime import datetime, timezone


APP_DIR = Path(__file__).resolve().parent
CONFIG_PATH = APP_DIR / "shortcut_config.json"
COMMAND_PATH = APP_DIR / "panel_command.json"
ACK_PATH = APP_DIR / "panel_command_ack.json"

DEFAULT_LABEL = "Ctrl+Alt+7"
HOTKEY_ID = 0x5057
WM_HOTKEY = 0x0312
PM_REMOVE = 0x0001
SW_RESTORE = 9
TH32CS_SNAPPROCESS = 0x00000002
INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_WIN = 0x0008
MOD_NOREPEAT = 0x4000

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE


class MSG(ctypes.Structure):
    _fields_ = [
        ("hwnd", wintypes.HWND),
        ("message", wintypes.UINT),
        ("wParam", wintypes.WPARAM),
        ("lParam", wintypes.LPARAM),
        ("time", wintypes.DWORD),
        ("pt", wintypes.POINT),
    ]


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.c_void_p),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", wintypes.WCHAR * 260),
    ]


kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.Process32FirstW.restype = wintypes.BOOL
kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
kernel32.Process32NextW.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD


KEY_CODES = {chr(code): code for code in range(ord("A"), ord("Z") + 1)}
KEY_CODES.update({str(i): 0x30 + i for i in range(10)})
KEY_CODES.update({f"F{i}": 0x6F + i for i in range(1, 25)})
KEY_CODES.update(
    {
        "SPACE": 0x20,
        "ENTER": 0x0D,
        "TAB": 0x09,
        "ESC": 0x1B,
        "ESCAPE": 0x1B,
        "BACKSPACE": 0x08,
        "BS": 0x08,
        "DELETE": 0x2E,
        "DEL": 0x2E,
        "INSERT": 0x2D,
        "INS": 0x2D,
        "HOME": 0x24,
        "END": 0x23,
        "PAGEUP": 0x21,
        "PGUP": 0x21,
        "PAGEDOWN": 0x22,
        "PGDN": 0x22,
        "ARROWLEFT": 0x25,
        "LEFT": 0x25,
        "ARROWUP": 0x26,
        "UP": 0x26,
        "ARROWRIGHT": 0x27,
        "RIGHT": 0x27,
        "ARROWDOWN": 0x28,
        "DOWN": 0x28,
    }
)
KEY_CODES.update({f"NUMPAD{i}": 0x60 + i for i in range(10)})

PREMIERE_EXE_NAMES = {
    "adobe premiere pro.exe",
    "premiere pro.exe",
    "premiere.exe",
}


def log(message: str) -> None:
    try:
        if sys.stdout:
            print(message, flush=True)
    except Exception:
        pass


def ensure_config() -> None:
    if CONFIG_PATH.exists():
        return
    CONFIG_PATH.write_text(
        json.dumps(
            {
                "focusShortcut": DEFAULT_LABEL,
                "pythonHotkey": DEFAULT_LABEL,
                "updatedAt": int(time.time() * 1000),
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def read_shortcut_label() -> str:
    ensure_config()
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return str(data.get("pythonHotkey") or data.get("focusShortcut") or DEFAULT_LABEL)
    except Exception:
        return DEFAULT_LABEL


def parse_shortcut(label: str) -> tuple[int, int]:
    modifiers = MOD_NOREPEAT
    key_name = ""

    for raw_part in label.split("+"):
        part = raw_part.strip()
        upper = part.upper()
        if upper in {"CTRL", "CONTROL"}:
            modifiers |= MOD_CONTROL
        elif upper == "ALT":
            modifiers |= MOD_ALT
        elif upper == "SHIFT":
            modifiers |= MOD_SHIFT
        elif upper in {"CMD", "META", "WIN", "WINDOWS"}:
            modifiers |= MOD_WIN
        elif part:
            key_name = upper

    if key_name == "":
        raise ValueError(f"Shortcut sin tecla principal: {label}")

    vk = KEY_CODES.get(key_name)
    if vk is None:
        raise ValueError(f"Tecla no soportada para hotkey de sistema: {key_name}")

    return modifiers, vk


def register_hotkey(label: str) -> bool:
    modifiers, vk = parse_shortcut(label)
    if not user32.RegisterHotKey(None, HOTKEY_ID, modifiers, vk):
        err = kernel32.GetLastError()
        raise OSError(err, f"No se pudo registrar el shortcut: {label}")
    return True


def unregister_hotkey() -> None:
    user32.UnregisterHotKey(None, HOTKEY_ID)


def get_premiere_process_ids() -> set[int]:
    pids: set[int] = set()
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == INVALID_HANDLE_VALUE:
        return pids

    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)

    try:
        has_entry = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while has_entry:
            exe_name = entry.szExeFile.lower()
            if exe_name in PREMIERE_EXE_NAMES or ("premiere" in exe_name and "pro" in exe_name):
                pids.add(int(entry.th32ProcessID))
            has_entry = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)

    return pids


def find_premiere_window() -> int:
    found = wintypes.HWND()
    premiere_pids = get_premiere_process_ids()

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True

        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if int(pid.value) in premiere_pids:
            found.value = hwnd
            return False

        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True

        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        title = buffer.value
        if "Adobe Premiere Pro" in title:
            found.value = hwnd
            return False
        return True

    user32.EnumWindows(enum_proc, 0)
    return int(found.value or 0)


def activate_window(hwnd: int) -> None:
    if not hwnd:
        return
    user32.ShowWindow(hwnd, SW_RESTORE)
    user32.SetForegroundWindow(hwnd)


def send_toggle_command() -> str:
    command_id = f"{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{time.monotonic_ns()}"
    payload = {
        "id": command_id,
        "action": "toggle",
        "source": "python",
        "createdAtUtc": datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S"),
        "ts": int(time.time() * 1000),
    }

    tmp_path = COMMAND_PATH.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    tmp_path.replace(COMMAND_PATH)
    return command_id


def wait_for_ack(command_id: str, timeout: float = 0.9) -> bool:
    deadline = time.monotonic() + timeout
    needle = f'"id":"{command_id}"'
    pretty_needle = f'"id": "{command_id}"'

    while time.monotonic() < deadline:
        try:
            if ACK_PATH.exists():
                text = ACK_PATH.read_text(encoding="utf-8")
                if needle in text or pretty_needle in text:
                    return True
        except Exception:
            pass
        time.sleep(0.05)

    return False


def handle_hotkey() -> None:
    hwnd = find_premiere_window()
    if not hwnd:
        if not get_premiere_process_ids():
            log("Adobe Premiere Pro no esta abierto.")
            return
        log("Premiere esta abierto, pero no encontre su ventana principal. Enviare el comando igual.")
    else:
        activate_window(hwnd)

    command_id = send_toggle_command()
    if not wait_for_ack(command_id):
        log("Comando enviado. El servicio de PresetGold lo procesara cuando este activo.")


def main() -> int:
    ensure_config()

    current_label = ""
    current_stamp = 0.0
    msg = MSG()

    log("PresetGold hotkey iniciado. Cierra esta ventana para detenerlo.")

    try:
        while True:
            try:
                stamp = CONFIG_PATH.stat().st_mtime
            except OSError:
                ensure_config()
                stamp = CONFIG_PATH.stat().st_mtime

            if stamp != current_stamp:
                next_label = read_shortcut_label()
                if next_label != current_label:
                    previous_label = current_label
                    if current_label:
                        unregister_hotkey()
                    try:
                        register_hotkey(next_label)
                        current_label = next_label
                        log(f"Shortcut activo: {current_label}")
                    except OSError as exc:
                        log(str(exc))
                        current_label = ""
                        if previous_label:
                            try:
                                register_hotkey(previous_label)
                                current_label = previous_label
                            except OSError:
                                pass
                current_stamp = stamp

            while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
                if msg.message == WM_HOTKEY and msg.wParam == HOTKEY_ID:
                    handle_hotkey()
                user32.TranslateMessage(ctypes.byref(msg))
                user32.DispatchMessageW(ctypes.byref(msg))

            time.sleep(0.05)
    except KeyboardInterrupt:
        return 0
    finally:
        unregister_hotkey()


if __name__ == "__main__":
    if sys.platform != "win32":
        raise SystemExit("PresetGold hotkey solo esta disponible en Windows.")
    raise SystemExit(main())
