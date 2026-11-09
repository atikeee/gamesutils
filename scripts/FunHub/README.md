# 📺 FunHub - Android TV App

A lightweight Android TV web wrapper for **`gamesutils`**, with a custom launcher icon and TV banner. It opens Catan, Catan 2, MM MP3, and MM TV at `https://atiq.us`.

---

## 📁 Project Structure

```text
FunHub/
│
├── build.gradle               # Root Gradle build script
├── settings.gradle            # Module include definitions
├── gradle.properties          # JVM and AndroidX configuration
├── build_and_install.bat      # One-click Windows build and wireless install script
├── tv_ip.txt                  # Default Android TV IP, one address on the first line
├── README.md
│
└── app/
    ├── build.gradle           # App configuration (SDK 34, AndroidX, Leanback)
    └── src/main/
        ├── AndroidManifest.xml # TV Leanback launcher & HTTP permissions
        ├── res/drawable/       # FunHub launcher icon and TV banner
        └── java/com/rahmanma/gamesutils/catan/
            └── MainActivity.kt # Fullscreen WebView, saved selection, remote controls
```

---

## 🚀 How to Build & Install on Your TV

### Option 1: Automatic Script (Fastest)
Double-click or run in PowerShell:
```powershell
.\build_and_install.bat
```
* Builds the debug APK using Gradle.
* Reads the default TV IP from `tv_ip.txt`. Edit its first line when the TV address changes; enter only the IP, without a port.
* Prompts for an optional address override. Press Enter to use the configured IP.
* Connects ADB wirelessly and installs `app-debug.apk` directly to your TV.

---

### Option 2: Command Line (Step-by-Step)

#### 1. Compile APK:
```powershell
gradle assembleDebug
```
*(The compiled APK will be at `app\build\outputs\apk\debug\app-debug.apk`)*

#### 2. Connect Wireless ADB:
```powershell
adb connect <TV_IP_ADDRESS>:5555
```
*(Check "Always allow from this computer" on your TV screen).*

#### 3. Install APK:
```powershell
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

---

## 🎮 TV Remote Navigation & Controls

| Remote Button | Action |
|---|---|
| **Menu / Settings / Info** | Opens the Host IP, Port, and Endpoint switcher dialog |
| **Play / Pause** | Toggles video/audio playback |
| **Next / Fast Forward** | Advances to next track or jumps forward |
| **Prev / Rewind** | Jumps to previous track or rewinds |
| **D-Pad Directional Keys** | Navigates on-screen items and focus |

---

## 🔄 App Selection
* On first launch, FunHub prompts for an app and remembers the selection.
* Press **Menu**, **Settings**, or **Info** to switch between Catan, Catan 2, MM MP3, and MM TV.
* Number keys **1** through **4** also switch apps.
* The package ID remains `com.rahmanma.gamesutils.catan`, so installation updates the existing app without losing its saved selection.
