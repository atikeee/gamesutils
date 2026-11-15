@echo off
setlocal enabledelayedexpansion

echo =======================================================
echo   MM TV Player - Build, Connect and Install Script
echo =======================================================
echo.

:: 1. Check for gradlew or gradle
if exist "gradlew.bat" (
    set GRADLE_CMD=gradlew.bat
) else (
    set GRADLE_CMD=gradle
)

:: Release any background locks held by previous daemon runs
echo Stopping any background Gradle daemons to release file locks...
call %GRADLE_CMD% --stop >nul 2>&1

echo.
echo [1/4] Building Native Android TV APK...
call %GRADLE_CMD% assembleDebug
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Build failed! Please check output above.
    pause
    exit /b %ERRORLEVEL%
)

:: Check both redirected C:\tmp and local build paths
set APK_PATH=C:\tmp\androidTVapp\app\outputs\apk\debug\app-debug.apk
if not exist "%APK_PATH%" (
    set APK_PATH=app\build\outputs\apk\debug\app-debug.apk
)

if not exist "%APK_PATH%" (
    echo.
    echo [ERROR] Compiled APK not found! Checked:
    echo   - C:\tmp\androidTVapp\app\outputs\apk\debug\app-debug.apk
    echo   - app\build\outputs\apk\debug\app-debug.apk
    pause
    exit /b 1
)

echo.
echo [2/4] Build succeeded: %APK_PATH%
echo.

:: 2. Connect ADB to TV (Defaults to 192.168.0.245)
set DEFAULT_TV_IP=192.168.0.245
set /p TV_IP="Enter Android TV IP [Press ENTER for %DEFAULT_TV_IP%]: "
if "%TV_IP%"=="" set TV_IP=%DEFAULT_TV_IP%

echo.
echo [3/4] Connecting ADB to %TV_IP%:5555...
adb connect %TV_IP%:5555

echo.
echo [4/4] Installing APK on TV...
adb install -r "%APK_PATH%"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Launching MM TV Player on TV...
    adb shell am start -n com.rahmanma.gamesutils.tv/.MainActivity
    echo.
    echo =======================================================
    echo   SUCCESS! App installed and launched on TV.
    echo =======================================================
) else (
    echo.
    echo [ERROR] Install failed. Check TV Wi-Fi connection and Developer Options.
)

pause
