# 📺 MM TV Player - Android TV Thin Client

A lightweight, native Android TV web wrapper built specifically for **`gamesutils`**. It connects to your local computer running Flask, allows switching between endpoints (`/mm/youtube`, `/mm/myvdo`, `/mm/mymovies`), and passes TV remote controls directly to playback.

---

## 📁 Project Structure

```text
androidTVapp/
│
├── build.gradle               # Root Gradle build script
├── settings.gradle            # Module include definitions
├── gradle.properties          # JVM and AndroidX configuration
├── build_and_install.bat      # One-click Windows build and wireless install script
├── README.md
│
└── app/
    ├── build.gradle           # App configuration (SDK 34, AndroidX, Leanback)
    └── src/main/
        ├── AndroidManifest.xml # TV Leanback launcher & HTTP permissions
        ├── res/layout/
        │   └── activity_main.xml # Fullscreen hardware-accelerated WebView
        └── java/com/rahmanma/gamesutils/tv/
            └── MainActivity.kt # Host/Port/Endpoint preferences, remote controls
```

---

## 🚀 How to Build & Install on Your TV

### Option 1: Automatic Script (Fastest)
Double-click or run in PowerShell:
```powershell
.\build_and_install.bat
```
* Builds the debug APK using Gradle.
* Prompts for your TV's local IP address (e.g. `192.168.1.75`).
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

## 🔄 Host & Endpoint Configuration
* On first launch, the app prompts for your PC's IP (e.g., `192.168.1.50`) and Port (`5000`).
* Press **Menu** at any time to switch between:
  * `/mm/youtube`
  * `/mm/myvdo`
  * `/mm/mymovies`
