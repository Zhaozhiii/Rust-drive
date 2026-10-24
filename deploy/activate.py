"""Freeze writes, back up data, replace ingress, then pause other business services."""
import gzip, hashlib, json, pathlib, shutil, subprocess, tarfile, time, urllib.request
ROOT=pathlib.Path('/srv/drive-service');state=json.loads((ROOT/'deployment-state.json').read_text());backup=pathlib.Path(state['backup']);data=pathlib.Path('/root/blogweb/clouddrive')
def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
def manifest():
    result=[]
    for p in sorted(data.rglob('*')):
        if p.is_file() and not p.is_symlink():
            h=hashlib.sha256()
            with p.open('rb') as f:
                for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
            result.append({'path':str(p.relative_to(data)),'size':p.stat().st_size,'sha256':h.hexdigest()})
    return result
def health():
    for _ in range(60):
        try:
            with urllib.request.urlopen('http://127.0.0.1:3104/healthz',timeout=2) as r:
                if r.status==200:return
        except OSError:pass
        time.sleep(.5)
    raise RuntimeError('drive backend is not healthy')
if (ROOT/'activated').exists():raise RuntimeError('Already activated; use compose for future releases')
health()
try:
    # Stop both writers while creating a consistent, full backup (including legacy temporary data).
    run('docker','stop','-t','30','blogweb-server','drive-service')
    before=manifest();(backup/'files-before.json').write_text(json.dumps(before,ensure_ascii=False,indent=2))
    archive=backup/'clouddrive.tar'
    with tarfile.open(archive,'w') as tar:tar.add(data,arcname='clouddrive',recursive=True)
    archive.chmod(0o600)
    h=hashlib.sha256()
    with archive.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    (backup/'clouddrive.tar.sha256').write_text(h.hexdigest()+'  clouddrive.tar\n')
    # Password expands only inside the MySQL container and is never printed.
    dump=backup/'mysql.sql.gz'
    proc=subprocess.Popen(['docker','exec','blogweb-mysql','sh','-c','exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --all-databases --single-transaction --routines --events --triggers --set-gtid-purged=OFF'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    with gzip.open(dump,'wb') as f:shutil.copyfileobj(proc.stdout,f)
    err=proc.stderr.read();code=proc.wait()
    if code:raise RuntimeError('MySQL backup failed; exit '+str(code))
    dump.chmod(0o600)
    after=manifest();assert before==after,'Data changed during backup'
    (backup/'files-after.json').write_text(json.dumps(after,ensure_ascii=False,indent=2))
    # Verify the complete archive against the pre-backup manifest, not merely its size.
    expected={x['path']:x for x in before}
    with tarfile.open(archive,'r') as tar:
        for member in tar:
            if member.isfile():
                rel=str(pathlib.PurePosixPath(member.name).relative_to('clouddrive'));f=tar.extractfile(member);digest=hashlib.sha256()
                for b in iter(lambda:f.read(1024*1024),b''):digest.update(b)
                assert digest.hexdigest()==expected[rel]['sha256'],rel
    (backup/'archive-verified').write_text('All archived file contents match files-before.json\n')
    run('docker','start','drive-service');health()
    run('docker','compose','-f',str(ROOT/'compose.yaml'),'run','--rm','--no-deps','nginx','nginx','-t')
    run('docker','stop','blogweb-nginx');run('docker','rename','blogweb-nginx',state['old_nginx'])
    run('docker','update','--restart=no',state['old_nginx'])
    run('docker','compose','-f',str(ROOT/'compose.yaml'),'up','-d','nginx')
    run('curl','--fail','--silent','--show-error','--resolve','drive.zhiii.top:443:127.0.0.1','https://drive.zhiii.top/healthz')
    # Preserve service containers, image layers, volumes and original restart policies.
    for name,info in state['containers'].items():
        if name=='blogweb-nginx':continue
        run('docker','update','--restart=no',name)
        if info['running'] and name!='blogweb-server':run('docker','stop','-t','30',name)
    for timer in state['timers']:run('systemctl','disable','--now',timer)
    # Replace only the old certificate cron entry. Preserve unrelated entries.
    lines=[line for line in state['crontab'].splitlines() if not ('certbot' in line and 'renew' in line)]
    lines.append('17 3 * * * /bin/sh /srv/drive-service/renew.sh >> /var/log/drive-cert-renew.log 2>&1')
    run('crontab','-',input='\n'.join(lines)+'\n',text=True)
    (ROOT/'activated').write_text(time.strftime('%Y-%m-%d %H:%M:%S %z')+'\n')
    print('Activated. File manifest unchanged; other business containers paused.')
except BaseException:
    print('Activation failed. Restoring the previous services and ingress.',flush=True)
    subprocess.run(['python3',str(ROOT/'rollback.py')],check=False)
    raise
