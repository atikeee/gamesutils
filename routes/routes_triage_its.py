import json
import hashlib
import ntpath
import os
import re
import sys
from datetime import datetime, timedelta, timezone

from bs4 import BeautifulSoup
from flask import render_template, request

from dashboard import PROJECT_ROOT, dashboard_tile


DATA_FILE = os.path.join(PROJECT_ROOT, 'data', 'triage_its.json')
VALIDATION_DATA_FILE = os.path.join(PROJECT_ROOT, 'data', 'triage_val.json')
TICKET_URL = 'https://tapeout.intel.com/its/#/ticket/{}'
TICKET_LINK = re.compile(r'https://hsdes\.intel\.com/resource/(\d+)', re.IGNORECASE)
SUBJECT_ID = re.compile(r'\[(\d{10,12})\]')
MY_IDENTITIES = ('rahmanma', 'Rahman, Mohammad A', 'mohammad.a.rahman@intel.com')
DETAIL_KEYS = {'owner', 'notify', 'notify_other', 'release', 'subject', 'status'}
VALIDATION_ERROR_TERMS = ('error', 'warning')


def record_details(html):
    soup = BeautifulSoup(html or '', 'html.parser')
    for table in reversed(soup.find_all('table')):
        fields = {}
        for row in table.find_all('tr'):
            cells = row.find_all(['td', 'th'], recursive=False)
            if len(cells) != 2:
                continue
            key = re.sub(r'[^a-z0-9]+', '_', cells[0].get_text(' ', strip=True).casefold()).strip('_')
            if key:
                fields[key] = ' '.join(cells[1].stripped_strings)
        if DETAIL_KEYS.intersection(fields):
            return fields
    return {}


def ticket_attention(details):
    return 'rahmanma' if any(
        identity.casefold() in details.get('owner', '').casefold()
        for identity in MY_IDENTITIES
    ) else details.get('owner', '')


def ticket_module(details, subject):
    release = details.get('release', '')
    return 'Mazama' if 'mazama' in (release + ' ' + details.get('subject', '') + ' ' + (subject or '')).casefold() else release or 'Unknown'


def ticket_from_email(subject, html, received):
    match = TICKET_LINK.search(html or '') or SUBJECT_ID.search(subject or '')
    if not match:
        return None
    ticket_id = match.group(1)
    details = record_details(html)
    return {
        'its': ticket_id,
        'url': TICKET_URL.format(ticket_id),
        'received': received.strftime('%Y-%m-%d %H:%M:%S'),
        'attention': ticket_attention(details),
        'module': ticket_module(details, subject),
        'status': details.get('status', ''),
        'owner': details.get('owner', ''),
        'release': details.get('release', ''),
        'subject': subject or '',
    }


def latest_tickets(messages):
    return ordered_tickets(ticket_from_email(subject, html, received) for subject, html, received in messages)


def ordered_tickets(tickets):
    latest = {}
    for ticket in tickets:
        if ticket and (ticket['its'] not in latest or ticket['received'] > latest[ticket['its']]['received']):
            latest[ticket['its']] = ticket
    return sorted(
        latest.values(),
        key=lambda ticket: (
            ticket['attention'] == 'rahmanma' and ticket['module'] == 'Mazama',
            ticket['attention'] == 'rahmanma',
            ticket['received'],
        ),
        reverse=True,
    )


def normalize_validation_key(label):
    return re.sub(r'[^a-z0-9]+', '_', label.casefold()).strip('_')


def table_fields(table):
    rows = []
    for row in table.find_all('tr'):
        cells = row.find_all(['th', 'td'], recursive=False)
        values = [' '.join(cell.stripped_strings) for cell in cells]
        if values:
            rows.append(values)
    fields = {}
    for values in rows:
        if len(values) >= 2:
            key = normalize_validation_key(values[0])
            if key:
                fields[key] = ' '.join(value for value in values[1:] if value)
    if rows and len(rows[0]) > 1:
        headers = [normalize_validation_key(value) for value in rows[0]]
        for values in rows[1:]:
            for index, key in enumerate(headers):
                if key and index < len(values):
                    fields.setdefault(key, values[index])
    return fields


