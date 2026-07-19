@echo off
setlocal enabledelayedexpansion
REM ============================================================================
REM  Sakura — signed Seeker release build
REM
REM  Reproduces the exact process that produced the working 1.9.x Seeker
REM  releases: local Gradle assembleRelease, arm64-v8a only (Seeker/Saga),
REM  signed with the ORIGINAL dApp Store keystore at ..\android\
REM  sakura-release.keystore (cert SHA1 B6:C7:C6:BA:A0:CA:69:40:31:52:00:E5:
REM  42:77:00:E6:4A:32:8D:98). Run from anywhere:
REM      sakura-mobile\build-seeker-release.bat
REM ============================================================================

cd /d "%~dp0"

REM ── read versionName from android\app\build.gradle ──
set "VERSION="
for /f "tokens=2 delims= " %%v in ('findstr /c:"versionName " android\app\build.gradle') do set "VERSION=%%~v"
if "%VERSION%"=="" (
    echo [ERROR] Could not read versionName from android\app\build.gradle
    pause & exit /b 1
)
echo == Building Sakura %VERSION% (Seeker / arm64-v8a) ==

REM ── preflight ──
where node >nul 2>nul || (echo [ERROR] node not in PATH & exit /b 1)

REM ── ensure a JDK is available (Gradle needs JAVA_HOME or java on PATH) ──
if not defined JAVA_HOME (
    where java >nul 2>nul || (
        for %%J in (
            "%ProgramFiles%\Android\Android Studio\jbr"
            "%LOCALAPPDATA%\Programs\Android Studio\jbr"
        ) do if exist "%%~J\bin\java.exe" set "JAVA_HOME=%%~J"
    )
)
if defined JAVA_HOME echo == Using JAVA_HOME=%JAVA_HOME% ==
if not defined JAVA_HOME (
    where java >nul 2>nul || (
        echo [ERROR] No JDK found. Set JAVA_HOME or install Android Studio.
        exit /b 1
    )
)

if not exist "..\android\sakura-release.keystore" (
    echo [ERROR] Keystore ..\android\sakura-release.keystore not found.
    echo         This MUST be the original Seeker cert. Do NOT substitute
    echo         android\app\sakura-release.keystore — that is a different key
    echo         and Seeker devices would refuse the update.
    exit /b 1
)

if not exist "android\local.properties" (
    echo [ERROR] android\local.properties missing (sdk.dir=...^)
    exit /b 1
)

if not exist "node_modules" (
    echo == node_modules missing — running npm install ==
    call npm install || exit /b 1
)

REM ── build ──
REM  reanimated/worklets default to CMake 3.22.1 (env override honored), whose
REM  ninja loops forever ("build.ninja still dirty after 100 tries") on this
REM  machine. 3.31.6 is installed in the SDK and pinned via local.properties
REM  cmake.dir; this env var makes reanimated/worklets request the same one.
set "CMAKE_VERSION=3.31.6"
cd android

REM ── purge stale CMake native caches ──
REM  A leftover .cxx (esp. a Debug config from an Android Studio run) makes
REM  `gradlew clean` reconfigure native for a variant whose codegen dirs don't
REM  exist yet, failing with "add_subdirectory ... which is not an existing
REM  directory". Removing every .cxx forces a fresh, correct configure.
echo == purging stale .cxx caches ==
if exist "app\.cxx" rmdir /s /q "app\.cxx"
if exist "app\build\generated\autolinking" rmdir /s /q "app\build\generated\autolinking"
for /d %%m in ("..\node_modules\*") do if exist "%%~m\android\.cxx" rmdir /s /q "%%~m\android\.cxx"

echo == gradlew clean ==
call .\gradlew.bat clean || exit /b 1

echo == gradlew assembleRelease (arm64-v8a) ==
call .\gradlew.bat assembleRelease -PreactNativeArchitectures=arm64-v8a || exit /b 1
cd ..

set "OUT=android\app\build\outputs\apk\release\app-release.apk"
if not exist "%OUT%" (
    echo [ERROR] Build finished but %OUT% not found.
    exit /b 1
)

set "DEST=sakura-%VERSION%-seeker-release.apk"
copy /y "%OUT%" "%DEST%" >nul
echo == Output: %~dp0%DEST% ==

REM ── verify signing cert matches the live Seeker app ──
REM  keytool can't read v2/v3 APK signatures ("Not a signed jar file"); use
REM  apksigner from the newest build-tools instead.
echo == Signing certificate (expect SHA-1 b6c7c6baa0ca6940315200e5427700e64a328d98) ==
set "APKSIGNER="
for /d %%b in ("%LOCALAPPDATA%\Android\Sdk\build-tools\*") do if exist "%%~b\apksigner.bat" set "APKSIGNER=%%~b\apksigner.bat"
if defined APKSIGNER (
    set "PATH=%JAVA_HOME%\bin;%PATH%"
    call "!APKSIGNER!" verify --print-certs "%DEST%" | findstr /c:"SHA-1"
) else (
    echo [WARN] apksigner not found - verify the signature manually.
)

echo.
echo Done. Sideload with: adb install -r "%DEST%"
echo Then attach it to a GitHub release / app-update.json for the in-app updater.
endlocal
