# MM Configuration

Edit `mm_config.json` for the `/mm` web pages and their media-import utilities.
FunHub is intentionally separate: its Android source, install script, and
`scripts/FunHub/tv_ip.txt` do not read or change this file.

`/mm/x` is a local-video library using the same template and player as `/mm/vdo`
and `/mm/mov`. Select X on `/mm/update` for CSV import/export and `/mm/remote`
for TV playback. Its `paths.x_db` defaults to `data/mm/x.db`. Selecting X on
`/mm/update` creates this database with the shared media schema if it is missing.
Add/import video paths under the configured media root.

## Settings

- `paths.download_audio_root` and `paths.download_video_root`: download destinations,
  default `/Media/Audio` and `/Media/Video`. Files go into `<root>/<playlist>/<category>`;
  an empty category omits its subfolder. Folder names are sanitized. The video root
  must be inside the configured local-media root so `/mm/vdo` can stream the files.
- `movie_pin`: a numeric string, default `0000`. Every direct `/mm/mov`
  visit prompts for it, just like X. Movie APIs, CSV updates, and remote playback
  commands require an unlocked session. `/mm/tv` stays prompt-free and uses an
  authorized stream after Movie or X is unlocked on the remote.
- `vdo_pin`: a numeric string, default `1111`, used to select VDO through the
  remote's Database button. It does not restrict `/mm/vdo` or its APIs.
- The remote starts on YouTube on every page load. Press its Database button and
  enter the Movie, VDO, or X PIN to switch libraries. Use distinct PINs. Canceling
  or entering a wrong PIN leaves the library unchanged. Submit a blank PIN to
  return to YouTube. PIN lengths follow the configured strings, not a fixed limit.
- `x_pin`: a numeric string, including leading zeros if needed. Set it locally
  in the config; leaving it empty disables X access. Every direct `/mm/x` visit
  and every selection of X in `/mm/remote` prompts for this PIN. X APIs and CSV
  updates require an unlocked session. Access expires after 24 hours, and changing
  the PIN invalidates existing grants. The PIN is not embedded in the page or
  stored in browser storage. Treat it as a convenience gate, not strong public-site
  authentication. Short numeric PINs are easy to guess.
- `site_url`: public site origin, default `https://atiq.us`. Change it to your LAN
  server URL when needed. This controls the TV-display link returned by Start TV;
  it does not change the Android app's URLs or the Flask listening address.
- `paths`: database, YouTube credential, seed, and video-directory locations.
  Relative paths resolve from the repository root; absolute paths and environment
  variables are supported. Changing paths does not copy existing databases or media.
- `paths.media_mount`: preferred local-video mount if that directory exists.
  Otherwise `paths.vdo_root` is used. Existing `MM_VDO_ROOT` environment/Flask
  overrides retain priority.
- `tv.ip` and `tv.adb_port`: TV network-debugging address. The network-icon button
  before the remote's power button can read and save the TV IP using the TV control
  key. Saving updates only `tv.ip` in the config, taking effect on the next TV command.
- `tv.adb_executable`: `adb` on the server's PATH, or the executable's full path.
- `tv.app_component`: installed app activity; the FunHub package ID remains
  `com.rahmanma.gamesutils.catan/.MainActivity`.
- `tv.control_key`: set a long, random private key locally. An empty key disables
  TV commands. Enter the same key in the remote page's masked prompt. The key is
  not rendered into the page or stored in browser storage. Do not commit a real
  key or expose this configuration through a download/static endpoint.
- `tv.timeout_seconds`: timeout per ADB command, greater than zero and at most 60.

TV settings are read on each button press. Restart Flask and media-import processes
after changing storage paths, particularly the MP3 database path.

## TV Setup

1. Install Android platform-tools on the machine/container running Flask.
  The repository's `docker-compose.yml` automatically installs the `adb` package
  when missing before starting Flask. ADB installed only on your PC will not help
  a Flask server running on the NAS.
2. Enable TV network debugging on the configured port. Run
   `adb connect <TV_IP>:<ADB_PORT>` from the Flask host/container and approve its
   authorization prompt on the TV. Newer TVs may require pairing first.
3. Set `tv.control_key` in the config. Use HTTPS when operating through the public site.
4. Open `/mm/remote`, press **Start TV**, and enter the key.

### Ugreen NAS Docker

