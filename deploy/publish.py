"""Upload a locally built, tested release. Existing data and paused businesses stay intact."""
import hashlib,pathlib,sys,time,urllib.request
from remote import connect,run
root=pathlib.Path(__file__).resolve().parents[1];binary=root/'artifacts/drive-service'
if not binary.is_file():raise RuntimeError('Run deploy/build.ps1 first')
tag='drive-service:'+hashlib.sha256(binary.read_bytes()).hexdigest()[:12]
c=connect()
try:
    if run(c,'mkdir -p /srv/drive-service && chmod 700 /srv/drive-service'):raise RuntimeError('cannot prepare deployment directory')
    s=c.open_sftp()
    for name in ['stage.py','activate.py','rollback.py','nginx.conf','compose.template.yaml','Dockerfile','.dockerignore','renew.sh']:
        s.put(str(root/'deploy'/name),'/srv/drive-service/'+name)
    s.put(str(binary),'/srv/drive-service/drive-service');s.chmod('/srv/drive-service/drive-service',0o755)
    with s.file('/srv/drive-service/release-image','w') as f:f.write(tag)
    s.close()
    if run(c,'python3 /srv/drive-service/stage.py'):raise RuntimeError('staging failed; inspect server logs')
    if run(c,'docker exec drive-service /drive-service --healthcheck'):raise RuntimeError('backend health check failed')
    # During initial setup the original ingress is still active. Do not replace it here.
    if run(c,'test -f /srv/drive-service/activated')==0:
        if run(c,'docker exec blogweb-nginx nginx -t && docker exec blogweb-nginx nginx -s reload'):raise RuntimeError('ingress reload failed')
    print('Uploaded '+tag+'. Initial activation, if needed: python3 /srv/drive-service/activate.py')
finally:c.close()
