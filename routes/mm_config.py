import json
import os
import stat
import tempfile
from threading import Lock
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = PROJECT_ROOT / 'data' / 'mm' / 'mm_config.json'
CONFIG_WRITE_LOCK = Lock()


def load_mm_config():
    with CONFIG_PATH.open(encoding='utf-8') as config_file:
        return json.load(config_file)


def save_tv_ip(address):
    with CONFIG_WRITE_LOCK:
        config = load_mm_config()
        config['tv']['ip'] = address
        permissions = stat.S_IMODE(CONFIG_PATH.stat().st_mode)
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=CONFIG_PATH.parent,
                                             prefix='.mm-config-', suffix='.tmp', delete=False) as config_file:
                temporary_path = Path(config_file.name)
                json.dump(config, config_file, indent=2)
                config_file.write('\n')
                config_file.flush()
                os.fsync(config_file.fileno())
            os.chmod(temporary_path, permissions)
            os.replace(temporary_path, CONFIG_PATH)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)


def mm_path(name):
    value = load_mm_config()['paths'][name]
    path = Path(os.path.expandvars(value)).expanduser()
    return path if path.is_absolute() else PROJECT_ROOT / path


def mm_db_path(name):
    path = mm_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    return str(path)