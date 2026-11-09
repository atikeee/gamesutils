import logging
import re
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock
from uuid import uuid4


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
        return {key: value for key, value in job.items() if key != 'owner'}


def _update(job_id, **values):
    with JOBS_LOCK:
        JOBS[job_id].update(values)


def _download(job_id, record, kind, destination, completed):
    try:
        from yt_dlp import YoutubeDL

        destination.mkdir(parents=True, exist_ok=True)
        _update(job_id, status='downloading', message='Downloading...', progress=0)

        def progress(details):
            if details['status'] == 'downloading':
                total = details.get('total_bytes') or details.get('total_bytes_estimate')
                percent = min(99, round(100 * details.get('downloaded_bytes', 0) / total)) if total else 0
                _update(job_id, progress=percent)
            elif details['status'] == 'finished':
                _update(job_id, message='Processing media...')

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
            info = downloader.extract_info(f"https://www.youtube.com/watch?v={record['video_id']}", download=True)
            path = Path(downloader.prepare_filename(info)).with_suffix('.mp3' if kind == 'audio' else '.mp4')
        if not path.is_file():
            raise RuntimeError('The downloaded media file could not be found.')
        path.with_suffix(path.suffix + '.chapters.txt').write_text(record.get('chapter') or '', encoding='utf-8')
        completed(path, info)
        _update(job_id, status='complete', message='Saved to MP3 library.' if kind == 'audio' else 'Saved to VDO library.', progress=100, filename=path.name)
    except Exception as error:
        logging.getLogger(__name__).exception('Media download failed')
        _update(job_id, status='failed', message=str(error)[:500])


def start_download(owner, record, kind, destination, completed):
    with JOBS_LOCK:
        if sum(job['status'] in {'queued', 'downloading'} for job in JOBS.values()) >= 2:
            raise RuntimeError('Download queue is full. Try again after the current downloads finish.')
        while len(JOBS) >= 50:
            finished = next((key for key, job in JOBS.items() if job['status'] in {'complete', 'failed'}), None)
            if finished is None:
                break
            del JOBS[finished]
        job_id = uuid4().hex
        JOBS[job_id] = {'owner': owner, 'status': 'queued', 'message': 'Queued...', 'progress': 0}
    EXECUTOR.submit(_download, job_id, dict(record), kind, destination, completed)
    return job_id