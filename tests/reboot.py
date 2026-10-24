"""Explicit deployment acceptance: one server reboot with a persisted upload fixture."""
import hashlib,json,pathlib,sys,time,urllib.request
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'deploy'))
from remote import connect
BASE='https://drive.zhiii.top/api/clouddrive';CHUNK=16*1024**2
def request(method,url,data=None,raw=None):
    h={}
    if data is not None:raw=json.dumps(data).encode();h['Content-Type']='application/json'
    with urllib.request.urlopen(urllib.request.Request(url,data=raw,headers=h,method=method),timeout=60) as r:
        b=r.read()
        try:return json.loads(b)
        except (ValueError,UnicodeDecodeError):return b
name='_drive_reboot_'+str(time.time_ns())+'.bin';payload=b'R'*CHUNK+b'end'
s=request('POST',BASE+'/upload-session',dict(path='',name=name,size=len(payload),lastModified=123));id=s['id']
state_path=pathlib.Path(__file__).resolve().parents[1]/'artifacts/reboot-fixture.json';state_path.write_text(json.dumps(dict(id=id,name=name)))
request('PUT',BASE+f'/upload-session/{id}/chunk/0',raw=payload[:CHUNK]);c=connect()
_,out,_=c.exec_command('cat /proc/sys/kernel/random/boot_id');before=out.read().decode().strip()
print('Persisted first chunk; rebooting server.',flush=True)
c.exec_command('systemctl reboot');c.close();started=time.monotonic();after=before
time.sleep(5)
while time.monotonic()-started<240:
    try:
        with urllib.request.urlopen('https://drive.zhiii.top/healthz',timeout=3) as r:
            if r.status==200:
                c=connect();_,out,_=c.exec_command('cat /proc/sys/kernel/random/boot_id');after=out.read().decode().strip();c.close()
                if after!=before:break
    except Exception:pass
    time.sleep(2)
else:raise RuntimeError('Server did not recover within 240 seconds; fixture retained for manual recovery')
elapsed=time.monotonic()-started
status=request('GET',BASE+f'/upload-session/{id}');assert status['completed']==[0],status
request('PUT',BASE+f'/upload-session/{id}/chunk/1',raw=b'end');request('POST',BASE+f'/upload-session/{id}/complete')
download=request('GET',BASE+'/download?path='+name);assert hashlib.sha256(download).digest()==hashlib.sha256(payload).digest()
request('DELETE',BASE+'/remove?path='+name)
c=connect();_,out,_=c.exec_command("docker ps --format '{{.Names}}'; docker inspect shirone-blog blogweb-client blogweb-server nnnuyy-api blogweb-sadb blogweb-mysql ai-video-app --format '{{.Name}} {{.State.Running}} {{.HostConfig.RestartPolicy.Name}}'");services=out.read().decode();c.close()
assert all(line.endswith('false no') for line in services.splitlines()[2:]),services
assert set(services.splitlines()[:2])=={'drive-service','blogweb-nginx'},services
result={'boot_id_before':before,'boot_id_after':after,'observed_recovery_seconds':round(elapsed,2),'persisted_chunks':[0],'resumed_download_sha256':hashlib.sha256(download).hexdigest(),'services':services,'passed':True}
state_path.unlink();pathlib.Path(__file__).resolve().parents[1].joinpath('artifacts/reboot-results.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
