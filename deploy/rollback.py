"""Restore original containers, restart policies, cron and timers. Keeps current cloud files."""
import json,pathlib,subprocess
ROOT=pathlib.Path('/srv/drive-service');s=json.loads((ROOT/'deployment-state.json').read_text())
def run(*args,check=True,**kwargs):return subprocess.run(args,check=check,**kwargs)
# Stop the new writer first. No old data archive is automatically restored over newer uploads.
run('docker','stop','-t','30','drive-service',check=False)
old_exists=run('docker','inspect',s['old_nginx'],check=False,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
if old_exists:
    run('docker','stop','blogweb-nginx',check=False)
    run('docker','rm','blogweb-nginx',check=False)
    run('docker','rename',s['old_nginx'],'blogweb-nginx')
original=pathlib.Path(s['backup'])/'nginx.conf'
# Write in-place because the original nginx container bind-mounts this inode.
pathlib.Path('/root/blogweb/nginx/nginx.conf').write_bytes(original.read_bytes())
for name,info in s['containers'].items():
    policy=info['restart'];spec=policy['Name'] or 'no'
    if spec=='on-failure' and policy.get('MaximumRetryCount'):spec+=':'+str(policy['MaximumRetryCount'])
    run('docker','update','--restart='+spec,name)
for name in ['blogweb-mysql','blogweb-server','blogweb-client','blogweb-sadb','nnnuyy-api','shirone-blog','ai-video-app','blogweb-nginx']:
    if s['containers'][name]['running']:run('docker','start',name)
run('crontab','-',input=s['crontab'],text=True)
for name,info in s['timers'].items():
    if info['enabled']=='enabled':run('systemctl','enable',name)
    if info['active']=='active':run('systemctl','start',name)
run('docker','exec','blogweb-nginx','nginx','-t');run('docker','exec','blogweb-nginx','nginx','-s','reload')
(ROOT/'activated').unlink(missing_ok=True)
print('Restored original services and ingress. Current cloud-drive files are preserved.')
