import logging
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock
from uuid import uuid4
from routes.media_chapters import normalize_chapter_timestamps


EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix='media-download')
JOBS = {}
JOBS_LOCK = Lock()


def download_folder(root, playlist, category):
    def segment(value):
        name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(value)).strip().strip('.')[:120]
        if not name:
            name = 'Uncategorized'
        if name.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL', *(f'COM{index}' for index in range(1, 10)), *(f'LPT{index}' for index in range(1, 10))}:
            name = f'_{name}'
        return name

    root = Path(root).resolve()
    destination = root / segment(playlist)
    if category:
        destination /= segment(category)
    destination = destination.resolve()
    if not destination.is_relative_to(root):
        raise ValueError('Download folder must be within the configured root.')
    return destination


def download_status(job_id, owner):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job or job['owner'] != owner:
            return None
        return {key: [dict(item) for item in value] if key == 'items' else value
                for key, value in job.items() if key != 'owner'}


def _update(job_id, **values):
    with JOBS_LOCK:
        JOBS[job_id].update(values)


def _update_item(job_id, index, **values):
    with JOBS_LOCK:
        JOBS[job_id]['items'][index].update(values)


def _fetch(record, kind, destination, report):
    from yt_dlp import YoutubeDL

    destination.mkdir(parents=True, exist_ok=True)

    def progress(details):
        if details['status'] == 'downloading':
            total = details.get('total_bytes') or details.get('total_bytes_estimate')
            report(progress=min(99, round(100 * details.get('downloaded_bytes', 0) / total)) if total else 0)
        elif details['status'] == 'finished':
            report(message='Processing media...')

    options = {
        'outtmpl': str(destination / '%(title).150B [%(id)s].%(ext)s'),
        'restrictfilenames': True,
        'noplaylist': True,
        'quiet': True,
        'socket_timeout': 30,
        'retries': 3,
        'max_filesize': 5 * 1024 ** 3,
        'js_runtimes': {'node': {}},
        'progress_hooks': [progress],
        'postprocessors': []
    }
    if kind == 'audio':
        options['format'] = 'bestaudio/best'
        options['postprocessors'].append({'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'})
    else:
        options['format'] = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best'
        options['merge_output_format'] = 'mp4'
        options['postprocessors'].append({'key': 'FFmpegVideoRemuxer', 'preferedformat': 'mp4'})
    with YoutubeDL(options) as downloader:
        info = downloader.extract_info(record.get('source_url') or f"https://www.youtube.com/watch?v={record['video_id']}", download=True)
        path = Path(downloader.prepare_filename(info)).with_suffix('.mp3' if kind == 'audio' else '.mp4')
    if not path.is_file():
        raise RuntimeError('The downloaded media file could not be found.')
    if not record.get('chapter'):
        # yt-dlp also derives these from timestamp lines in the description.
        record['chapter'] = normalize_chapter_timestamps(' '.join(
            str(chapter['start_time']) for chapter in info.get('chapters') or [] if chapter.get('start_time') is not None))
    description = '\n'.join(line.rstrip() for line in str(info.get('description') or '').splitlines()).strip()
    sidecar = (record.get('chapter') or '') + ('\n' + description if description else '')
    path.with_suffix(path.suffix + '.chapters.txt').write_text(sidecar, encoding='utf-8')
    return path, info


def _saved_message(kind):
    return 'Saved to MP3 library.' if kind == 'audio' else 'Saved to VDO library.'


def _download(job_id, record, kind, destination, completed):
    try:
        _update(job_id, status='downloading', message='Downloading...', progress=0)
        path, info = _fetch(record, kind, destination, lambda **values: _update(job_id, **values))
        completed(path, info)
        _update(job_id, status='complete', message=_saved_message(kind), progress=100, filename=path.name)
    except Exception as error:
        logging.getLogger(__name__).exception('Media download failed')
        _update(job_id, status='failed', message=str(error)[:500])


def _download_batch(job_id, items, kind, completed):
    failures = 0
    for index, (record, destination) in enumerate(items):
        _update(job_id, status='downloading', current=index, message=f'Downloading {index + 1} of {len(items)}...')
        _update_item(job_id, index, status='downloading', message='Downloading...', progress=0)
        try:
            path, info = _fetch(record, kind, destination, lambda **values: _update_item(job_id, index, **values))
            completed(record, path, info)
            _update_item(job_id, index, status='complete', message=_saved_message(kind), progress=100, filename=path.name)
        except Exception as error:
            failures += 1
            logging.getLogger(__name__).exception('Media download failed')
            _update_item(job_id, index, status='failed', message=str(error)[:500])
        _update(job_id, progress=round(100 * (index + 1) / len(items)))
    _update(job_id, status='failed' if failures == len(items) else 'complete', current=None,
            message=f'{len(items) - failures} of {len(items)} downloaded.')


def _reserve_job(owner, values):
    with JOBS_LOCK:
        if sum(job['status'] in {'queued', 'downloading'} for job in JOBS.values()) >= 2:
            raise RuntimeError('Download queue is full. Try again after the current downloads finish.')
        while len(JOBS) >= 50:
            finished = next((key for key, job in JOBS.items() if job['status'] in {'complete', 'failed'}), None)
            if finished is None:
                break
            del JOBS[finished]
        job_id = uuid4().hex
        JOBS[job_id] = {'owner': owner, 'status': 'queued', 'message': 'Queued...', 'progress': 0, **values}
    return job_id


def start_download(owner, record, kind, destination, completed):
    job_id = _reserve_job(owner, {})
    EXECUTOR.submit(_download, job_id, dict(record), kind, destination, completed)
    return job_id


def start_batch_download(owner, items, kind, completed):
    job_id = _reserve_job(owner, {'current': None, 'items': [
        {'video_id': record['video_id'], 'status': 'queued', 'message': 'Queued...', 'progress': 0}
        for record, _destination in items
    ]})
    EXECUTOR.submit(_download_batch, job_id, [(dict(record), destination) for record, destination in items], kind, completed)
    return job_id