def validation_records_from_email(html, received, entry_id=''):
    soup = BeautifulSoup(html or '', 'html.parser')
    nodes = soup.find_all(string=re.compile(r'detailed\s+information\s*:', re.IGNORECASE))
    if not nodes:
        return []
    all_tables = soup.find_all('table')
    detail_position = {id(table): index for index, table in enumerate(all_tables)}
    relevant_positions = []
    for node in nodes:
        for table in node.parent.find_all_next('table'):
            position = detail_position.get(id(table))
            if position is not None and position not in relevant_positions:
                relevant_positions.append(position)
    rows = []
    email_key = entry_id or hashlib.sha256(f'{received.isoformat()}:{html}'.encode('utf-8', errors='replace')).hexdigest()
    for table_index, position in enumerate(relevant_positions):
        fields = table_fields(all_tables[position])
        recipe = next((value for key, value in fields.items() if 'recipe' in key and 'file' in key), '')
        run_dir = next((value for key, value in fields.items() if 'run' in key and 'dir' in key), '')
        if not recipe and not run_dir:
            continue
        error_section = ' '.join(value for key, value in fields.items() if 'error' in key)
        errors = sorted({
            word for word in re.findall(r'\b[\w.-]+\b', error_section, flags=re.UNICODE)
            if any(term in word.casefold() for term in VALIDATION_ERROR_TERMS)
        }, key=str.casefold)
        row_key = hashlib.sha256(f'{email_key}:{table_index}'.encode('utf-8')).hexdigest()[:20]
        rows.append({
            'row_id': row_key,
            'received': received.strftime('%Y-%m-%d %H:%M:%S'),
            'recipe_file': ntpath.basename(recipe.strip().rstrip('\\/')),
            'run_dir': run_dir,
            'errors': ' '.join(errors),
        })
    return rows


def merge_validation_cache(existing, incoming):
    deleted = set(existing.get('deleted_row_ids', []))
    rows_by_id = {row['row_id']: row for row in existing.get('rows', []) if row.get('row_id')}
    rows_by_id.update({row['row_id']: row for row in incoming.get('rows', []) if row.get('row_id')})
    rows = sorted(
        (row for row_id, row in rows_by_id.items() if row_id not in deleted),
        key=lambda row: row.get('received', ''),
        reverse=True,
    )
    return {**incoming, 'rows': rows, 'deleted_row_ids': sorted(deleted)}


def outlook_unavailable_reason():
    if sys.platform != 'win32':
        return 'Outlook COM scanning requires Windows and cannot run in Linux Docker. Run the Windows scanner and share the data folder with Docker.'
    try:
        import pythoncom
        import win32com.client
    except ImportError:
        return 'Outlook scanning needs pywin32 in the Windows Python environment running this app. Install the Windows requirements there.'
    return None


def find_ticket_folder(mapi):
    for store in mapi.Folders:
        for parent in store.Folders:
            if parent.Name.casefold() != 'my folders':
                continue
            for folder in parent.Folders:
                if folder.Name.casefold() == '_ticket':
                    return folder
    raise LookupError('Could not find My Folders/_ticket in any Outlook mailbox.')


def find_validation_folder(mapi):
    for store in mapi.Folders:
        for parent in store.Folders:
            if parent.Name.casefold() == 'my folders':
                for folder in parent.Folders:
                    if folder.Name.casefold() == 'validation':
                        return folder
    raise LookupError('Could not find My Folders/validation in any Outlook mailbox.')


def outlook_message_id(message, received):
    entry_id = getattr(message, 'EntryID', '')
    if entry_id:
        return str(entry_id)
    payload = f"{received.isoformat()}\n{getattr(message, 'Subject', '')}\n{getattr(message, 'HTMLBody', '')}"
    return hashlib.sha256(payload.encode('utf-8', errors='replace')).hexdigest()


