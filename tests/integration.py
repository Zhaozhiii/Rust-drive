"""Isolated Linux integration tests; never uses the production data directory."""
import concurrent.futures, hashlib, http.client, json, os, pathlib, socket, subprocess, sys, tempfile, time, urllib.parse

BIN = os.path.abspath(sys.argv[1])
CHUNK = 16 * 1024**2
checks = []
with tempfile.TemporaryDirectory(prefix='drive-tests-') as temp:
    root = pathlib.Path(temp)
    (root/'original.txt').write_bytes(b'original')
    (root/'escape').symlink_to('/etc', target_is_directory=True)
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    env = dict(os.environ, CLOUDDRIVE_ROOT=temp, DRIVE_LISTEN=f'127.0.0.1:{port}', DRIVE_MAX_BYTES=str(90*1024**2), DRIVE_MAX_FILE_BYTES=str(40*1024**2), DRIVE_DISK_RESERVE_BYTES='0')
    def req(method, url, value=None, raw=None, headers=None):
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
        h = headers or {}
        if value is not None: raw=json.dumps(value).encode();h['Content-Type']='application/json'
        c.request(method, url, raw, h); r=c.getresponse(); data=r.read(); code=r.status; hdr=dict(r.getheaders()); c.close()
        try: data=json.loads(data)
        except (ValueError,UnicodeDecodeError): pass
        return code,data,hdr
    def start():
        p = subprocess.Popen([BIN], env=env, stdout=subprocess.DEVNULL)
        for _ in range(100):
            try:
                if req('GET','/healthz')[0]==200:return p
            except OSError:pass
            time.sleep(.05)
        raise RuntimeError('startup failed')
    def ok(label): checks.append(label);print('PASS',label,flush=True)
    def create(name,size,path=''):
        code,d,_=req('POST','/api/clouddrive/upload-session',dict(path=path,name=name,size=size,lastModified=123))
        assert code==201,(code,d)
        return d['id']
    def chunk(id,i,data):return req('PUT',f'/api/clouddrive/upload-session/{id}/chunk/{i}',raw=data)
    def complete(id):return req('POST',f'/api/clouddrive/upload-session/{id}/complete')
    p=start()
    try:
        assert req('GET','/api/clouddrive/list')[1]['totalSize']==8
        assert req('DELETE','/api/clouddrive/remove?path=')[0]==400
        for path in ['../etc/passwd','/etc/passwd','.tmp/x','.uploads/x','escape/passwd']:
            assert req('GET','/api/clouddrive/download?path='+urllib.parse.quote(path))[0] in (400,404)
        assert req('POST','/api/clouddrive/mkdir',{'name':'../bad'})[0]==400
        assert req('POST','/api/clouddrive/mkdir',{'name':'测试目录'})[0]==200
        assert req('POST','/api/clouddrive/mkdir',{'name':'测试目录'})[0]==409
        ok('directory, traversal, symlink and root-delete protection')
        for size in [0,40*1024**2+1]:
            assert req('POST','/api/clouddrive/upload-session',dict(path='',name='bad',size=size,lastModified=1))[0]==400
        ids=[create('reserved'+str(i),40*1024**2) for i in range(2)]
        assert req('POST','/api/clouddrive/upload-session',dict(path='',name='quota',size=11*1024**2,lastModified=1))[0]==507
        for id in ids:assert req('DELETE',f'/api/clouddrive/upload-session/{id}')[0]==200
        ok('single-file boundary, total quota and concurrent reservations')
        data=(bytes(range(256)) * (34*1024**2//256)) + b'end'
        id=create('中文 & ?#%.bin',len(data),'测试目录')
        assert complete(id)[0]==409
        assert chunk(id,0,b'bad')[0]==400
        assert chunk(id,99,b'bad')[0]==400
        assert chunk(id,2,data[2*CHUNK:])[0]==200
        assert chunk(id,2,data[2*CHUNK:])[0]==200
        p.terminate();p.wait(timeout=10);p=start()
        assert req('GET',f'/api/clouddrive/upload-session/{id}')[1]['completed']==[2]
        with concurrent.futures.ThreadPoolExecutor(3) as pool:
            responses=list(pool.map(lambda i:chunk(id,i,data[i*CHUNK:(i+1)*CHUNK]),[1,0,0]))
        assert all(r[0]==200 for r in responses),responses
        assert complete(id)[0]==200
        target=root/'测试目录'/'中文 & ?#%.bin'
        assert hashlib.sha256(target.read_bytes()).digest()==hashlib.sha256(data).digest()
        assert req('GET',f'/api/clouddrive/upload-session/{id}')[0]==404
        assert req('GET','/api/clouddrive/download?path='+urllib.parse.quote('测试目录/中文 & ?#%.bin'))[2]['x-accel-redirect'].startswith('/_drive_internal/')
        ok('out-of-order, duplicate/concurrent chunks, missing/short chunks, restart resume, checksum')
        id=create('中文 & ?#%.bin',3,'测试目录');assert chunk(id,0,b'new')[0]==200;assert complete(id)[0]==200
        assert target.read_bytes()==b'new'
        assert req('GET','/api/clouddrive/list')[1]['totalSize']==11
        ok('atomic overwrite and incremental usage accounting')
        id=create('cancel.bin',CHUNK)
        c=http.client.HTTPConnection('127.0.0.1',port,timeout=5);c.putrequest('PUT',f'/api/clouddrive/upload-session/{id}/chunk/0');c.putheader('Content-Length',str(CHUNK));c.endheaders();c.send(b'x'*4096);c.close();time.sleep(.1)
        assert req('GET',f'/api/clouddrive/upload-session/{id}')[1]['completed']==[]
        assert req('DELETE',f'/api/clouddrive/upload-session/{id}')[0]==200
        assert not (root/'.uploads'/id).exists()
        ok('interrupted stream remains incomplete, cancellation releases temporary data')
        id=create('too-long',3);assert chunk(id,0,b'toolong')[0]==400;assert req('DELETE',f'/api/clouddrive/upload-session/{id}')[0]==200
        id=create('race',3);assert chunk(id,0,b'yes')[0]==200
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            a=pool.submit(complete,id);b=pool.submit(req,'DELETE',f'/api/clouddrive/upload-session/{id}');a.result();b.result()
        assert not (root/'.uploads'/id).exists()
        ok('oversized chunk and complete/cancel race')
        boundary='drive-test';payload=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="legacy.txt"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+b'legacy'+f'\r\n--{boundary}--\r\n'.encode())
        code,d,_=req('POST','/api/clouddrive/upload',raw=payload,headers={'Content-Type':f'multipart/form-data; boundary={boundary}'})
        assert code==200,(code,d);assert (root/'legacy.txt').read_bytes()==b'legacy'
        assert req('DELETE','/api/clouddrive/remove?path='+urllib.parse.quote('测试目录'))[0]==200
        ok('legacy multipart upload, recursive directory deletion')
        assert req('POST','/api/clouddrive/mkdir',{'name':'removed-destination'})[0]==200
        id=create('retained.bin',3,'removed-destination')
        assert req('DELETE','/api/clouddrive/remove?path=removed-destination')[0]==200
        p.kill();p.wait(timeout=10);p=start()
        assert req('GET',f'/api/clouddrive/upload-session/{id}')[0]==200
        assert req('DELETE',f'/api/clouddrive/upload-session/{id}')[0]==200
        ok('hard restart retains cancellable session after destination deletion')
        p.terminate();p.wait(timeout=10);env['DRIVE_MAX_BYTES']=str(10*1024**3);env['DRIVE_MAX_FILE_BYTES']=str(5*1024**3);p=start()
        used=req('GET','/api/clouddrive/list')[1]['totalSize']
        id1=create('exact-5g',5*1024**3)
        assert req('POST','/api/clouddrive/upload-session',dict(path='',name='over-5g',size=5*1024**3+1,lastModified=1))[0]==400
        id2=create('exact-total',5*1024**3-used)
        assert req('POST','/api/clouddrive/upload-session',dict(path='',name='over-total',size=1,lastModified=1))[0]==507
        for id in [id1,id2]:assert req('DELETE',f'/api/clouddrive/upload-session/{id}')[0]==200
        ok('exact 5 GiB file and 10 GiB total reservation boundaries without allocating file contents')
        p.terminate();p.wait(timeout=10);env['DRIVE_DISK_RESERVE_BYTES']=str(2**63);p=start()
        assert req('POST','/api/clouddrive/upload-session',dict(path='',name='no-space',size=1,lastModified=1))[0]==507
        ok('disk reserve enforcement without filling disk')
    finally:
        p.terminate();p.wait(timeout=10)
print(json.dumps({'passed':checks},ensure_ascii=False))
