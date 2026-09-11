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

REM -- ensure a SUPPORTED JDK is available --
REM  Order matters: Android Studio ships a JBR far ahead of what the Android
REM  Gradle Plugin supports, and taking it unconditionally is what broke the
REM  2.0.12 build. Its JBR 25.0.2 failed EVERY configureCMake task
REM  (react-native-screens, expo-updates, react-native-worklets) with
REM      "WARNING: A restricted method in java.lang.System has been called"
REM  about 20 minutes in - JDK 24+ turned restricted native-access calls into
REM  hard failures. Nothing in that message names Java, so it reads like a
REM  broken native module. Temurin 17 was installed the whole time. So: prefer
REM  a supported JDK, and refuse an unsupported one up front rather than 20
REM  minutes into a build.
if not defined JAVA_HOME (
    for %%J in (
        "%USERPROFILE%\.jdks\temurin-17"
        "%USERPROFILE%\.jdks\temurin-21"
        "%ProgramFiles%\Eclipse Adoptium\jdk-17"
        "%ProgramFiles%\Eclipse Adoptium\jdk-21"
        "%ProgramFiles%\Android\Android Studio\jbr"
        "%LOCALAPPDATA%\Programs\Android Studio\jbr"
    ) do if not defined JAVA_HOME if exist "%%~J\bin\java.exe" set "JAVA_HOME=%%~J"
)
REM  Last resort: derive JAVA_HOME from a java.exe already on PATH, so a JDK
REM  installed somewhere unlisted still works - and still gets version-checked.
if not defined JAVA_HOME (
    for /f "delims=" %%j in ('where java 2^>nul') do if not defined JAVA_HOME for %%k in ("%%~dpj..") do set "JAVA_HOME=%%~fk"
)
if not defined JAVA_HOME (
    echo [ERROR] No JDK found. Install Temurin 17, or set JAVA_HOME.
    exit /b 1
)
if not exist "%JAVA_HOME%\bin\java.exe" (
    echo [ERROR] JAVA_HOME=%JAVA_HOME% has no bin\java.exe
    exit /b 1
)
set "PATH=%JAVA_HOME%\bin;%PATH%"

set "JV="
set "JAVA_MAJOR="
for /f "tokens=3" %%v in ('java -version 2^>^&1 ^| findstr /i "version"') do if not defined JV set "JV=%%~v"
for /f "delims=.-+_ tokens=1" %%m in ("!JV!") do set "JAVA_MAJOR=%%m"
echo == Using JAVA_HOME=%JAVA_HOME%  (Java !JV!) ==
REM  The refusal sets a flag and exits AFTER the block, rather than `exit /b 1`
REM  in place. Measured on this machine: an `exit /b 1` inside a nested `if`
REM  that sits in an `else` block and is followed by a sibling `if` prints its
REM  message and stops the script, but cmd reports ERRORLEVEL 0 to the caller.
REM  Drop either the `else` or the second `if` and the same code returns 1. So
REM  the guard would have refused the build while telling any wrapper or CI step
REM  that it succeeded - the exact failure mode this guard exists to prevent.
set "JDK_BAD="
if "!JAVA_MAJOR!"=="" (
    echo [WARN] Could not parse the Java version; continuing unchecked.
) else (
    if !JAVA_MAJOR! GEQ 22 (
        echo [ERROR] Java !JAVA_MAJOR! is not supported by the Android Gradle Plugin.
        echo         Every configureCMake task will fail about 20 minutes in with
        echo         a misleading "restricted method in java.lang.System" error.
        echo         Point JAVA_HOME at a JDK 17 or 21 and re-run, e.g.
        echo             set "JAVA_HOME=%USERPROFILE%\.jdks\temurin-17"
        set "JDK_BAD=1"
    )
    if !JAVA_MAJOR! LSS 17 (
        echo [ERROR] Java !JAVA_MAJOR! is too old; this build needs JDK 17 or 21.
        set "JDK_BAD=1"
    )
)
if defined JDK_BAD exit /b 1

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
