# utils

## Deployment

The release-branch deployment webhook and GitHub Actions setup are documented in
[data/deploy/README.md](data/deploy/README.md).

## Passphrase Router

The home page `/` routes passphrases to local URLs. The original dashboard is now
at `/index`, and the master-protected passphrase manager is at `/passphrases`.
`/index` is public and does not require a passphrase, even if a saved passphrase
destination points to it. Individual Games and Work links are grouped under their
dashboard tiles instead of repeated on the index. Other page protections remain.

After installing the existing requirements, initialize the two passphrases locally:

```console
python -m routes.routes_passphrase init
```

The command prompts for a master passphrase and a separate dashboard passphrase,
with hidden input and confirmation. Each must be 8-256 characters. There are no
default credentials and no web-based first-user setup. Until initialization, `/`
returns an unconfigured status and the manager cannot be accessed. Initialization
does not overwrite existing entries.

Enter the master passphrase on `/` to open the manager, or the dashboard passphrase
to open `/index`. The manager supports adding, editing, and deleting destinations.
Blank replacement passphrase fields preserve the existing hash. Replacing the
master also requires its current passphrase and signs out all manager sessions.
The master entry cannot be deleted or redirected elsewhere.

SQLite stores salted scrypt hashes, not plaintext or decryptable passphrases. The
Passphrase column therefore shows configuration status, not the original secret.
The database is `instance/passphrase_router.sqlite3`, outside the static directory
and excluded from Git by `instance/.gitignore`. Back up this database securely;
its hashes, routing information, and internal signing key are sensitive. On Windows,
restrict the instance directory's NTFS permissions to the app account and trusted
administrators. SQLite is not encrypted at rest; use encrypted storage if needed.
Do not expose the instance directory through a web server or file-serving route.

Use HTTPS outside localhost. Manager cookies are HttpOnly and SameSite=Strict, with
Secure enabled on HTTPS requests. When using a TLS-terminating reverse proxy,
configure trusted proxy handling so Flask recognizes HTTPS. Manager sessions expire
after one hour. Destination grants also expire one hour after login; browsing does
not extend them. Forms have CSRF checks; failed routing attempts are limited to
10 per remote IP per 15 minutes. Forwarded-IP headers are not trusted by this module.

Configured destination paths and their child URLs require a destination passphrase
grant. Direct page visits without a grant redirect to `/`; API requests return 401.
The master passphrase opens the manager but does not grant destination access.
Using a different destination passphrase replaces the browser's previous grant.
Editing a destination invalidates its grants. Deleting its last passphrase leaves
the path protected, not public. Independently configured nested destinations need
their own grant. Unconfigured paths other than PhotoTag retain existing behavior.

### PhotoTag Access

`/phototag` and all its APIs are always protected, even before a mapping is created.
Add one or more entries in `/passphrases`, each with URL `/phototag`:

| Info | PhotoTag access |
| --- | --- |
| `family` | Only top-level folders whose names contain `family`, ignoring case |
| `holiday` | Only top-level folders whose names contain `holiday`, ignoring case |
| `*` | All available folders |
| `.ignore` | Only hidden top-level folders marked with a `.ignore` file |

Each entry must use a different passphrase. The Info value is a literal substring,
not a regular expression; only the exact value `*` disables filtering. Each allowed
top-level folder includes its normal nested images. Folder restrictions apply to
image lists, previews, downloads, tagging, rotation, and processing, not just the
picker. Restricted grants cannot open the directory debug page. PhotoTag returns
to `/` on expiry, and protected responses use `Cache-Control: no-store`.

To open hidden folders separately, create another passphrase with URL `/phototag`
and Info `.ignore`. Put an empty `.ignore` file inside each top-level photo folder
to hide it. Ordinary and `*` grants continue to skip those folders, while the
`.ignore` grant lists only hidden folders and can view their nested photos. This
mode can tag Best/Good and download, but cannot process or delete. A `.ignore`
marker on a configured photo root hides all its child folders from ordinary grants.

Only exact wildcard Info (`*`) allows processing and delete tagging. Other grants
hide those controls and reject the same actions at the API; Best/Good tagging,
unmarking, rotation, and downloads remain available within the permitted folders.

**Download all** saves the current folder's originals individually, including
nested photos and RAW files, without making a ZIP. Existing marked-photo downloads
still work separately. Browsers may require permission for multiple downloads;
supported desktop browsers can save directly into a chosen directory.

Processing preserves Best/Good tags and records original relative paths in
`tags.json`. Unmarking a processed photo moves it back and updates its displayed
path. Existing `b/` or `g/` photos without origin metadata return to the selected
folder's root. If the destination already exists, restoration is rejected without
overwriting either photo.

Focused regression tests:

```console
python -m unittest discover -s scripts -p test_passphrase_router.py
```

## Music Player

Use `/mm/mp3` for the editable player and `/mm/mp3/tv` for the same player without
the metadata editor. The TV view uses larger playback controls and visible focus
styles; playlist, category, artist, tags, seeking, and chapters remain available.
The TV view is a presentation mode, not a separate authorization layer for the
existing metadata API.

Tag chips toggle independently. Songs must contain **all selected tags**; select
**All** to clear the selection. Filters are retained when changing playlist,
category, or artist, including in the TV view. Repeated `tag` query parameters
can be used in player URLs and `/mm/api/mp3/library`.

## Video Libraries

`/mm/youtube` and `/mm/vdo` share the same player and `videos`/`tags`/`video_tags`
schema, stored separately in `data/mm/youtube.db` and `data/mm/vdo.db`. The VDO
`url` column stores a local file path and `video_id` is generated from that path.
Local files must be under `MM_VDO_ROOT`; it defaults to `/Media` when that mount
exists, otherwise `data/vdo`. Set `MM_VDO_ROOT` to the video directory before
starting the app if your files are elsewhere.

## Catan

Open `/catan` for the two-section Catan dashboard. Base Catan uses
`/catan/1/game` and `/catan/1/player`; Cities & Knights uses `/catan/2/game`
and `/catan/2/player`.

Cities & Knights stores player names as their first five characters, including
existing player records and saved history. Choose names with distinct five-character
prefixes. Its activity log shows resource cards with counts, progress-card backs
for draws/discards, fronts for played cards, and icons for builds and knight actions.
The saved dice result includes the roller's short name; dice animations have no
visible captions.

Cities & Knights starts with empty resource hands. Setup is free and automatic:
house plus connected road in forward randomized turn order, then a separate city
plus connected road in reverse order. The last player builds both pairs back to
back. After the first player's city-road pair, play starts with that player ready
to roll. The player's VP total is shown below their map name. Names beginning with
`Player` (case-insensitive), including legacy shortened `Playe` placeholders, are
invalid and excluded from seats, scores, and player choices. New setup rules apply
to a fresh game; reset an existing in-progress setup before using them.

The Catan board, player setup, and basic play guide is in [CATAN_README.md](data/CATAN_README.md).

## Math content

The content-driven math learning and practice system is documented in [data/math/README.md](data/math/README.md).
