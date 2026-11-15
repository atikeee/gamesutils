import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
from uuid import uuid4


SOURCE_EXTENSIONS = {'.wmv', '.flv'}
VIDEO_FILTER = (
    "scale=w='min(1920,iw)':h='min(1080,ih)':"
    'force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30'
)


def convert_video(source, ffmpeg):
    output = source.with_suffix('.mp4')
    if output.exists():
        print(f'Skipped existing output: {output}', flush=True)
        return 'skipped'

    temporary = output.with_name(f'.{output.stem}.{uuid4().hex}.tmp.mp4')
    command = [
        ffmpeg, '-hide_banner', '-loglevel', 'warning', '-stats', '-nostdin', '-n',
        '-i', str(source), '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', VIDEO_FILTER, '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
        '-profile:v', 'high', '-level:v', '4.1', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
        '-movflags', '+faststart', str(temporary)
    ]
    print(f'Converting: {source} -> {output}', flush=True)
    try:
        subprocess.run(command, check=True)
        if not temporary.is_file() or temporary.stat().st_size == 0:
            raise OSError('FFmpeg did not produce a non-empty MP4')
        if output.exists():
            print(f'Skipped output created during conversion: {output}', flush=True)
            return 'skipped'
        os.rename(temporary, output)
        return 'converted'
    except (OSError, subprocess.CalledProcessError) as error:
        print(f'Failed: {source}: {error}', file=sys.stderr, flush=True)
        return 'failed'
    finally:
        temporary.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Recursively convert WMV/FLV to TV-friendly MP4 and list new full paths in converted_files.txt.'
    )
    parser.add_argument('root', type=Path, help='Root directory to scan, including all subdirectories')
    parser.add_argument('--dry-run', action='store_true', help='List planned conversions without writing videos or a report')
    args = parser.parse_args(argv)
    try:
        root = args.root.expanduser().resolve(strict=True)
    except OSError as error:
        parser.error(f'Cannot access root directory: {error}')
    if not root.is_dir():
        parser.error('Root must be a directory')

    ffmpeg = shutil.which('ffmpeg')
    if not args.dry_run and not ffmpeg:
        parser.error('FFmpeg was not found. Install FFmpeg and add it to PATH.')

    counts = {'converted': 0, 'skipped': 0, 'failed': 0, 'planned': 0}
    converted_paths = []
    interrupted = False
    try:
        for source in sorted(root.rglob('*')):
            if not source.is_file() or source.suffix.lower() not in SOURCE_EXTENSIONS:
                continue
            output = source.with_suffix('.mp4')
            if args.dry_run:
                if output.exists():
                    print(f'Skipped existing output: {output}')
                    counts['skipped'] += 1
                else:
                    print(f'Would convert: {source} -> {output}')
                    counts['planned'] += 1
            else:
                status = convert_video(source, ffmpeg)
                counts[status] += 1
                if status == 'converted':
                    converted_paths.append(str(output.resolve()))
    except KeyboardInterrupt:
        interrupted = True
        print('\nInterrupted. Original files were preserved.', file=sys.stderr)

    if not args.dry_run:
        report = root / 'converted_files.txt'
        try:
            with report.open('w', encoding='utf-8') as report_file:
                for path in converted_paths:
                    report_file.write(path + '\n')
        except OSError as error:
            print(f'Could not write report: {error}', file=sys.stderr)
            return 1
        print(f'New-file report: {report}')

    print('Summary: ' + ', '.join(f'{name}: {count}' for name, count in counts.items()))
    return 130 if interrupted else 1 if counts['failed'] else 0


if __name__ == '__main__':
    sys.exit(main())