"""Local browser notepad. Python 3.10+, standard library only."""
import argparse
import json
import os
import re
import tempfile
import threading
import webbrowser
import uuid
import subprocess
import shutil
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent

def validate_group(name):
    if not isinstance(name, str) or not name or len(name) > 80 or name != name.strip() or name.endswith('.') or re.search(r'[<>:"/\\|?*\x00-\x1f]', name) or name in ('.', '..', 'ゴミ箱', '未分類') or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)', name, re.I):
        raise ValueError('グループ名に使用できない文字・名前が含まれています。')

def validate(data):
    if not isinstance(data, dict) or not isinstance(data.get('notes'), list):
        raise ValueError('Invalid notes')
    if type(data.get('revision')) is not int or data['revision'] < 0:
        raise ValueError('Invalid revision')
    ids = set()
    for note in data['notes']:
        if not isinstance(note, dict) or not all(isinstance(note.get(k), str) for k in ('id', 'created', 'title', 'body')):
            raise ValueError('Invalid note')
        if not note['id'] or note['id'] in ids:
            raise ValueError('Duplicate note')
        datetime.fromisoformat(note['created'].replace('Z', '+00:00'))
        if note.get('group', ''):
            validate_group(note['group'])
        ids.add(note['id'])
    if data.get('activeId') not in ids and not (not ids and data.get('activeId') is None):
        raise ValueError('Invalid selection')

