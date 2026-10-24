"""Run on server to record deployment state without reading secret environment fields."""
import datetime,hashlib,json,pathlib,subprocess
ROOT=pathlib.Path('/srv/drive-service');s=json.loads((ROOT/'deployment-state.json').read_text());backup=pathlib.Path(s['backup']);data=pathlib.Path('/root/blogweb/clouddrive')
expected=json.loads((backup/'files-before.json').read_text());checked=[]
for item in expected:
    p=data/item['path'];digest=hashlib.sha256()
    with p.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):digest.update(block)
    assert digest.hexdigest()==item['sha256'] and p.stat().st_size==item['size'],item['path']
    checked.append(item['path'])
containers=json.loads(subprocess.check_output(['docker','inspect','drive-service','blogweb-nginx',*s['containers'].keys()-{'blogweb-nginx'},s['old_nginx']]))
states={x['Name'].lstrip('/'):{'running':x['State']['Running'],'restart':x['HostConfig']['RestartPolicy']['Name'],'health':x['State'].get('Health',{}).get('Status'),'memory_limit':x['HostConfig']['Memory']} for x in containers}
assert {k for k,v in states.items() if v['running']}=={'drive-service','blogweb-nginx'}
assert all(v['restart']=='no' for k,v in states.items() if k not in ['drive-service','blogweb-nginx'])
assert states['drive-service']['health']=='healthy'
subprocess.run(['gzip','-t',str(backup/'mysql.sql.gz')],check=True)
stats=__import__('os').statvfs(data)
result={'time':datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),'original_files_unchanged':checked,'backup_archive_verified':(backup/'archive-verified').exists(),'mysql_gzip_valid':True,'containers':states,'disk_free_bytes':stats.f_bavail*stats.f_frsize,'public_ports':subprocess.check_output(['ss','-lnt'],text=True),'root_crontab':subprocess.check_output(['crontab','-l'],text=True),'certificate':subprocess.check_output(['openssl','x509','-in','/etc/letsencrypt/live/drive.zhiii.top/fullchain.pem','-noout','-dates','-ext','subjectAltName'],text=True)}
(ROOT/'final-audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False,indent=2))
