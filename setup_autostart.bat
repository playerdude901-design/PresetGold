@echo off
title PresetGold - Configurar Inicio Automatico

rem ============================================================
rem Agrega el hotkey Python de PresetGold al inicio de Windows.
rem Usa Python + APIs nativas de Windows, sin AutoHotkey.
rem ============================================================

set "PY_SCRIPT=%~dp0presetgold_hotkey.py"
set "PY_EXE="
set "PY_ARGS="
set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\PresetGold_Hotkey.lnk"

if not exist "%PY_SCRIPT%" (
    echo [ERROR] No se encontro presetgold_hotkey.py.
    pause
    exit /b 1
)

for /f "delims=" %%P in ('where py 2^>nul') do (
    if not defined PY_EXE (
        set "PY_EXE=%%P"
        set "PY_ARGS=-3"
    )
)

if not defined PY_EXE (
    for /f "delims=" %%P in ('where pythonw 2^>nul') do (
        if not defined PY_EXE set "PY_EXE=%%P"
    )
)

if not defined PY_EXE (
    for /f "delims=" %%P in ('where python 2^>nul') do (
        if not defined PY_EXE set "PY_EXE=%%P"
    )
)

if not defined PY_EXE (
    echo [ERROR] No se encontro Python en Windows.
    echo PresetGold ahora usa Python estandar y APIs nativas de Windows.
    pause
    exit /b 1
)

if defined PY_ARGS (
    set "LNK_ARGS=%PY_ARGS% \"%PY_SCRIPT%\""
) else (
    set "LNK_ARGS=\"%PY_SCRIPT%\""
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; ^
   $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); ^
   $s.TargetPath = '%PY_EXE%'; ^
   $s.Arguments = '%LNK_ARGS%'; ^
   $s.WorkingDirectory = '%~dp0'; ^
   $s.Description = 'PresetGold Python Hotkey - abrir/cerrar panel'; ^
   $s.Save()"

if exist "%SHORTCUT_PATH%" (
    echo Auto-inicio configurado correctamente.
    echo El hotkey de PresetGold se activara cuando inicies Windows.
) else (
    echo [ERROR] No se pudo crear el acceso directo.
)

echo.
pause
