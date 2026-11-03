"""Isolated upload/download correctness and load checks; requires a local nginx.

Usage: python3 tests/transfer.py /path/to/drive-service --nginx /path/to/nginx
All processes bind loopback ports and all data lives in a temporary directory.
The ingress uses the repository example plus the production disk thread pool.
"""
import argparse
import concurrent.futures
import hashlib
import http.client
import json
import os
import pathlib
import re
import socket
import statistics
import subprocess
import tempfile
import threading
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('binary', type=pathlib.Path)
parser.add_argument('--nginx', default='nginx')
parser.add_argument('--rounds', type=int, default=3)
parser.add_argument('--frame-kib', type=int, default=64)
args = parser.parse_args()
assert args.rounds > 0
assert 1 <= args.frame_kib <= 256
project = pathlib.Path(__file__).resolve().parents[1]
CHUNK = 16 * 1024**2


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


with tempfile.TemporaryDirectory(prefix='drive-transfer-') as temp:
    work = pathlib.Path(temp)
    data = work / 'data'
    data.mkdir()
    backend_port, ingress_port = port(), port()
    config = (project / 'examples/nginx.conf').read_text(encoding='utf-8')
    config = config.replace('listen 8080;', f'listen 127.0.0.1:{ingress_port};')
    config = config.replace('/absolute/path/to/data/', str(data) + '/')
    config = config.replace('127.0.0.1:3104', f'127.0.0.1:{backend_port}')
    config = config.replace('# aio threads=drive_io;', 'aio threads=drive_io;')
    production = (project / 'deploy/nginx.conf').read_text(encoding='utf-8')
    pool = re.search(r'^thread_pool drive_io .*;', production, re.M).group(0)
    config = (f'daemon off; master_process off;\npid {work}/nginx.pid;\n'
              f'error_log {work}/nginx-error.log warn;\n{pool}\n'
              'events { worker_connections 128; }\nhttp {\naccess_log off;\n'
              f'client_body_temp_path {work}/body;\n'
              f'fastcgi_temp_path {work}/fastcgi;\n'
              f'uwsgi_temp_path {work}/uwsgi;\n'
              f'scgi_temp_path {work}/scgi;\n'
              f'proxy_temp_path {work}/proxy;\n{config}\n}}\n')
    conf = work / 'nginx.conf'
    conf.write_text(config, encoding='utf-8')
    subprocess.run([args.nginx, '-t', '-p', temp + '/', '-c', str(conf)], check=True)
    backend = subprocess.Popen([str(args.binary.resolve())], env=dict(
        os.environ, CLOUDDRIVE_ROOT=str(data), DRIVE_LISTEN=f'127.0.0.1:{backend_port}',
        DRIVE_DISK_RESERVE_BYTES='0'), stdout=subprocess.DEVNULL)
    ingress = None

    def request(method, path, body=None, headers=None, direct=False):
        conn = http.client.HTTPConnection('127.0.0.1', backend_port if direct else ingress_port, timeout=30)
        h = dict(headers or {})
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            h['Content-Type'] = 'application/json'
        try:
            conn.request(method, path, body, h)
            response = conn.getresponse()
            payload = response.read()
            return response.status, payload, dict(response.getheaders())
        finally:
            conn.close()

    def success(method, path, body=None):
        code, payload, _ = request(method, path, body)
        assert code in (200, 201), (code, payload[:500])
        return json.loads(payload)

    try:
        ingress = subprocess.Popen([args.nginx, '-p', temp + '/', '-c', str(conf)])
        for _ in range(100):
            try:
                if request('GET', '/healthz')[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(.05)
        else:
            raise RuntimeError('isolated services did not start')

        payload = bytes(range(256)) * (CHUNK // 256)
        digest = hashlib.sha256(payload * 3).digest()
        replacement = bytes(reversed(range(256))) * (CHUNK // 256)
        replacement_digest = hashlib.sha256(replacement * 3).digest()
        latencies, rss = [], []
        stop = threading.Event()

        def probe():
            while not stop.is_set():
                begin = time.perf_counter()
                assert request('GET', '/healthz')[0] == 200
                assert request('GET', '/api/clouddrive/list')[0] == 200
                latencies.append((time.perf_counter() - begin) * 1000)
                status = pathlib.Path(f'/proc/{backend.pid}/status').read_text()
                rss.append(int(re.search(r'VmRSS:\s+(\d+)', status).group(1)))
                stop.wait(.02)

        def upload(iteration, content=payload):
            session = success('POST', '/api/clouddrive/upload-session', dict(
                path='', name='fixture.bin', size=CHUNK * 3, lastModified=iteration))
            sid = session['id']
            begin = time.perf_counter()
            with concurrent.futures.ThreadPoolExecutor(3) as pool:
                def send(index):
                    # Many small HTTP frames exercise the upload write buffer.
                    frame = args.frame_kib * 1024
                    frames = (content[i:i+frame] for i in range(0, CHUNK, frame))
                    success('PUT', f'/api/clouddrive/upload-session/{sid}/chunk/{index}', frames)
                list(pool.map(send, range(3)))
            success('POST', f'/api/clouddrive/upload-session/{sid}/complete')
            return 48 / (time.perf_counter() - begin)

        def download(expected=(digest,)):
            conn = http.client.HTTPConnection('127.0.0.1', ingress_port, timeout=30)
            try:
                conn.request('GET', '/api/clouddrive/download?path=fixture.bin')
                response = conn.getresponse()
                assert response.status == 200
                actual = hashlib.sha256()
                total = 0
                while block := response.read(256 * 1024):
                    actual.update(block)
                    total += len(block)
                assert total == CHUNK * 3 and actual.digest() in expected
            finally:
                conn.close()

        with concurrent.futures.ThreadPoolExecutor(1) as observer:
            monitor = observer.submit(probe)
            try:
                uploads, downloads, mixed = [], [], []
                for iteration in range(args.rounds):
                    uploads.append(upload(iteration))
                    begin = time.perf_counter()
                    with concurrent.futures.ThreadPoolExecutor(3) as pool:
                        list(pool.map(lambda _: download(), range(3)))
                    downloads.append(144 / (time.perf_counter() - begin))
                    # Atomic overwrite while downloading must expose whole files.
                    with concurrent.futures.ThreadPoolExecutor(2) as pool:
                        writer = pool.submit(upload, iteration, replacement)
                        reader = pool.submit(download, (digest, replacement_digest))
                        mixed.append(writer.result())
                        reader.result()
            finally:
                stop.set()
                monitor.result()
        url = '/api/clouddrive/download?path=fixture.bin'
        for value, expected in [('bytes=1-3', replacement[1:4]), ('bytes=-2', replacement[-2:])]:
            code, body, _ = request('GET', url, headers={'Range': value})
            assert code == 206 and body == expected
        code, body, headers = request('HEAD', url)
        assert code == 200 and not body and int(headers['Content-Length']) == CHUNK * 3
        assert request('GET', url, headers={'Range': f'bytes={CHUNK*3}-'})[0] == 416
        assert request('GET', '/_drive_internal/fixture.bin')[0] == 404
        print(json.dumps(dict(
            scope='isolated loopback, Linux temporary filesystem, HTTP nginx, 48 MiB, 3 streams',
            request_frame_kib=args.frame_kib,
            upload_mib_s=uploads, download_aggregate_mib_s=downloads, mixed_upload_mib_s=mixed,
            upload_median_mib_s=statistics.median(uploads),
            download_aggregate_median_mib_s=statistics.median(downloads),
            health_and_list_p95_ms=sorted(latencies)[min(len(latencies)-1, int(len(latencies)*.95))],
            backend_peak_rss_kib=max(rss),
            checks=['checksums', 'simultaneous upload/download', 'atomic overwrite',
                    'Range 206/416', 'HEAD', 'internal location protection', 'health/list under load']
        ), indent=2))
    finally:
        if ingress is not None:
            ingress.terminate()
            ingress.wait(timeout=10)
        backend.terminate()
        backend.wait(timeout=10)