def scan_outlook(now=None, hours=48, processed_email_ids=None):
    unavailable = outlook_unavailable_reason()
    if unavailable:
        raise RuntimeError(unavailable)
    import pythoncom
    import win32com.client

    now = now or datetime.now()
    cutoff = now - timedelta(hours=hours)
    processed = set(processed_email_ids or [])
    newly_processed = set()
    messages = []
    pythoncom.CoInitialize()
    try:
        outlook = win32com.client.Dispatch('Outlook.Application')
        mapi = outlook.GetNamespace('MAPI')
        ticket_folder = find_ticket_folder(mapi)

        def scan_folder(folder):
            items = folder.Items
            items.Sort('[ReceivedTime]', True)
            for message in items:
                if getattr(message, 'Class', 43) != 43:
                    continue
                received = message.ReceivedTime
                if received.tzinfo is not None:
                    received = received.astimezone().replace(tzinfo=None)
                if received < cutoff:
                    break
                if received <= now:
                    entry_id = outlook_message_id(message, received)
                    if entry_id in processed:
                        continue
                    newly_processed.add(entry_id)
                    messages.append((message.Subject, message.HTMLBody, received))
            for child in folder.Folders:
                scan_folder(child)

        scan_folder(ticket_folder)
    finally:
        pythoncom.CoUninitialize()
    return {
        'scanned_at': now.strftime('%Y-%m-%d %H:%M:%S'),
        'scanned_at_utc': now.astimezone(timezone.utc).isoformat(timespec='seconds'),
        'tickets': latest_tickets(messages),
        'processed_email_ids': sorted(newly_processed),
    }

def scan_validation_outlook(now=None, hours=48, processed_email_ids=None):
    unavailable = outlook_unavailable_reason()
    if unavailable:
        raise RuntimeError(unavailable)
    import pythoncom
    import win32com.client

    now = now or datetime.now()
    cutoff = now - timedelta(hours=hours)
    processed = set(processed_email_ids or [])
    newly_processed = set()
    rows = []
    pythoncom.CoInitialize()
    try:
        outlook = win32com.client.Dispatch('Outlook.Application')
        mapi = outlook.GetNamespace('MAPI')
        folder = find_validation_folder(mapi)

        def scan_folder(current_folder):
            items = current_folder.Items
            items.Sort('[ReceivedTime]', True)
            for message in items:
                if getattr(message, 'Class', 43) != 43:
                    continue
                received = message.ReceivedTime
                if received.tzinfo is not None:
                    received = received.astimezone().replace(tzinfo=None)
                if received < cutoff:
                    break
                if received <= now:
                    entry_id = outlook_message_id(message, received)
                    if entry_id in processed:
                        continue
                    newly_processed.add(entry_id)
                    rows.extend(validation_records_from_email(
                        message.HTMLBody,
                        received,
                        entry_id,
                    ))
            for child in current_folder.Folders:
                scan_folder(child)

        scan_folder(folder)
    finally:
        pythoncom.CoUninitialize()
    return {
        'scanned_at': now.strftime('%Y-%m-%d %H:%M:%S'),
        'scanned_at_utc': now.astimezone(timezone.utc).isoformat(timespec='seconds'),
        'rows': rows,
        'processed_email_ids': sorted(newly_processed),
    }


def read_cache():
    if not os.path.exists(DATA_FILE):
        return {'scanned_at': None, 'tickets': [], 'deleted_its': [], 'processed_email_ids': []}
    with open(DATA_FILE, encoding='utf-8') as cache:
        data = json.load(cache)
    if not data.get('scanned_at_utc'):
        data['scanned_at_utc'] = datetime.fromtimestamp(os.path.getmtime(DATA_FILE), timezone.utc).isoformat(timespec='seconds')
    for ticket in data.get('tickets', []):
        ticket_id = str(ticket.get('its', ''))
        if ticket_id.isdecimal():
            ticket['url'] = TICKET_URL.format(ticket_id)
    data['tickets'] = ordered_tickets(data.get('tickets', []))
    data['processed_email_ids'] = sorted(set(data.get('processed_email_ids', [])))
    return data


def merge_ticket_cache(existing, incoming):
    deleted = set(existing.get('deleted_its', []))
    tickets = ordered_tickets(list(existing.get('tickets', [])) + list(incoming.get('tickets', [])))
    return {
        **incoming,
        'tickets': [ticket for ticket in tickets if ticket['its'] not in deleted],
        'deleted_its': sorted(deleted),
        'processed_email_ids': sorted(set(existing.get('processed_email_ids', [])) | set(incoming.get('processed_email_ids', []))),
    }


