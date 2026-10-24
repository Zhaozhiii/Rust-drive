"""Run on server against old/new deployment. Creates and deletes only its own fixture directory."""
import concurrent.futures, hashlib, http.client, json, os, pathlib, statistics, subprocess, sys, threading, time, urllib.parse
port=int(sys.argv[1]);container=sys.argv[2];output=sys.argv[3];download_port=int(sys.argv[4]) if len(sys.argv)>4 else 80
host='www.zhiii.top'  # Same HTTP ingress/headers for both measurements.
name='_drive_benchmark_'+str(time.time_ns());base='/api/clouddrive';chunk=16*1024**2
pid=subprocess.check_output(['docker','inspect','-f','{{.State.Pid}}',container],text=True).strip()
cg=pathlib.Path('/sys/fs/cgroup')/pathlib.Path('/proc/'+pid+'/cgroup').read_text().split('::')[1].strip().lstrip('/')
samples=[];stop=threading.Event()
def memory():
    while not stop.wait(.02):
        try:
            stat=dict(line.split(':',1) for line in pathlib.Path('/proc/'+pid+'/status').read_text().splitlines() if ':' in line)
            ms=dict(line.split() for line in (cg/'memory.stat').read_text().splitlines())
            samples.append({'rss_kib':int(stat['VmRSS'].split()[0]),'working_set_bytes':int((cg/'memory.current').read_text())-int(ms.get('inactive_file',0))})
        except (OSError,KeyError):pass
def request(method,path,obj=None,data=None,download=False,headers=None):
    c=http.client.HTTPConnection('127.0.0.1',download_port if download else port,timeout=120)
    h=dict(headers or {},Host=host)
    if obj is not None:data=json.dumps(obj).encode();h['Content-Type']='application/json'
    c.request(method,path,data,h);r=c.getresponse();body=r.read();status=r.status;c.close()
    if not 200<=status<300:raise RuntimeError((status,body[:500]))
    if download:return body
    return json.loads(body)
def ticks():return sum(map(int,pathlib.Path('/proc/'+pid+'/stat').read_text().split()[13:15]))
monitor=threading.Thread(target=memory);monitor.start();time.sleep(.2)
idle=samples[-1] if samples else {};start_cpu=ticks();rounds=[]
request('POST',base+'/mkdir',{'name':name})
try:
    data=bytes(range(256))*(48*1024**2//256);digest=hashlib.sha256(data).hexdigest()
    for round in range(3):
        path=name+f'/fixture{round}.bin';t=time.perf_counter()
        session=request('POST',base+'/upload-session',{'path':name,'name':f'fixture{round}.bin','size':len(data),'lastModified':1});id=session['id']
        with concurrent.futures.ThreadPoolExecutor(3) as pool:
            list(pool.map(lambda i:request('PUT',f'{base}/upload-session/{id}/chunk/{i}',data=data[i*chunk:(i+1)*chunk]),range(3)))
        request('POST',f'{base}/upload-session/{id}/complete');upload=time.perf_counter()-t
        t=time.perf_counter();body=request('GET',base+'/download?path='+urllib.parse.quote(path),download=True);download=time.perf_counter()-t
        assert hashlib.sha256(body).hexdigest()==digest
        times=[]
        for _ in range(40):
            t=time.perf_counter();request('GET',base+'/list?path='+urllib.parse.quote(name));times.append((time.perf_counter()-t)*1000)
        rounds.append({'upload_mib_s':48/upload,'download_mib_s':48/download,'list_median_ms':statistics.median(times),'list_p95_ms':sorted(times)[37]})
        request('DELETE',base+'/remove?path='+urllib.parse.quote(path))
finally:
    request('DELETE',base+'/remove?path='+urllib.parse.quote(name));stop.set();monitor.join()
result={'container':container,'fixture_mib':48,'parallel_chunks':3,'rounds':rounds,'median':{k:statistics.median(r[k] for r in rounds) for k in rounds[0]},'idle':idle,'peak_rss_kib':max(s['rss_kib'] for s in samples),'peak_working_set_bytes':max(s['working_set_bytes'] for s in samples),'backend_cpu_seconds':(ticks()-start_cpu)/os.sysconf('SC_CLK_TCK')}
pathlib.Path(output).write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