class NoteServer(ThreadingHTTPServer):
    def __init__(self, address, data_file):
        self.data_file = Path(data_file)
        self.lock = threading.Lock()
        super().__init__(address, Handler)
        self.trash_dir.mkdir(parents=True, exist_ok=True)
        if self.data_file.exists():
            legacy = json.loads(self.data_file.read_text(encoding='utf-8'))
            if any('body' in note for note in legacy.get('notes', [])):
                validate(legacy)
                backup = self.data_file.with_suffix('.json.bak')
                if not backup.exists():
                    self.atomic_write(backup, self.data_file.read_text(encoding='utf-8'))
                self.write_notes(legacy)
        self.sync_folder()

    @staticmethod
    def read_text_file(path):
        raw = path.read_bytes()
        if raw.startswith((b'\xff\xfe', b'\xfe\xff')):
            return raw.decode('utf-16')
        try:
            return raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            return raw.decode('cp932')

    def sync_folder(self):
        """Reconcile the file inventory without rewriting memo contents."""
        data = json.loads(self.data_file.read_text(encoding='utf-8')) if self.data_file.exists() else {'notes': [], 'trash': [], 'activeId': None, 'revision': 0}
        before = json.dumps(data, ensure_ascii=False)
        groups = sorted(p.name for p in self.notes_dir.iterdir() if p.is_dir() and not p.is_symlink() and p.name != 'ゴミ箱')
        groups = [g for g in groups if self.valid_group(g)]
        data['groups'] = groups
        for key, directory, path_for in (('notes', self.notes_dir, self.note_path), ('trash', self.trash_dir, self.trash_path)):
            directories = [('', directory)] + ([(g, self.group_dir(g)) for g in groups] if key == 'notes' else [])
            files = {(g.casefold(), p.name.casefold()): (g, p) for g, d in directories for p in d.iterdir() if p.is_file() and not p.is_symlink() and p.suffix.lower() == '.txt'}
            entries = []
            for note in data.get(key, []):
                found = files.pop(((note.get('group', '') if key == 'notes' else '').casefold(), note['filename'].casefold()), None)
                if found is not None:
                    group, path = found
                    entries.append({**note, 'filename': path.name, 'group': group if key == 'notes' else note.get('group', '')})
            for group, path in sorted(files.values(), key=lambda item: (-item[1].stat().st_mtime, item[1].name.casefold())):
                self.note_path(path.name, group) if key == 'notes' else path_for(path.name)
                self.read_text_file(path)
                entries.append({'id': str(uuid.uuid4()), 'created': datetime.fromtimestamp(path.stat().st_ctime).astimezone().isoformat(), 'title': path.stem, 'filename': path.name, 'group': group})
            data[key] = entries
        if data['activeId'] not in {n['id'] for n in data['notes']}:
            data['activeId'] = data['notes'][0]['id'] if data['notes'] else None
        if json.dumps(data, ensure_ascii=False) != before:
            data['revision'] += 1
            self.atomic_write(self.data_file, json.dumps(data, ensure_ascii=False, indent=2))

    @property
    def notes_dir(self):
        return self.data_file.parent / 'memos'

    @staticmethod
    def valid_group(name):
        try:
            validate_group(name)
            return True
        except ValueError:
            return False

    def group_dir(self, name=''):
        if not name:
            return self.notes_dir
        validate_group(name)
        path = self.notes_dir / name
        if path.is_symlink() or path.resolve().parent != self.notes_dir.resolve():
            raise ValueError('Invalid group path')
        return path

    def change_group(self, name, old_name=None):
        validate_group(name)
        destination = self.group_dir(name)
        if any(p.name.casefold() == name.casefold() for p in self.notes_dir.iterdir()):
            raise ValueError('同じ名前のフォルダーが存在します。')
        if old_name is None:
            destination.mkdir()
            return
        if not old_name:
            raise ValueError('未分類は名前を変更できません。')
        source = self.group_dir(old_name)
        metadata = json.loads(self.data_file.read_text(encoding='utf-8'))
        source.rename(destination)
        try:
            for note in metadata['notes'] + metadata.get('trash', []):
                if note.get('group') == old_name:
                    note['group'] = name
            metadata['groups'] = [name if g == old_name else g for g in metadata.get('groups', [])]
            metadata['revision'] += 1
            self.atomic_write(self.data_file, json.dumps(metadata, ensure_ascii=False, indent=2))
        except OSError:
            destination.rename(source)
            raise

    @property
    def trash_dir(self):
        return self.notes_dir / 'ゴミ箱'

    def trash_path(self, filename):
        if not isinstance(filename, str) or Path(filename).name != filename or not filename.lower().endswith('.txt'):
            raise ValueError('Invalid filename')
        path = self.trash_dir / filename
        if self.trash_dir.is_symlink() or path.is_symlink() or path.resolve().parent != self.trash_dir.resolve():
            raise ValueError('Invalid trash path')
        return path

    def delete_note(self, note_id, permanent=False):
        metadata = json.loads(self.data_file.read_text(encoding='utf-8'))
        metadata.setdefault('trash', [])
        collection = metadata['trash'] if permanent else metadata['notes']
        note = next((n for n in collection if n['id'] == note_id), None)
        if note is None:
            raise ValueError('メモが見つかりません。')
        source = self.trash_path(note['filename']) if permanent else self.note_path(note['filename'], note.get('group', ''))
        original = self.read_text_file(source)
        if permanent:
            source.unlink()
        else:
            filename = note['filename']
            stem, number = Path(filename).stem, 2
            while self.trash_path(filename).exists():
                filename = f'{stem} ({number}).txt'
                number += 1
            destination = self.trash_path(filename)
            source.rename(destination)
            metadata['trash'].insert(0, {**note, 'filename': filename})
        collection.remove(note)
        if metadata['activeId'] == note_id:
            metadata['activeId'] = metadata['notes'][0]['id'] if metadata['notes'] else None
        metadata['revision'] += 1
        try:
            self.atomic_write(self.data_file, json.dumps(metadata, ensure_ascii=False, indent=2))
        except OSError:
            if permanent:
                self.atomic_write(source, original)
            else:
                destination.rename(source)
            raise

    def restore_note(self, note_id):
        metadata = json.loads(self.data_file.read_text(encoding='utf-8'))
        note = next((n for n in metadata.get('trash', []) if n['id'] == note_id), None)
        if note is None:
            raise ValueError('メモが見つかりません。')
        source = self.trash_path(note['filename'])
        group = note.get('group', '')
        self.group_dir(group).mkdir(parents=True, exist_ok=True)
        filename = note['filename']
        stem, number = Path(filename).stem, 2
        while self.note_path(filename, group).exists():
            filename = f'{stem} ({number}).txt'
            number += 1
        destination = self.note_path(filename, group)
        source.rename(destination)
        metadata['trash'].remove(note)
        metadata['notes'].insert(0, {**note, 'filename': filename})
        metadata['activeId'] = note_id
        metadata['revision'] += 1
        try:
            self.atomic_write(self.data_file, json.dumps(metadata, ensure_ascii=False, indent=2))
        except OSError:
            destination.rename(source)
            raise

    def note_path(self, filename, group=''):
        if not isinstance(filename, str) or Path(filename).name != filename or not filename.lower().endswith('.txt'):
            raise ValueError('Invalid filename')
        directory = self.group_dir(group)
        path = directory / filename
        if path.resolve().parent != directory.resolve() or path.is_symlink():
            raise ValueError('Invalid note path')
        return path

    @staticmethod
    def atomic_write(target, text):
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', newline='', dir=target.parent, delete=False) as output:
                temporary = Path(output.name)
                output.write(text)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, target)
        finally:
            if temporary and temporary.exists():
                temporary.unlink()

    def write_notes(self, data):
        validate(data)
        old = json.loads(self.data_file.read_text(encoding='utf-8')) if self.data_file.exists() else {'notes': []}
        owners = {(n.get('group', '').casefold(), n['filename'].casefold()): n['id'] for n in old['notes'] if 'filename' in n}
        previous_notes = {n['id']: n for n in old['notes']}
        occupied = {(g.casefold(), p.name.casefold()) for g in ['', *old.get('groups', [])] for p in self.group_dir(g).glob('*')}
        assigned = set()
        entries, writes = [], []
        for note in data['notes']:
            group = note.get('group', '')
            if group and group not in old.get('groups', []):
                raise ValueError('グループが存在しません。')
            stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', note['title'].strip())[:80].rstrip(' .') or '無題のメモ'
            if re.match(r'^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)', stem, re.I):
                stem = '_' + stem
            filename, number = stem + '.txt', 2
            previous_note = previous_notes.get(note['id'])
            if previous_note and previous_note.get('title') == note['title'] and 'filename' in previous_note:
                filename = previous_note['filename']
            while (group.casefold(), filename.casefold()) in assigned or ((group.casefold(), filename.casefold()) in occupied and owners.get((group.casefold(), filename.casefold())) != note['id']):
                filename = f'{stem} ({number}).txt'
                number += 1
            assigned.add((group.casefold(), filename.casefold()))
            entries.append({k: note[k] for k in ('id', 'created', 'title')} | {'filename': filename, 'group': group})
            writes.append((self.note_path(filename, group), note['body']))
        previous = []
        try:
            for path, body in writes:
                before = self.read_text_file(path) if path.exists() else None
                if before != body:
                    previous.append((path, before))
                    self.atomic_write(path, body)
            metadata = {**data, 'notes': entries, 'trash': old.get('trash', []), 'groups': old.get('groups', [])}
            self.atomic_write(self.data_file, json.dumps(metadata, ensure_ascii=False, indent=2))
        except OSError:
            for path, before in reversed(previous):
                if before is None:
                    path.unlink(missing_ok=True)
                else:
                    self.atomic_write(path, before)
            raise
        for note in old['notes']:
            filename = note.get('filename')
            if filename and (note.get('group', '').casefold(), filename.casefold()) not in assigned:
                self.note_path(filename, note.get('group', '')).unlink(missing_ok=True)

    def read_notes(self):
        self.sync_folder()
        if not self.data_file.exists():
            return {'notes': [], 'activeId': None, 'revision': 0}
        data = json.loads(self.data_file.read_text(encoding='utf-8'))
        for note in data['notes']:
            if 'filename' in note:
                note['body'] = self.read_text_file(self.note_path(note.pop('filename'), note.get('group', '')))
        if 'trash' in data:
            for note in data['trash']:
                note['body'] = self.read_text_file(self.trash_path(note.pop('filename')))
        validate(data)
        return data

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length < 4096:
                return self.reply(400, {'error': 'Invalid request'})
            data = json.loads(self.rfile.read(length))
            if not self.allowed():
                return self.reply(403, {'error': 'Forbidden'})
            if self.path not in ('/api/trash', '/api/delete', '/api/restore', '/api/group'):
                return self.reply(404, {'error': 'Not found'})
            if not isinstance(data, dict) or (self.path != '/api/group' and not isinstance(data.get('id'), str)) or type(data.get('revision')) is not int:
                return self.reply(400, {'error': 'Invalid request'})
            with self.server.lock:
                old = self.server.read_notes()
                if data['revision'] != old['revision']:
                    return self.reply(409, {'error': '別の画面で更新されました。再読み込みしてください。'})
                if self.path == '/api/group':
                    self.server.change_group(data.get('name'), data.get('oldName'))
                elif self.path == '/api/restore':
                    self.server.restore_note(data['id'])
                else:
                    self.server.delete_note(data['id'], permanent=self.path == '/api/delete')
                result = self.server.read_notes()
            self.reply(200, result)
        except ValueError as error:
            self.reply(400, {'error': str(error)})
        except (OSError, TypeError):
            self.reply(400, {'error': '操作できませんでした。ファイルと画面を確認してください。'})

    def reply(self, code, content, mime='application/json; charset=utf-8'):
        if not isinstance(content, bytes):
            content = json.dumps(content, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(content)

    def allowed(self):
        host = f'127.0.0.1:{self.server.server_port}'
        return self.headers.get('Host') == host and self.headers.get('Origin', f'http://{host}') == f'http://{host}'

    def do_GET(self):
        if not self.allowed():
            return self.reply(403, {'error': 'Forbidden'})
        path = urlsplit(self.path).path
        if path == '/api/notes':
            try:
                with self.server.lock:
                    data = self.server.read_notes()
                self.reply(200, data)
            except (OSError, ValueError, TypeError):
                self.reply(500, {'error': '保存ファイルを読み込めません。元のファイルは変更していません。'})
            return
        assets = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8'), '/vendor/materialize.min.css': ('vendor/materialize.min.css', 'text/css; charset=utf-8'), '/vendor/materialize.min.js': ('vendor/materialize.min.js', 'text/javascript; charset=utf-8')}
        if path not in assets:
            return self.reply(404, {'error': 'Not found'})
        filename, mime = assets[path]
        self.reply(200, (ROOT / 'notepad' / 'dist' / filename).read_bytes(), mime)

    def do_PUT(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 10_000_000:
                return self.reply(413, {'error': '保存容量の上限（10MB）を超えています。'})
            payload = self.rfile.read(length)
        except ValueError:
            return self.reply(400, {'error': 'Invalid length'})
        if not self.allowed():
            return self.reply(403, {'error': 'Forbidden'})
        if self.path != '/api/notes':
            return self.reply(404, {'error': 'Not found'})
        try:
            data = json.loads(payload)
            validate(data)
        except (ValueError, TypeError):
            return self.reply(400, {'error': 'メモの形式が正しくありません。'})
        try:
            with self.server.lock:
                old = self.server.read_notes()
                if old['revision'] != data['revision']:
                    return self.reply(409, {'error': '別の画面で更新されました。入力内容をコピーしてから再読み込みしてください。'})
                if {n['id'] for n in old['notes']} - {n['id'] for n in data['notes']}:
                    return self.reply(400, {'error': 'メモの削除にはゴミ箱を使用してください。'})
                data['revision'] += 1
                self.server.write_notes(data)
            self.reply(200, {'revision': data['revision']})
        except (OSError, ValueError, TypeError):
            self.reply(500, {'error': '保存できませんでした。入力内容をコピーして保管してください。'})

def open_browser(url, choice='default'):
    if choice == 'default':
        return webbrowser.open(url)
    candidates = [shutil.which('chrome')]
    for variable in ('PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA'):
        if os.environ.get(variable):
            candidates.append(str(Path(os.environ[variable]) / 'Google' / 'Chrome' / 'Application' / 'chrome.exe'))
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            subprocess.Popen([candidate, url])
            return True
    print('Chromeが見つかりません。表示されたURLをChromeで開いてください。', flush=True)
    return False

def main():
    parser = argparse.ArgumentParser(description='Python メモ帳')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--browser', choices=('default', 'chrome'), default='default')
    parser.add_argument('--data-file', type=Path, default=ROOT / 'data' / 'notes.json')
    args = parser.parse_args()
    server = NoteServer(('127.0.0.1', args.port), args.data_file)
    url = f'http://127.0.0.1:{server.server_port}'
    print(f'メモ帳: {url}\n保存先: {args.data_file}\n終了: Ctrl+C', flush=True)
    if not args.no_browser:
        open_browser(url, args.browser)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
