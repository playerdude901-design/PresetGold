@echo off
title PresetGold - Hotkey de Sistema

rem ============================================================
rem PresetGold Hotkey Launcher
rem Usa Python + APIs nativas de Windows. No requiere AutoHotkey
rem ni programas externos adicionales.
rem ============================================================

set "PY_SCRIPT=%~dp0presetgold_hotkey.py"
set "PY_EXE="
set "PY_ARGS="

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
    echo Instala o habilita Python para usar el hotkey de sistema.
    pause
    exit /b 1
)

echo PresetGold Hotkey de Sistema
echo Python: %PY_EXE%
echo Script: %PY_SCRIPT%
echo.
echo Cerrando instancia anterior si existe...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | ^
   Where-Object { $_.CommandLine -and $_.CommandLine -like '*presetgold_hotkey.py*' } | ^
   ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1

echo Iniciando hotkey en segundo plano...

if defined PY_ARGS (
    start "PresetGold Python Hotkey" /min "%PY_EXE%" %PY_ARGS% "%PY_SCRIPT%"
) else (
    start "PresetGold Python Hotkey" /min "%PY_EXE%" "%PY_SCRIPT%"
)

echo.
echo Listo. Usa el shortcut configurado en PresetGold para abrir/cerrar el panel.
echo Cierra la ventana "PresetGold Python Hotkey" para detenerlo.
timeout /t 4 >nul
exit /b 0
