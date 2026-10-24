"""Run on the server after uploading the release into /srv/drive-service."""
import datetime, json, pathlib, shutil, subprocess
ROOT=pathlib.Path('/srv/drive-service');ROOT.mkdir(parents=True,exist_ok=True)
def run(*args,**kwargs):return subprocess.run(args,check=True,**kwargs)
state_file=ROOT/'deployment-state.json'
if not state_file.exists():
    stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S');backup=ROOT/'backups'/stamp;backup.mkdir(parents=True,mode=0o700)
    names=['shirone-blog','blogweb-client','blogweb-server','nnnuyy-api','blogweb-sadb','blogweb-mysql','ai-video-app','blogweb-nginx']
    data=json.loads(subprocess.check_output(['docker','inspect',*names]))
    states={x['Name'].lstrip('/'):{'restart':x['HostConfig']['RestartPolicy'],'running':x['State']['Running']} for x in data}
    nginx=next(x for x in data if x['Name']=='/blogweb-nginx')
    image=json.loads(subprocess.check_output(['docker','image','inspect',nginx['Image']]))[0]
    timers={}
    for name in ['nnnuyy-cert-renew.timer','nnnuyy-backup.timer']:
        timers[name]={'enabled':subprocess.run(['systemctl','is-enabled',name],capture_output=True,text=True).stdout.strip(),'active':subprocess.run(['systemctl','is-active',name],capture_output=True,text=True).stdout.strip()}
    cron=subprocess.run(['crontab','-l'],capture_output=True,text=True).stdout
    state={'backup':str(backup),'containers':states,'old_nginx':'blogweb-nginx-before-drive-'+stamp,'nginx_image':image['RepoDigests'][0],'timers':timers,'crontab':cron}
    state_file.write_text(json.dumps(state,indent=2));state_file.chmod(0o600)
    for p in ['/root/blogweb/nginx/nginx.conf','/root/blogweb/docker-compose.yml','/root/blogweb/.deploy-compose.yml']:
        dest=backup/('nginx.conf' if p.endswith('nginx.conf') else pathlib.Path(p).name);shutil.copy2(p,dest);dest.chmod(0o600)
    (backup/'crontab').write_text(cron);(backup/'crontab').chmod(0o600)
    run('tar','-czf',str(backup/'old-source.tar.gz'),'--exclude=node_modules','--exclude=.next','--exclude=.git','-C','/root/blogweb','server','client');(backup/'old-source.tar.gz').chmod(0o600)
state=json.loads(state_file.read_text())
config=pathlib.Path('/root/blogweb/nginx/nginx.conf')
if not pathlib.Path('/etc/letsencrypt/live/drive.zhiii.top/fullchain.pem').exists():
    text=config.read_text()
    if '# DRIVE ACME STAGING' not in text:
        block='''
    # DRIVE ACME STAGING
    server {
        listen 80;
        server_name drive.zhiii.top;
        location ^~ /.well-known/acme-challenge/ { root /var/www/acme; }
        location / { return 503; }
    }
'''
        pos=text.rfind('}');config.write_text(text[:pos]+block+text[pos:])
        try:run('docker','exec','blogweb-nginx','nginx','-t');run('docker','exec','blogweb-nginx','nginx','-s','reload')
        except BaseException:config.write_text(text);raise
    run('docker','run','--rm','-v','/etc/letsencrypt:/etc/letsencrypt','-v','/var/lib/letsencrypt:/var/lib/letsencrypt','-v','/var/log/letsencrypt:/var/log/letsencrypt','-v','/root/blogweb/acme:/var/www/acme','certbot/certbot@sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20','certonly','--webroot','-w','/var/www/acme','-d','drive.zhiii.top','--cert-name','drive.zhiii.top','--non-interactive','--agree-tos','--register-unsafely-without-email')
compose=(ROOT/'compose.template.yaml').read_text().replace('NGINX_IMAGE',state['nginx_image']).replace('DRIVE_IMAGE',(ROOT/'release-image').read_text().strip())
(ROOT/'compose.yaml').write_text(compose)
run('docker','build','-t',(ROOT/'release-image').read_text().strip(),'-f',str(ROOT/'Dockerfile'),str(ROOT))
run('docker','compose','-f',str(ROOT/'compose.yaml'),'up','-d','drive')
run('docker','compose','-f',str(ROOT/'compose.yaml'),'run','--rm','--no-deps','nginx','nginx','-t')
print('Backend and certificate staged; existing business pause state preserved.')