def read_validation_cache():
    if not os.path.exists(VALIDATION_DATA_FILE):
        return {'scanned_at': None, 'rows': [], 'deleted_row_ids': [], 'processed_email_ids': []}
    with open(VALIDATION_DATA_FILE, encoding='utf-8') as cache:
        data = json.load(cache)
    if not data.get('scanned_at_utc'):
        data['scanned_at_utc'] = datetime.fromtimestamp(os.path.getmtime(VALIDATION_DATA_FILE), timezone.utc).isoformat(timespec='seconds')
    deleted = set(data.get('deleted_row_ids', []))
    rows = {row['row_id']: row for row in data.get('rows', []) if row.get('row_id')}
    data['rows'] = sorted(
        (row for row_id, row in rows.items() if row_id not in deleted),
        key=lambda row: row.get('received', ''),
        reverse=True,
    )
    data['deleted_row_ids'] = sorted(deleted)
    data['processed_email_ids'] = sorted(set(data.get('processed_email_ids', [])))
    return data


def merge_validation_cache(existing, incoming):
    deleted = set(existing.get('deleted_row_ids', []))
    rows = {row['row_id']: row for row in existing.get('rows', []) if row.get('row_id')}
    rows.update({row['row_id']: row for row in incoming.get('rows', []) if row.get('row_id')})
    return {
        **incoming,
        'rows': sorted((row for row_id, row in rows.items() if row_id not in deleted), key=lambda row: row.get('received', ''), reverse=True),
        'deleted_row_ids': sorted(deleted),
        'processed_email_ids': sorted(set(existing.get('processed_email_ids', [])) | set(incoming.get('processed_email_ids', []))),
    }


def write_cache(data):
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    temporary_file = DATA_FILE + '.tmp'
    try:
        with open(temporary_file, 'w', encoding='utf-8') as cache:
            json.dump(data, cache, indent=2)
        os.replace(temporary_file, DATA_FILE)
    finally:
        if os.path.exists(temporary_file):
            os.remove(temporary_file)


def write_validation_cache(data):
    os.makedirs(os.path.dirname(VALIDATION_DATA_FILE), exist_ok=True)
    temporary_file = VALIDATION_DATA_FILE + '.tmp'
    try:
        with open(temporary_file, 'w', encoding='utf-8') as cache:
            json.dump(data, cache, indent=2)
        os.replace(temporary_file, VALIDATION_DATA_FILE)
    finally:
        if os.path.exists(temporary_file):
            os.remove(temporary_file)


def configure_routes_triage_its(app):
    @app.route('/triage_its')
    @dashboard_tile(section='tools', title='HSD-ES Tickets', description='Review recent Outlook tickets.', icon='mail', order=65)
    def triage_its_dashboard():
        error = None
        try:
            data = read_cache()
        except (OSError, ValueError) as exception:
            data = {'scanned_at': None, 'tickets': []}
            error = f'Could not read the saved tickets: {exception}'
        try:
            validation_data = read_validation_cache()
        except (OSError, ValueError) as exception:
            validation_data = {'scanned_at': None, 'rows': []}
            error = error or f'Could not read validation data: {exception}'
        return render_template('triage_its_dashboard.html', data=data, validation_data=validation_data, error=error)

    @app.route('/triage_its/delete', methods=['POST'])
    def triage_its_delete_rows():
        payload = request.get_json(silent=True) or {}
        row_type = payload.get('type')
        selected_ids = {str(value) for value in payload.get('ids', [])}
        if not selected_ids or row_type not in ('tickets', 'validation'):
            return {'status': 'error', 'message': 'Choose rows to delete.'}, 400
        try:
            if row_type == 'tickets':
                cache = read_cache()
                present = {ticket['its'] for ticket in cache.get('tickets', [])}
                removed = selected_ids & present
                cache['tickets'] = [ticket for ticket in cache.get('tickets', []) if ticket['its'] not in removed]
                cache['deleted_its'] = sorted(set(cache.get('deleted_its', [])) | removed)
                write_cache(cache)
            else:
                cache = read_validation_cache()
                present = {row['row_id'] for row in cache.get('rows', [])}
                removed = selected_ids & present
                cache['rows'] = [row for row in cache.get('rows', []) if row['row_id'] not in removed]
                cache['deleted_row_ids'] = sorted(set(cache.get('deleted_row_ids', [])) | removed)
                write_validation_cache(cache)
        except (OSError, ValueError) as exception:
            return {'status': 'error', 'message': f'Could not save deletions: {exception}'}, 500
        return {'status': 'success', 'deleted': len(removed)}