The Compose file mounts `/volume1/docker/gamesutils/data/mm/adb` as
`/root/.android`, keeping the ADB authorization keys across container recreation.
Keep that directory private and out of Git/backups shared with other people.
No privileged container, host networking, USB passthrough, or published ADB port
is required for network TV control.

After updating the Compose project on the NAS, recreate its container through
the Ugreen Docker project UI, or run from the NAS project directory:

```sh
docker compose up -d --force-recreate gamesutils
docker compose logs --tail=100 gamesutils
docker exec gamesutils adb version
docker exec -it gamesutils adb connect <TV_IP>:<ADB_PORT>
docker exec gamesutils adb devices
```

Approve the authorization prompt on the TV. `adb devices` should list the TV as
`device`, not `unauthorized` or `offline`. If the TV requires wireless pairing,
run `docker exec -it gamesutils adb pair <TV_IP>:<PAIRING_PORT>` and enter the TV's
pairing code directly in the terminal, then connect using its debugging port.
The pairing and debugging ports may differ.

ADB, FFmpeg, and Node.js installation is automatic on a fresh/recreated container and skipped on
ordinary restarts when already installed. It requires internet access to Debian
package repositories, and the existing pip step requires Python package access.
A package-install failure stops startup rather than running without ADB.
There is no custom image to rebuild with this approach.

## YouTube Downloads and Multiline Add

Only `/mm/youtube` has the download icon, immediately before Add. It operates on
the current media item. Choose Audio (MP3, 192 kbps), Video (best available MP4
video/audio, including HD when provided by YouTube), or Cancel. Downloads currently
do not require a control key: public-site visitors can start downloads. Queue and
file-size limits remain, and status is available only to the initiating browser
session. TV startup and TV-IP settings still require the TV control key.
Only download content you have permission to save.

Completed audio is registered in the MP3 database and video in VDO. Title, artist,
playlist, category, tags, duration, and current saved chapter timestamps are copied.
A `.chapters.txt` sidecar beside the media also preserves timestamps. Chapters are
not guaranteed to be embedded in the media file itself. Playlist/category values
come from the current media record, not an uncommitted editor value.

Downloads run in a background worker with at most two queued/running jobs and a
5 GiB file-size limit. Closing the dialog does not cancel an accepted job. Keep
the page open to see status; reopening its download dialog shows the running job.
Do not restart the container during downloads. Job status is in memory and does
not survive server restarts. YouTube can restrict private, DRM, age-restricted,
region-blocked, or login-required content; no cookies or credentials are imported.

Add accepts up to 50 nonempty lines on YouTube, VDO, X, and Movie pages. YouTube
accepts YouTube links/IDs; local pages accept existing paths under the media root.
Each entry uses the supplied playlist, category, and tags. An optional local title
applies only to a single entry; multiple entries use their filenames. Duplicate
lines are ignored; failed entries remain in the dialog while successes are kept.

The updated Compose file uses `python:3.11-slim-trixie` and automatically installs
FFmpeg (including ffprobe) and Node.js 20+ through Debian packages. The updated
`requirements.txt` installs `yt-dlp[default]`, including its YouTube JS support.
Recreate the NAS container after deploying both files:

```sh
docker compose up -d --force-recreate gamesutils
docker exec gamesutils ffmpeg -version
docker exec gamesutils node --version
docker exec gamesutils python -m yt_dlp --version
```

No additional manual NAS install is needed with the updated Compose file. Allow
write access to the download roots and internet access during setup/downloads.
Outside Docker, run `python -m pip install -r requirements.txt` and separately
install FFmpeg and Node.js 20+ on the Flask host (both must be on PATH). Update
yt-dlp periodically when YouTube changes its extraction mechanisms.

The server sends `KEYCODE_WAKEUP`, launches FunHub and waits for its activity,
then sends `KEYCODE_4` to select MM TV (`/mm/tv`). This wakes supported TVs
from network standby, never toggles an already-awake TV off, and cannot power on
a fully shut-down or unplugged TV. An already-awake TV also launches FunHub and
switches to MM TV. FunHub handles the number key and saves that selection normally;
the server does not modify the Android app or its configuration.

Media file paths stored in SQLite and user-selected import/scan paths are not
rewritten. Third-party service URLs (YouTube, Google OAuth) and internal `/mm`
route names are not deployment filesystem settings.

to add adb for existing docker
cd /volume1/docker/gamesutils
docker compose up -d --force-recreate gamesutils
docker exec gamesutils adb version
docker exec -it gamesutils adb connect 192.168.0.245:5555
docker exec gamesutils adb devices